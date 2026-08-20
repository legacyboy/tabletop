/**
 * DM Session — the open-ended tabletop loop.
 *
 * This is the orchestrator at the heart of v2. It is provider-agnostic: callers
 * hand it a provider object exposing `.chat(messages)`, plus a scenario object.
 *
 * Per turn:
 *   1. The group types a FREE-FORM action (no preset options) and rolls a D20.
 *   2. The engine checks the scenario's fate_table: if the rolled number is
 *      listed, the authored twist FIRES and its state_delta is applied.
 *   3. The DM (LLM) is asked to adjudicate: it receives the action, the roll,
 *      the fate twist (if any), the scenario brief, and the current state. It
 *      returns (as strict JSON) a narrative of what happened + a proposed state
 *      update.
 *   4. State changes are clamped to [0,100]. End conditions are checked.
 *
 * The DM is explicitly instructed NOT to propose actions or lead the group —
 * it only reacts to what the group actually typed.
 */

const STATE_MIN = 0;
const STATE_MAX = 100;

// Hard cap on the TOTAL change to any single metric within one turn, across
// ALL delta sources (fate twist + pre-compiled events + DM judgment). Without
// this, a single turn could swing a metric by +30 (fate 10 + event 10 + DM 10)
// and snowball the session into a foregone loss. Keeps the arc believable.
const PER_TURN_MAX_CHANGE = 15;

const clamp = (v) => Math.max(STATE_MIN, Math.min(STATE_MAX, v));

/** Deep clone a JSON-safe object. */
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The discrete breach ladder the DM narrates as the attack chain progresses.
 * More legible to executives than an abstract number.
 */
const BREACH_STATES = ['contained', 'active', 'escalated', 'exfiltrated'];

/**
 * Build the session's live attack-chain state from a scenario's authored
 * `attack_chain` array. Each stage gets a `revealed` and `contained` flag
 * (both default false). The DM reveals a stage when the group's investigation
 * plausibly uncovers it, and marks it contained when the group neutralizes it.
 */
function initAttackChain(scenario) {
  const chain = Array.isArray(scenario.attack_chain) ? scenario.attack_chain : [];
  return chain.map((stage) => ({
    id: stage.id,
    name: stage.name,
    symptom: stage.symptom || '',
    revealed: !!stage.revealed,
    contained: false,
  }));
}

/**
 * Derive the current breach state from the attack chain. The breach escalates
 * as stages fire (are revealed but not yet contained) and de-escalates as
 * stages are contained. Falls back to 'active' when there is no chain.
 */
function deriveBreachState(chain) {
  if (!chain || chain.length === 0) return 'active';
  const revealed = chain.filter((s) => s.revealed);
  const contained = chain.filter((s) => s.contained);
  if (contained.length === chain.length) return 'contained';
  if (revealed.length === 0) return 'contained';
  // Escalation is driven by how many stages are out in the open and unresolved.
  const unresolved = revealed.length - contained.length;
  if (unresolved >= 3) return 'exfiltrated';
  if (unresolved >= 2) return 'escalated';
  return 'active';
}

/**
 * Build the DM's view of the attack chain: the hidden stages (name + symptom)
 * plus which are revealed and which are contained. This is fed to the DM each
 * turn so it can reveal/contain stages and narrate the breach.
 */
function chainBrief(chain) {
  if (!chain || chain.length === 0) return '(no attack chain)';
  return chain
    .map((s) => {
      const status = s.contained ? 'CONTAINED' : s.revealed ? 'REVEALED' : 'hidden';
      return `- [${s.id}] ${s.name} (${status}): ${s.symptom}`;
    })
    .join('\n');
}

/**
 * Build the system prompt that turns the LLM into THE DM for this scenario.
 * This is where the "don't lead, don't propose choices" rule lives.
 */
function buildSystemPrompt(scenario, opts = {}) {
  const brief = scenario.dm_brief || {};
  const actors = (brief.key_actors || [])
    .map((a) => `- ${a.name} (${a.role}): ${a.interests || ''} ${a.knowledge ? 'Knows: ' + a.knowledge : ''}`)
    .join('\n');
  const company = opts.companyInfo
    ? `\n\n## Public company information (from a live source)\n${opts.companyInfo}`
    : '';

  // RANDOM MODE: when the scenario is a generated shell (no pre-authored
  // content), the DM invents an appropriate executive scenario on the fly.
  const isRandom = scenario.scenario_id === 'random_generated' || opts.random === true;
  const randomBlock = isRandom
    ? [
        '',
        '## RANDOM MODE — GENERATE THE SCENARIO',
        'No pre-authored scenario is provided. You must generate an appropriate executive tabletop scenario on the fly.',
        'Choose a realistic executive scenario type (security incident, reputation/misinformation crisis, operational or financial disruption, regulatory matter, etc.).',
        'Invent: the opening scene (what the group observes), the stakes, the key actors, the tracked metrics and their opening values, the goal, and a hidden attack chain of 3-5 stages.',
        'Keep it EXECUTIVE-FOCUSED: describe the attack in plain language (e.g. "How they got in", "How it spread", "What they took") \u2014 NOT technical MITRE jargon.',
        'Use the BDB-style metric set where appropriate: budget, public_trust, regulator_confidence, security_posture, containment, eradication, recovery, attacker_progress.',
        'The win condition is to contain all attack-chain stages and restore the response metrics.',
        'Start the session by narrating the opening scene you invented, then adjudicate the group\u2019s actions against it.',
      ].join('\n')
    : '';

  return [
    'You are the dungeon master (facilitator) of an executive tabletop simulation.',
    `Scenario: ${scenario.title}.`,
    randomBlock,
    '',
    '## Your private briefing',
    `Situation: ${brief.situation || 'Not provided.'}`,
    `Stakes: ${brief.stakes || 'Not provided.'}`,
    `Key actors:\n${actors || '(none)'}`,
    `Pressure points you MAY inject if the group stalls:\n${(brief.pressure_points || []).map((p) => '- ' + p).join('\n') || '(none)'}`,
    `Pre-compiled events that fire on their own triggers (stall, stat threshold, or turn). When one fires, weave its text into the narrative and apply its state_delta:\n${(scenario.events || []).map((e) => '- [' + e.id + '] ' + e.text).join('\n') || '(none)'}`,
    `Rules of play:\n${(brief.rules_of_play || []).map((r) => '- ' + r).join('\n') || '(none)'}`,
    '',
    '## HOW TO PLAY (critical)',
    '- The group types a free-form action. Do NOT present them with a menu of options.',
    '- You must NEVER lead the group, propose actions, or steer them toward a choice. React only to what they actually did.',
    '- Judge the group\u2019s action fairly and realistically for this organization.',
    '- The D20 roll you receive reflects the action\u2019s outcome quality. Use it to decide if the action lands, partially succeeds, or backfires. 20 = outstanding success, 1 = severe failure, middle numbers = partial/ordinary.',
    '- Make the world respond concretely: consequences, reactions from actors/regulators/media, resource changes, new complications. Keep it tense and believable.',
    '- Keep narrative responses vivid but concise (roughly 2-5 sentences).',
    '',
    '## STATE',
    `Track these metrics between 0 and 100. Start from: ${JSON.stringify(scenario.opening_state)}.`,
    '- Change any single metric by AT MOST 10 points per turn (usually 1-6).',
    '- Do NOT max out or zero out metrics. Keep values in a believable mid-range so a 60-minute session has room to escalate and recover.',
    '- Only change metrics that the action genuinely affects; leave the rest unchanged.',
    '- A GOOD action on a GOOD roll (roughly 12+) should STABILIZE or IMPROVE the relevant metrics, not punish them. Do not keep dropping public_trust or other metrics every turn even when the group acts sensibly.',
    '- A bad roll (roughly 1-5) is where real damage happens. Reserve large negative deltas for genuinely bad outcomes, not for competent actions.',
    '- The session should be winnable: the group must be able to recover. Do not make it a foregone loss by turn 4-5.',
    '- Advance `attacker_progress` ONLY when the group fails, stalls, or takes a genuinely harmful action, or when a scripted event/fate twist calls for it. Do NOT raise attacker_progress every turn, and never on a good, competent action with a decent roll.',
    '',
    '## THE ATTACK CHAIN (kill chain)',
    'The scenario has a hidden, ordered attack chain. Each stage has a name and a symptom (what the group observes).',
    'Your job is to REVEAL a stage when the group\u2019s investigation plausibly uncovers it, and mark it CONTAINED when the group neutralizes it.',
    'The current chain state is fed to you each turn. Reveal stages gradually as the group investigates \u2014 do not dump the whole chain at once.',
    'The win condition is to contain ALL stages. The breach state (contained \u2192 active \u2192 escalated \u2192 exfiltrated) reflects how far the attack has gotten.',
    '',
    '## ROLL MODIFIERS (defender capabilities)',
    'The group may spend budget to "play" a defender capability (e.g. activate a monitoring playbook, escalate to the board, issue a public statement).',
    'When they do, the engine applies a +2/+3 modifier to their next D20 roll. The modifier nudges the roll \u2014 it does not replace your judgment.',
    'If a roll modifier is active, the turn will tell you the adjusted roll. Use it as a mild nudge toward success, but keep your judgment in the loop.',
    '',
    '## DETECTION AS A RESOURCE',
    'Investigation and response are limited. The group cannot do everything at once \u2014 enforce a realistic limit on how many distinct investigation/response actions they can take in a single turn, and make activating monitoring cost budget.',
    '',
    'Your reply must be STRICT JSON with exactly these fields:',
    '{"narrative": "<what happened, 2-5 sentences>", "state_delta": {"<metric>": <integer change>, ...}, "progress": true|false, "reveal_stage": "<stage id>|null", "contain_stage": "<stage id>|null"}',
    '"progress": true if the group\u2019s action meaningfully advanced the situation, false if they stalled, went in circles, or made no real progress. Blank/short actions are NOT automatically stalls \u2014 judge the substance of what they did.',
    '"reveal_stage": the id of an attack-chain stage the group just uncovered (or null). "contain_stage": the id of a stage the group just neutralized (or null).',
    'Only include metrics you actually changed. Return valid JSON and nothing else.',
  ].join('\n') + company;
}

/** Build the user turn for the DM. */
function buildUserTurn(scenario, run, action, roll, fate, firedEvents) {
  const fateLine = fate
    ? `The roll of ${roll} lands on a scripted fate event: "${fate.twist}". Weave this into the outcome.`
    : '';
  const eventLine = firedEvents && firedEvents.length
    ? `A pre-compiled event fires this turn: ${firedEvents.map((e) => `"${e.text}"`).join(' ')} Weave it into the outcome and apply its consequences.`
    : '';
  const modifierLine = run.rollModifier
    ? `A defender capability is active: the group spent budget to play it, granting a +${run.rollModifier} modifier. The adjusted roll is ${roll + run.rollModifier}. Treat this as a mild nudge toward success, but keep your judgment in the loop.`
    : '';
  const chainLine = run.attackChain && run.attackChain.length
    ? `\nCurrent attack chain:\n${chainBrief(run.attackChain)}\nCurrent breach state: ${run.breachState}`
    : '';

  return [
    `Turn ${run.turn + 1}. Current state: ${JSON.stringify(run.state)}`,
    chainLine ? chainLine : '',
    '',
    `The group has decided to do this: "${action}"`,
    `They rolled a D20 and got: ${roll}`,
    modifierLine ? modifierLine : '',
    fateLine ? fateLine : '',
    eventLine ? eventLine : '',
    '',
    'Adjudicate this action as the DM. Return the JSON judgment described in your instructions.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} provider  object with .chat(messages, opts)
 * @param {object} scenario  v2 scenario object
 */
export class DMSession {
  constructor(provider, scenario) {
    if (!provider || typeof provider.chat !== 'function') {
      throw new Error('DMSession requires a provider with .chat()');
    }
    this.provider = provider;
    this.scenario = scenario;
    this.companyInfo = null;  // optional enrichment appended to the DM brief
    this.random = false;       // random mode: DM generates the scenario on the fly

    this.state = clone(scenario.opening_state || {});
    this.turn = 0;
    this.history = [];   // transcript of turns for the closing report

    // Pre-compiled conditional events (v3 schema). Each fires at most once.
    this.events = Array.isArray(scenario.events) ? scenario.events : [];
    this.firedEvents = new Set();   // ids of events already fired this session
    this.stallCount = 0;             // consecutive turns the DM judged as no meaningful progress

    // BDB-inspired attack chain (kill chain). Each stage: {id, name, symptom,
    // revealed, contained}. The DM reveals/contains stages; the win condition
    // is to contain all of them.
    this.attackChain = initAttackChain(scenario);
    this.breachState = deriveBreachState(this.attackChain);

    // Roll modifier: a defender capability the group "played" (spent budget)
    // to nudge the next D20 roll. Persisted so it survives a restore.
    this.rollModifier = 0;

    // Consecutive-turn streaks for stat end conditions that require a stat to
    // stay at/below (or at/above) a threshold for N turns before failing.
    // Keyed by end-condition index; reset when the stat leaves the zone.
    this.statStreaks = {};

    // Timer
    this.startedAt = null;
    this.durationSeconds = this._durationFromEndConditions() || null;
    this.timerHandle = null;
    this.onTimerTick = null;
  }

  _durationFromEndConditions() {
    const t = (this.scenario.end_conditions || []).find((c) => c.type === 'timeout');
    return t ? t.duration_seconds : null;
  }

  start() {
    this.startedAt = Date.now();
    if (this.durationSeconds) {
      // Broadcast every second so the UI can render a countdown.
      this.timerHandle = setInterval(() => {
        if (this.onTimerTick) this.onTimerTick(this.secondsLeft());
      }, 1000);
    }
  }

  secondsLeft() {
    if (!this.startedAt || !this.durationSeconds) return null;
    return Math.max(0, this.durationSeconds - Math.floor((Date.now() - this.startedAt) / 1000));
  }

  /**
   * Resolve one turn: action text + roll -> narrative, state update, end check.
   * @returns {Promise<{narrative, state, event, endCondition, roll}>}
   */
  async takeTurn(action, roll) {
    if (!action || !action.trim()) throw new Error('Describe an action first.');
    if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error('D20 roll must be 1-20.');

    const fateKey = String(roll);
    const fate = this.scenario.fate_table ? this.scenario.fate_table[fateKey] : null;

    // Pre-chat: find stat/turn events that will fire this turn so they can be
    // woven into the DM's context. Stall events are judged AFTER the DM
    // reports progress, so they are evaluated below. Fired events are
    // tracked and never re-fire.
    const preFired = this._pendingStatTurnEvents();

    const system = buildSystemPrompt(this.scenario, { companyInfo: this.companyInfo, random: this.random });
    const user = buildUserTurn(this.scenario, this, action, roll, fate, preFired);

    const dmResult = await this.provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.8, maxTokens: 1500 }
    );

    const parsed = this._extractJson(dmResult);
    // Never let raw JSON leak to the player as the narrative. If extraction
    // produced no narrative and the raw reply still looks like a JSON object,
    // fall back to a safe generic line rather than showing the JSON fence.
    let narrative = parsed.narrative || dmResult;
    if (!parsed.narrative) {
      const looksLikeJson = /^[{\[]/.test(String(dmResult).trim()) || /^"[\s\S]*"$/.test(String(dmResult).trim());
      if (looksLikeJson) narrative = 'The situation developed. (The moderator narrative could not be parsed cleanly.)';
    }
    const delta = parsed.state_delta || {};

    // The DM judges whether the group made meaningful progress this turn.
    // A missing `progress` field defaults to progress (reset to 0) so a
    // missing field never falsely triggers a stall.
    this.stallCount = parsed.progress === false ? this.stallCount + 1 : 0;

    // The DM may reveal or contain an attack-chain stage this turn.
    this._applyChainJudgment(parsed);

    // Evaluate all pre-compiled events now that the stall counter reflects the
    // DM's judgment for this turn. Stat/turn events already fired above are
    // skipped (dedup); stall events fire here when the counter reaches N.
    const firedEvents = this._evaluateEvents(action);

    // Combine ALL delta sources for this turn (fate twist + fired events + DM
    // judgment) and apply them together with a hard per-turn total cap, so a
    // single turn can never swing a metric wildly and snowball the session.
    const combined = {};
    const merge = (d) => {
      for (const [k, v] of Object.entries(d || {})) {
        if (typeof v === 'number') combined[k] = (combined[k] || 0) + v;
      }
    };
    if (fate && fate.state_delta) merge(fate.state_delta);
    for (const ev of firedEvents) merge(ev.state_delta);
    merge(delta);
    this.state = this._applyDelta(this.state, combined);

    this.turn += 1;

    // A roll modifier is consumed by the roll it was granted for.
    this.rollModifier = 0;

    const event = {
      turn: this.turn,
      action,
      roll,
      fate: fate ? fate.twist : null,
      events: firedEvents.map((e) => e.id),
      narrative,
      state: clone(this.state),
      attack_chain: clone(this.attackChain),
      breach_state: this.breachState,
      ts: Date.now(),
    };
    this.history.push(event);

    const endCondition = this._checkEnd();
    return {
      narrative,
      event,
      state: clone(this.state),
      roll,
      attack_chain: clone(this.attackChain),
      breach_state: this.breachState,
      endCondition,
    };
  }

  /**
   * Apply the DM's attack-chain judgment for this turn: reveal a stage the
   * group uncovered, and/or contain a stage the group neutralized. Re-derives
   * the breach state after any change.
   */
  _applyChainJudgment(parsed) {
    let changed = false;
    if (parsed.reveal_stage) {
      const stage = this.attackChain.find((s) => s.id === parsed.reveal_stage);
      if (stage && !stage.revealed) {
        stage.revealed = true;
        changed = true;
      }
    }
    if (parsed.contain_stage) {
      const stage = this.attackChain.find((s) => s.id === parsed.contain_stage);
      if (stage && !stage.contained) {
        stage.contained = true;
        stage.revealed = true; // containing implies you found it
        changed = true;
      }
    }
    if (changed) this.breachState = deriveBreachState(this.attackChain);
  }

  /**
   * Find stat/turn events that will fire this turn (for weaving into the DM's
   * context BEFORE the DM adjudicates). Does NOT mutate firedEvents or apply
   * deltas; the authoritative evaluation happens in _evaluateEvents after the
   * DM's progress judgment. Stall events are excluded here because they depend
   * on the DM's per-turn judgment.
   */
  _pendingStatTurnEvents() {
    const pending = [];
    for (const ev of this.events) {
      if (this.firedEvents.has(ev.id)) continue;   // each event fires once
      const t = ev.trigger || {};
      let hit = false;
      if (t.type === 'stat') {
        const v = this.state[t.stat];
        if (typeof v === 'number') {
          if (t.operator === 'gte' && v >= t.value) hit = true;
          if (t.operator === 'lte' && v <= t.value) hit = true;
        }
      } else if (t.type === 'turn') {
        hit = this.turn + 1 === (t.turn || 0);
      }
      if (hit) pending.push(ev);
    }
    return pending;
  }

  /**
   * Evaluate the scenario's pre-compiled conditional events against the
   * current turn. Returns the list of events that fire (each at most once per
   * session). The stall counter is maintained by the DM's per-turn progress
   * judgment (see takeTurn), not by action text length.
   *
   * Trigger types:
   *   { type: 'stall', turns: N }  fires after N consecutive turns the DM
   *                                judged as no meaningful progress.
   *   { type: 'stat', stat, operator: 'gte'|'lte', value }  fires when the
   *                                stat crosses the threshold.
   *   { type: 'turn', turn: N }   fires on a specific turn number.
   */
  _evaluateEvents(action) {
    const fired = [];

    for (const ev of this.events) {
      if (this.firedEvents.has(ev.id)) continue;   // each event fires once
      const t = ev.trigger || {};
      let hit = false;
      if (t.type === 'stall') {
        hit = this.stallCount >= (t.turns || 1);
      } else if (t.type === 'stat') {
        const v = this.state[t.stat];
        if (typeof v === 'number') {
          if (t.operator === 'gte' && v >= t.value) hit = true;
          if (t.operator === 'lte' && v <= t.value) hit = true;
        }
      } else if (t.type === 'turn') {
        hit = this.turn + 1 === (t.turn || 0);
      }
      if (hit) {
        this.firedEvents.add(ev.id);
        fired.push(ev);
      }
    }
    return fired;
  }

  _applyDelta(state, delta) {
    const next = clone(state);
    for (const [k, v] of Object.entries(delta || {})) {
      if (typeof v !== 'number') continue;
      // Hard cap on the TOTAL per-turn change so a single turn can't swing a
      // metric wildly, even if the model over-reports or multiple delta
      // sources stack. Keeps the arc believable and prevents snowballing.
      const capped = Math.max(-PER_TURN_MAX_CHANGE, Math.min(PER_TURN_MAX_CHANGE, v));
      next[k] = clamp((next[k] || 0) + capped);
    }
    return next;
  }

  _checkEnd() {
    // Lose conditions: a stat crosses a failure threshold -> the scenario ends
    // badly. If the condition has a `consecutive` field, the stat must stay in
    // the failure zone for that many consecutive turns before it fires (so a
    // single bad turn doesn't end the session — the group gets a chance to
    // recover).
    const endConditions = this.scenario.end_conditions || [];
    for (let i = 0; i < endConditions.length; i++) {
      const c = endConditions[i];
      if (c.type !== 'stat') continue;
      const v = this.state[c.stat];
      if (typeof v !== 'number') continue;
      const inZone = (c.operator === 'lte' && v <= c.value) || (c.operator === 'gte' && v >= c.value);
      if (!inZone) {
        this.statStreaks[i] = 0;   // left the zone -> reset the streak
        continue;
      }
      const need = c.consecutive || 1;
      this.statStreaks[i] = (this.statStreaks[i] || 0) + 1;
      if (this.statStreaks[i] >= need) return { ...c, current: v, result: 'failure' };
    }

    // Goal (win condition): all goal thresholds met simultaneously -> the
    // group has achieved the objective, so the scenario ends successfully.
    const goal = this.scenario.goal;
    if (goal && Array.isArray(goal.win_conditions) && goal.win_conditions.length) {
      const allMet = goal.win_conditions.every((c) => {
        const v = this.state[c.stat];
        if (c.operator === 'lte') return v <= c.value;
        if (c.operator === 'gte') return v >= c.value;
        return false;
      });
      if (allMet) return { type: 'goal', result: 'success', ending: goal.ending, ...goal };
    }

    // Attack-chain win: if the scenario defines an attack_chain and the goal
    // references it (or the chain is the objective), containing ALL stages is a
    // success even if the numeric thresholds are not all met yet. This is the
    // BDB-style "contain all stages" win.
    if (this.attackChain.length && this.attackChain.every((s) => s.contained)) {
      const goal = this.scenario.goal;
      return {
        type: 'goal',
        result: 'success',
        ending: (goal && goal.ending) || 'All attack-chain stages contained. The exercise concludes.',
        ...(goal || {}),
        chain_contained: true,
      };
    }

    return null;
  }

  /**
   * Grant a roll modifier for the next D20 roll. Called when the group "plays"
   * a defender capability (spends budget). The modifier nudges the next roll;
   * it is consumed by that roll. Returns the new modifier value.
   * @param {number} amount  +2 or +3 (clamped to a sane range).
   */
  grantRollModifier(amount) {
    const n = Number(amount) || 0;
    this.rollModifier = Math.max(0, Math.min(5, n));
    return this.rollModifier;
  }

  /** Timeout end condition (called by the UI when the timer hits 0). */
  timeoutEnd() {
    const t = (this.scenario.end_conditions || []).find((c) => c.type === 'timeout');
    return t ? { ...t } : { ending: 'Time ran out on the scheduled exercise.' };
  }

  stopTimer() {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** Normalize a successfully-parsed DM object: unescape a narrative that the
   *  model double-escaped (e.g. "narrative": "\"The team...\"") or that is
   *  itself a JSON string or object. Never lets raw JSON structure leak. */
  _normalize(obj) {
    if (obj && typeof obj === 'object') {
      // The narrative may itself be a JSON object (e.g. {"narrative": {...}})
      // or a double-encoded JSON string. Recover the innermost prose.
      let n = obj.narrative;
      if (typeof n === 'object' && n !== null) {
        n = n.narrative;
      }
      if (typeof n === 'string') {
        const trimmed = n.trim();
        // Double-encoded: the narrative is itself a JSON string (starts with
        // a quote, brace, or bracket). Parse it down to prose.
        if (/^["{\[]/.test(trimmed)) {
          try {
            const inner = JSON.parse(trimmed);
            if (typeof inner === 'string') n = inner;
            else if (inner && typeof inner === 'object' && typeof inner.narrative === 'string') n = inner.narrative;
          } catch { /* fall through to escape-unescape */ }
        }
        // If the narrative still contains JSON escapes (\" or \n), unescape it.
        if (/\\["nrt\\]/.test(n)) {
          n = n
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\');
        }
        // Final guard: never let raw JSON structure leak into the narrative.
        obj.narrative = this._cleanNarrative(n);
      }
    }
    return obj;
  }

  /** Extract JSON from the raw DM reply, tolerating prose, markdown fences,
   *  and model-induced escaping issues in the narrative. */
  _extractJson(raw) {
    if (typeof raw !== 'string') return {};
    let s = raw.trim();

    // Strip markdown code fences (```json ... ```) which some models wrap
    // their JSON in. Without this, the fence breaks JSON.parse and the
    // structured output leaks into the narrative.
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    // Strategy 1: try the whole thing.
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') return this._normalize(obj);
    } catch {
      /* fall through */
    }

    // Strategy 2: try to find the first { ... } block.
    const open = s.indexOf('{');
    const close = s.lastIndexOf('}');
    if (open !== -1 && close > open) {
      try {
        const obj = JSON.parse(s.slice(open, close + 1));
        if (obj && typeof obj === 'object') return this._normalize(obj);
      } catch {
        /* fall through */
      }
    }

    // Strategy 3: models sometimes wrap the whole thing in ANOTHER layer of
    // quotes, or the narrative contains escapes (\"...\", literal \n) that
    // make the full object unparseable while state_delta itself is fine.
    // Pull out just the state_delta object as a fallback, and ALSO try to
    // recover the narrative (Strategy 4 logic) so we never return state_delta
    // alone and let the raw JSON leak into the play screen.
    const deltaMatch = s.match(/"state_delta"\s*:\s*(\{[\s\S]*?\})/);
    if (deltaMatch) {
      let delta = null;
      try {
        const d = JSON.parse(deltaMatch[1]);
        if (d && typeof d === 'object') delta = d;
      } catch {
        /* state_delta itself is malformed; ignore */
      }
      if (delta) {
        // Recover the narrative too (if present) so the play screen shows
        // prose, not the raw JSON object.
        const narrMatch = s.match(/"narrative"\s*:\s*"([\s\S]*?)(?:"|$)/);
        let narrative = null;
        if (narrMatch) {
          let n = narrMatch[1];
          try { n = JSON.parse('"' + n + '"'); }
          catch { n = n.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); }
          narrative = this._cleanNarrative(n.trim());
        }
        return narrative ? { narrative, state_delta: delta } : { state_delta: delta };
      }
    }

    // Strategy 4: truncated JSON. The model sometimes hits the token cap and
    // the reply is cut off mid-object, so the whole thing won't parse. Recover
    // the narrative string (the human-facing part) from the raw text so the
    // play screen shows prose instead of a raw ```json fence. We look for the
    // narrative value, strip surrounding quotes/escapes, and stop at the first
    // unescaped quote that closes it.
    const narrMatch = s.match(/"narrative"\s*:\s*"([\s\S]*?)(?:"|$)/);
    if (narrMatch) {
      let n = narrMatch[1];
      // Unescape JSON string escapes (\" -> ", \n -> newline, \\ -> \).
      try {
        n = JSON.parse('"' + n + '"');
      } catch {
        n = n.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      }
      if (n && n.trim()) return { narrative: this._cleanNarrative(n.trim()) };
    }

    // Strategy 5 (final safety net): the model returned something that is NOT
    // parseable JSON but still looks like a JSON object (starts with a brace/
    // bracket or is a quoted JSON string). Never let raw JSON structure leak
    // to the player — strip it down to the best prose we can find. If the raw
    // reply is already clean prose, return {} and let the caller use the raw
    // text as the narrative.
    if (/^[{\[]/.test(s) || /^"[\s\S]*"$/.test(s)) {
      const cleaned = this._cleanNarrative(s);
      if (cleaned && cleaned.trim()) return { narrative: cleaned.trim() };
    }

    return {};
  }

  /**
   * Final safety net: strip any residual JSON structure out of a narrative so
   * raw JSON never leaks to the player. Handles the case where the model
   * double-encodes the narrative (e.g. "narrative": "\"The CEO...\"") or
   * where a recovered narrative is still a JSON object. Returns clean prose,
   * or the input unchanged if it is already prose.
   */
  _cleanNarrative(text) {
    if (typeof text !== 'string' || !text) return text;
    let t = text.trim();

    // Only treat it as JSON to strip if it actually looks like a JSON object
    // (starts with a brace/bracket) or is a quoted JSON string. Plain prose
    // that merely mentions a key name is left untouched.
    const looksLikeJson = /^[{\[]/.test(t) || /^"[\s\S]*"$/.test(t);
    if (!looksLikeJson) return t;

    // If it is a JSON object, pull out the narrative value (recursively, in
    // case it is double-encoded) and return that.
    if (/^[{\[]/.test(t)) {
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object') {
          let n = obj.narrative;
          if (typeof n === 'object' && n !== null) n = n.narrative;
          // Double-encoded: the narrative is itself a JSON string.
          if (typeof n === 'string' && /^["{\[]/.test(n.trim())) {
            try { n = JSON.parse(n.trim()); } catch { /* keep as-is */ }
          }
          if (typeof n === 'string' && n.trim()) return n.trim();
        }
      } catch {
        /* fall through to regex extraction */
      }

      // Regex fallback: grab the narrative value, unescape it.
      const m = t.match(/"narrative"\s*:\s*"([\s\S]*?)(?:"|$)/);
      if (m) {
        let n = m[1];
        try { n = JSON.parse('"' + n + '"'); } catch { /* keep */ }
        if (n && n.trim()) return n.trim();
      }

      // Last resort: strip all JSON punctuation and keys to leave prose.
      return t
        .replace(/^[{\[]+/, '')
        .replace(/[}\]]+$/, '')
        .replace(/"(narrative|state_delta|reveal_stage|contain_stage|progress)"\s*:\s*/g, '')
        .replace(/[{}[\]"]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Quoted JSON string: unquote it.
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed.trim();
    } catch { /* keep as-is */ }
    return t;
  }

  /** Build the closing / audit report. */
  buildReport(endCondition) {
    const durationSec = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null;
    const minutes = durationSec ? Math.floor(durationSec / 60) : null;

    return {
      report_title: (this.scenario.report && this.scenario.report.title_note) || 'Tabletop Report',
      scenario: this.scenario.title,
      scenario_id: this.scenario.scenario_id,
      ending: endCondition ? endCondition.ending : null,
      turns: this.turn,
      duration_minutes: minutes,
      final_state: clone(this.state),
      log: clone(this.history),
      attack_chain: clone(this.attackChain),
      breach_state: this.breachState,
      audit_note: (this.scenario.report && this.scenario.report.audit_note) || '',
    };
  }

  /**
   * Serialize the session to a plain JSON-safe object (for persistence).
   * Does NOT include the provider (which may hold secrets) — the caller
   * stores provider config separately.
   */
  serialize() {
    return {
      scenario_id: this.scenario.scenario_id,
      state: clone(this.state),
      turn: this.turn,
      history: clone(this.history),
      startedAt: this.startedAt,
      durationSeconds: this.durationSeconds,
      ended: this.ended || false,
      ending: this.ending || null,
      firedEvents: Array.from(this.firedEvents),
      stallCount: this.stallCount,
      attackChain: clone(this.attackChain),
      breachState: this.breachState,
      rollModifier: this.rollModifier,
      statStreaks: clone(this.statStreaks),
    };
  }

  /**
   * Restore a session from a serialized snapshot + a fresh provider + the
   * scenario object. Rebuilds the live session state without re-running turns.
   */
  static restore(provider, scenario, snapshot) {
    const session = new DMSession(provider, scenario);
    session.state = clone(snapshot.state || scenario.opening_state || {});
    session.turn = snapshot.turn || 0;
    session.history = clone(snapshot.history || []);
    session.startedAt = snapshot.startedAt || null;
    session.durationSeconds = snapshot.durationSeconds ?? session.durationSeconds;
    session.ended = snapshot.ended || false;
    session.ending = snapshot.ending || null;
    session.firedEvents = new Set(snapshot.firedEvents || []);
    session.stallCount = snapshot.stallCount || 0;
    session.attackChain = clone(snapshot.attackChain || session.attackChain);
    session.breachState = snapshot.breachState || deriveBreachState(session.attackChain);
    session.rollModifier = snapshot.rollModifier || 0;
    session.statStreaks = clone(snapshot.statStreaks || {});
    return session;
  }
}

export { STATE_MIN, STATE_MAX };
