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

const clamp = (v) => Math.max(STATE_MIN, Math.min(STATE_MAX, v));

/** Deep clone a JSON-safe object. */
const clone = (o) => JSON.parse(JSON.stringify(o));

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

  return [
    'You are the dungeon master (facilitator) of an executive tabletop simulation.',
    `Scenario: ${scenario.title}.`,
    '',
    '## Your private briefing',
    `Situation: ${brief.situation || 'Not provided.'}`,
    `Stakes: ${brief.stakes || 'Not provided.'}`,
    `Key actors:\n${actors || '(none)'}`,
    `Pressure points you MAY inject if the group stalls:\n${(brief.pressure_points || []).map((p) => '- ' + p).join('\n') || '(none)'}`,
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
    'Your reply must be STRICT JSON with exactly these fields:',
    '{"narrative": "<what happened, 2-5 sentences>", "state_delta": {"<metric>": <integer change>, ...}}',
    'Only include metrics you actually changed. Return valid JSON and nothing else.',
  ].join('\n') + company;
}

/** Build the user turn for the DM. */
function buildUserTurn(scenario, run, action, roll, fate) {
  const fateLine = fate
    ? `The roll of ${roll} lands on a scripted fate event: "${fate.twist}". Weave this into the outcome.`
    : '';

  return [
    `Turn ${run.turn + 1}. Current state: ${JSON.stringify(run.state)}`,
    '',
    `The group has decided to do this: "${action}"`,
    `They rolled a D20 and got: ${roll}`,
    fateLine ? fateLine : '',
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

    this.state = clone(scenario.opening_state || {});
    this.turn = 0;
    this.history = [];   // transcript of turns for the closing report

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

    // Apply the fate twist's own state delta.
    if (fate && fate.state_delta) {
      this.state = this._applyDelta(this.state, fate.state_delta);
    }

    const system = buildSystemPrompt(this.scenario, { companyInfo: this.companyInfo });
    const user = buildUserTurn(this.scenario, this, action, roll, fate);

    const dmResult = await this.provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.8, maxTokens: 900 }
    );

    const parsed = this._extractJson(dmResult);
    const narrative = parsed.narrative || dmResult;
    const delta = parsed.state_delta || {};

    this.state = this._applyDelta(this.state, delta);
    this.turn += 1;

    const event = {
      turn: this.turn,
      action,
      roll,
      fate: fate ? fate.twist : null,
      narrative,
      state: clone(this.state),
      ts: Date.now(),
    };
    this.history.push(event);

    const endCondition = this._checkEnd();
    return {
      narrative,
      event,
      state: clone(this.state),
      roll,
      endCondition,
    };
  }

  _applyDelta(state, delta) {
    const next = clone(state);
    for (const [k, v] of Object.entries(delta || {})) {
      if (typeof v !== 'number') continue;
      // Hard cap on per-turn change so a single roll can't swing a metric
      // wildly, even if the model over-reports. Keeps the arc believable.
      const capped = Math.max(-10, Math.min(10, v));
      next[k] = clamp((next[k] || 0) + capped);
    }
    return next;
  }

  _checkEnd() {
    // Lose conditions: a stat crosses a failure threshold -> the scenario ends badly.
    for (const c of this.scenario.end_conditions || []) {
      if (c.type === 'stat') {
        const v = this.state[c.stat];
        if (c.operator === 'lte' && v <= c.value) return { ...c, current: v, result: 'failure' };
        if (c.operator === 'gte' && v >= c.value) return { ...c, current: v, result: 'failure' };
      }
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

    return null;
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
      if (obj && typeof obj === 'object') return obj;
    } catch {
      /* fall through */
    }

    // Strategy 2: try to find the first { ... } block.
    const open = s.indexOf('{');
    const close = s.lastIndexOf('}');
    if (open !== -1 && close > open) {
      try {
        const obj = JSON.parse(s.slice(open, close + 1));
        if (obj && typeof obj === 'object') return obj;
      } catch {
        /* fall through */
      }
    }

    // Strategy 3: models sometimes wrap the whole thing in ANOTHER layer of
    // quotes, or the narrative contains escapes (\"...\", literal \n) that
    // make the full object unparseable while state_delta itself is fine.
    // Pull out just the state_delta object as a fallback, since that's the
    // machine-critical part; the narrative can fall back to the raw text.
    const deltaMatch = s.match(/"state_delta"\s*:\s*(\{[\s\S]*?\})/);
    if (deltaMatch) {
      try {
        const delta = JSON.parse(deltaMatch[1]);
        if (delta && typeof delta === 'object') return { state_delta: delta };
      } catch {
        /* ignore */
      }
    }

    return {};
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
    return session;
  }
}

export { STATE_MIN, STATE_MAX };
