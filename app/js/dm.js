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
 * End conditions: the session ends on a STORY WIN — the narrative arc resolves
 * (the final story beat is reached, or the attack chain is fully contained) —
 * the timeout firing, or a manual end. The NARRATIVE COLLAPSE is NOT a terminal
 * loss (Dan's design, 2026-10-05): even when every metric is at 0 the group must
 * still be able to play the story to its resolution, so the collapse is in-story
 * pressure the DM narrates and it only downgrades the win quality (a fully
 * collapsed run that still resolves reads as the costliest win). A single bad
 * stat never ends the game either.
 *
 * NOTE on scoring (Dan's design, 2026-10-05): the numeric metrics are advisory
 * texture, NOT a win gate. A five-stat threshold AND-gate is brittle and turns
 * a story exercise into stat-grinding, so the win is narrative (see
 * _checkEnd / _winQuality). Metrics only colour how glorious versus how costly
 * the resolution reads.
 *
 * The DM is explicitly instructed NOT to propose actions or lead the group —
 * it only reacts to what the group actually typed.
 */

const STATE_MIN = 0;
const STATE_MAX = 100;

// Token budgets for DM calls.
//
// These were raised after real truncation reports (Dan, 2026-10-05): replies
// "started and stopped before the end of the paragraph". Root cause was the
// output budget, not the model. A complete, well-formed turn (4-7 sentence
// narrative + the strict-JSON envelope: state_delta, progress, reveal_stage,
// contain_stage, beat, beat_quality) measures ~700-1300 generated tokens on
// capable models, and reasoning models (e.g. glm-5.3) can burn thousands more
// on internal chain-of-thought BEFORE the answer. At the old 1200/1500 caps the
// model hit the ceiling mid-sentence and the app silently showed clipped prose
// (recovered by _extractJson Strategy 4).
//
// SCENE_TOKENS: opening scene (narrative only) - smaller envelope.
// TURN_TOKENS:  full turn - must fit thinking + narrative + JSON envelope.
const SCENE_TOKENS = 4096;
const TURN_TOKENS = 8192;
// Ollama context window. The DM system prompt alone is ~4.3k tokens, so a
// local model loaded at Ollama's default 4096 context silently clips the
// prompt (and at 8192 runs out of output room). 16384 gives full headroom.
const DM_NUM_CTX = 16384;

// Hard cap on the TOTAL change to any single metric within one turn, across
// ALL delta sources (fate twist + pre-compiled events + DM judgment). Without
// this, a single turn could swing a metric by +30 (fate 10 + event 10 + DM 10)
// and snowball the session into a foregone loss. Keeps the arc believable.
const PER_TURN_MAX_CHANGE = 15;

/**
 * How many consecutive turns the group may sit on one story beat, making real
 * progress, before the engine advances the arc on its own (Dan's design,
 * 2026-10-06: "progression should be linear" and must not drag). The DM
 * normally advances the beat itself; this is the safety net so the story
 * always moves. A genuine stall (the group did nothing) does not count.
 */
const BEAT_STALL_MAX = 2;
const HARD_STALL_MAX = 2;   // fail/stall turns before the arc is forced forward anyway

/**
 * A CRITICAL FAILURE fate kind. A natural 1 on the D20 is an ABSOLUTE failure
 * (Dan, 2026-10-08): whatever the group attempted, the turn goes wrong. The
 * engine enforces this structurally rather than trusting the DM to grade it:
 *
 *   - The arc NEVER advances on a critical failure. The DM may return `beat`
 *     anyway (it ignores the die far too often); we discard it. So a 1 can
 *     never reach the final beat, and therefore can never trigger the story
 *     win by resolving the arc.
 *   - The chain NEVER progresses on a critical failure: any `contain_stage`
 *     the DM reports is discarded (a crit fail does not neutralize anything).
 *   - The group never makes `progress` on a critical failure.
 *   - The DM must NOT be allowed to narrate a crit fail as a win. We rewrite
 *     the fate line so the die is authoritative, and we FORCE the narrative to
 *     an authored critical-failure outcome when the DM's prose reads as a
 *     success ("lands exactly as intended", "works", "pays off", etc.).
 *
 * This is the fix for the bug Dan hit on 2026-10-08: a roll of 1 was completing
 * the game because the DM advanced the arc off the back of a 1.
 */
const CRIT_FAIL_RES = [/\blands?\b[^.]*\bintended\b/i, /\bworks?\b/i, /\bpay(s|ed)\s+off\b/i, /\bsucce(ss|eds|edful)\b/i, /\bas\s+intended\b/i, /\bcomes?\s+together\b/i, /\boutsmarts?\b/i, /\bwins?\b[^.]*\bthe\s+day\b/i];
const CRIT_FAIL_FALLBACK =
  'The attempt collapses in the worst possible way. Whatever the group put into '
  + 'motion backfires hard: the move is mis-timed, misunderstood, or actively '
  + 'turned against them, and the situation is now materially worse than it was '
  + 'before they acted. Damage is real, trust and standing take a hit, and there '
  + 'is no partial credit \u2014 the group must recover from a genuine setback before '
  + 'it can move forward again.';

/**
 * Fallback critical-failure consequence, applied ONLY when the scenario's own
 * fate_table has no authored delta for the natural 1. Kept modest and clamped
 * by PER_TURN_MAX_CHANGE so it can never nuke the whole session on one roll.
 */
const CRIT_FAIL_FALLBACK_DELTA = { public_trust: -8, containment: -4 };

/**
 * Default NARRATIVE-LOSS condition, used when a scenario defines no stat-based
 * loss in its end_conditions. The old "attacker progress" counter is gone:
 * failure is now narrated. The story has collapsed when BOTH public_trust AND
 * regulator_confidence sit at/below 20 for 2 consecutive turns — the group
 * has failed badly, the DM has narrated the strain, and the session concludes
 * as a loss with the collapse ending below.
 */
const DEFAULT_LOSS_CONDITION = {
  type: 'stat',
  result: 'loss',
  stats: [
    { stat: 'public_trust', operator: 'lte', value: 20 },
    { stat: 'regulator_confidence', operator: 'lte', value: 20 },
  ],
  consecutive: 2,
  ending:
    'The collapse is complete: the public has stopped believing a word the ' +
    'organization says, the regulator has escalated from questions to ' +
    'extraordinary measures, and the board has lost faith in the executive ' +
    "team. The story ends badly. The exercise concludes as a loss.",
};

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
 * Resolve the turn budget for a scenario.
 *
 * A scenario may declare `pacing: { target_turns, total_turns }`. Otherwise the
 * budget is derived from the wall-clock timeout: with a sub-60-minute exercise
 * and ~8 minutes per turn (intro + discussion + decision), an hour supports
 * roughly 7 turns; the arc should resolve around 5-6 so the group has room to
 * discuss the ending rather than hitting the clock. `targetTurns` is the "on
 * pace" mark; `totalTurns` is the ceiling past which the run is overlong.
 *
 * @returns {{targetTurn:number, totalTurn:number}}
 */
function resolvePacing(scenario) {
  const p = (scenario && scenario.pacing) || {};
  const t = (scenario && scenario.end_conditions || []).find((c) => c.type === 'timeout');
  const durationMin = t && t.duration_seconds ? t.duration_seconds / 60 : 60;
  const perTurn = p.minutes_per_turn || 8;
  const total = p.total_turns || Math.max(4, Math.floor(durationMin / perTurn));
  // ARC-FIRST PACING (Dan, 2026-10-07): the group finishes when the ARC finishes,
  // so the real budget is driven by the number of story beats, not the clock.
  // With one beat per turn plus an opening/decision turn, a 4-5 beat arc lands at
  // 5-6 turns — the target Dan wants. Clamp to the clock ceiling so a very short
  // time limit still wins.
  const beats = (scenario && scenario.beats || []).length;
  const arcTarget = beats > 0 ? beats + 1 : null;   // +1 for the opening/decision turn
  const target = p.target_turns || (arcTarget ? Math.min(total, Math.max(3, arcTarget)) : Math.min(total, Math.max(3, Math.round(total - 1))));
  return { targetTurn: target, totalTurn: total };
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
  const cast = opts.castInfo
    ? `\n\n${opts.castInfo}`
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
        'Invent: the opening scene (what the group observes), the stakes, the key actors, the tracked metrics and their opening values, the goal, an ordered 3-step story arc (beats), and a hidden attack chain of 3-5 stages.',
        'Keep it EXECUTIVE-FOCUSED: describe the attack in plain language (e.g. "How they got in", "How it spread", "What they took") \u2014 NOT technical MITRE jargon.',
        'Use the BDB-style metric set where appropriate: budget, public_trust, regulator_confidence, security_posture, containment, eradication, recovery.',,
        'The WIN is a STORY win, not a score gate: the exercise resolves when the group works through the final beat of the arc OR contains every attack-chain stage (whichever fits). The metrics are texture that colours how costly the win reads \u2014 they do NOT gate victory. Invent a goal whose `ending` describes that story resolution.',
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
    '- The group decides how much to attempt; they are NEVER capped. A turn might be one focused move or several moves across departments \u2014 that is their call. Your job is to adjudicate whatever they actually did, honestly and in proportion.',
    '- NEVER present a menu or list of choices, and do not prescribe a specific next action. But DO advance the world: every turn should move the situation forward into its next natural beat.',
    '- KEEP THE MOMENTUM. A turn must NOT end as a flat dead end. The group acted; the world reacts AND moves on. End each response by introducing a NEW DEVELOPMENT: new information, a reaction from an actor/regulator/media, a complication that sharpens the situation. Leave the group facing something concrete.',
    '- A NEW DEVELOPMENT must NOT re-punish a metric the group just competently addressed. If the group issued a clear public statement, do NOT invent a fresh "internal leak" or "confused staff reply" that undercuts it the same turn. Escalation is for when the group FAILS, stalls, or rolls badly (1-5) — not as a reward for good play. Vary the development; never repeat the same setback (e.g. the same leaked screenshot) turn after turn.',
    '- ADVANCE WITH EVENTS, NEVER DIRECTIVES. Do not frame your response as "the team needs to...", "the group should...", "it may be wise to...", "consider...", or "the next step is to...". Those lead the group. Instead, the world itself moves: a reporter publishes a follow-up, a deadline lands, a new screenshot surfaces, a regulator sharpens its demand, a complication emerges. You present the NEW SITUATION, never instructions on how to handle it.',
    '- Distinguish leading from world-driving: proposing options, prescribing an action, or telling them what to do is FORBIDDEN; having the situation actively develop and push back is REQUIRED.',
    '- NEVER RETURN A NO-OP NARRATIVE. The narrative MUST concretely respond to the group\u2019s action: acknowledge and address each coordinated action they took and its immediate consequence. It MUST introduce at least one NEW, concrete development (new information, an actor/regulator/media reaction, a complication, a deadline) that leaves the group facing something specific to react to. Every turn the world must measurably move forward or sideways.',
    '- A no-op narrative is FORBIDDEN. The response must NEVER say or imply that "nothing happened", "nothing responded", "the situation is unchanged", "the story continues", "no immediate development/response", "they are still waiting", "didn\u2019t do anything", or any equivalent. If the group did something (anything), the world MUST react to it concretely. Reacting to the action and developing the world with EVENTS is REQUIRED and is NOT the same as prescribing/directing the next action (which stays forbidden).',
    '- Judge the group\u2019s actions fairly and realistically for this organization. Address each of the coordinated actions in your response.',
    '- The D20 roll you receive reflects the overall outcome quality of the turn. Every roll 1-20 carries SCRIPTED guidance, which you are given each turn. Treat that guidance as the AUTHORITATIVE outcome of the die: weave it into the narrative, and align the tone and the size of the metric change with it (1-5 = the turn goes badly, 6-8 = mixed/partial, 9-14 = a good outcome, 15-19 = strong, 20 = outstanding). Your judgment shapes HOW it plays out and what follows, not WHETHER the die succeeded. Only rolls 1, 5, 11 and 20 are FRAMED as dramatic fate events in the fiction (a disaster, a hard failure, a lucky break, or a triumph); treat every other roll as an ordinary turn that simply resolves well, badly, or in between — do not make every turn feel like a scripted set-piece.',
    '- CRITICAL FAILURE — a NATURAL 1 is special and ABSOLUTE. On a roll of 1, the turn FAILS no matter how clever, well-resourced, or well-described the group\'s action was. You MUST: return "beat": null (do NOT resolve or advance the story beat), return "contain_stage": null (do NOT neutralise any attack-chain stage), return "progress": false, and narrate a genuine, costly SETBACK — the move backfires, misfires, or is turned against them and the situation is now worse. NEVER narrate a 1 as a success: no "lands as intended", "works", "pays off", "comes together", or similar. A 1 must never be the turn that wins or advances the exercise. The engine enforces this too — if you narrate a success on a 1, it will be overwritten.',
    '- Make the world respond concretely: consequences, reactions from actors/regulators/media, resource changes, new complications. Keep it tense and believable.',
    '- Narrative responses should be vivid and forward-driving, roughly 4-7 sentences: what happened, the consequences, AND what now presses on the group as the story moves to its next step.',
    '',
    '## STATE',
    `Track these metrics between 0 and 100. Start from: ${JSON.stringify(scenario.opening_state)}.`,
    '- Change any single metric by AT MOST 10 points per turn (usually 1-6).',
    '- Do NOT max out or zero out metrics. Keep values in a believable mid-range so a 60-minute session has room to escalate and recover.',
    '- Only change metrics that the action genuinely affects; leave the rest unchanged.',
    '- A GOOD action on a GOOD fate (roughly 9+) should STABILIZE or IMPROVE the relevant metrics, not punish them. Do not keep dropping public_trust or other metrics every turn even when the group acts sensibly. When the group does the right things (clear statement, takedown, regulator package, member outreach), public_trust and regulator_confidence should RECOVER — not keep sliding. Trust should not decline monotonically turn after turn on competent play; give the group visible recovery so the session is winnable.',
    '- The metrics are NARRATIVE TEXTURE, not a scoreboard. They colour how the story reads (a clean win versus a costly one) and how the world reacts. They are NOT a pass/fail gate — a session is won by resolving the STORY (see THE WIN CONDITION below), not by pushing numbers over a line.',
    '- A bad fate (rolls 1-5) is where real damage happens, and only there. Rolls 6-8 are MIXED: a small, honest partial result, neither a windfall nor a disaster. Never treat a mid roll as a failure. Reserve large negative deltas for the 1-5 band, not for competent actions.',
    '- The session should be winnable: the group must be able to recover. Do not make it a foregone loss by turn 4-5.',
    '- The complete response arc is CONTAIN \u2192 ERADICATE \u2192 RECOVER. A group that only does public relations and containment but never eradicates the root cause or restores operations should keep struggling — the story keeps biting, the regulator stays unsatisfied — until it closes out the full arc. Reflect this in outcomes: eradication and recovery efforts should be rewarded when the group attempts them.',
    '- THE NARRATIVE COLLAPSE (in-story pressure, NOT a game over): if the situation has GENUINELY collapsed — public_trust AND regulator_confidence both critically low (20 or below) — do NOT soften the world: narrate the strain realistically (members lose faith, the regulator escalates, the board wavers). BUT the session does NOT end here. Even with every metric at 0, the group must still be able to play the STORY to its resolution. Keep the situation grim and costly, yet leave a plausible path to resolving the arc/containing the threat \u2014 a comeback won against the odds is the costliest, most memorable win. Never refuse the resolution just because the numbers are bad.',
    '',
    '## THE ATTACK CHAIN (kill chain)',
    'The scenario has a hidden, ordered attack chain. Each stage has a name and a symptom (what the group observes).',
    'Your job is to REVEAL a stage when the group\u2019s investigation plausibly uncovers it, and mark it CONTAINED when the group neutralizes it.',
    'Be GENEROUS with containment: when the group takes a genuine, on-target action against a stage, mark it contained. You do not need to wait for a perfect, total fix \u2014 a real step that neutralizes the stage\u2019s effect counts. A stage the group clearly dealt with should NOT be left open just because the story is wrapping up.',
    'The current chain state is fed to you each turn. Reveal stages gradually as the group investigates \u2014 do not dump the whole chain at once.',
    'The breach state (contained \u2192 active \u2192 escalated \u2192 exfiltrated) reflects how far the attack has gotten. Containing a stage is good progress, but you do NOT need every stage contained: the story can resolve with stages still open.',
    '',
    '## THE WIN CONDITION (a story win, not a score gate)',
    'The exercise is WON by resolving the STORY, not by reaching a numeric score. The arc is the SPINE; the attack chain is texture. The story resolves when EITHER:',
    '  (a) the group reaches the FINAL story BEAT \u2014 the arc plays out to its conclusion. This ALONE is a win, even if some attack-chain stages are still open, OR',
    '  (b) every stage of the attack chain is contained (the threat is fully neutralized).',
    'PROGRESSION IS LINEAR: the group wins by working the arc to the end. Containing the chain is a second, alternative way to resolve, not an extra hoop. MISSING SOMETHING IS ALLOWED \u2014 do NOT withhold the final beat because a chain stage was left open or a metric is low. Let the arc complete; what was left open simply makes the ending read as costlier (the engine scores that).',
    'Do NOT hold the win hostage to the metrics. A group that resolves the story with ragged numbers still WINS \u2014 it just reads as a costlier, harder-won victory. A group that grinds the numbers up without resolving the story has NOT won; the story keeps biting.',
    '',
    '## ROLL MODIFIERS (defender capabilities)',
    'The group may spend budget to "play" a defender capability (e.g. activate a monitoring playbook, escalate to the board, issue a public statement).',
    'When they do, the engine applies a +2/+3 modifier to their next D20 roll. The modifier nudges the roll \u2014 it does not replace your judgment.',
    'If a roll modifier is active, the turn will tell you the adjusted roll. Use it as a mild nudge toward success, but keep your judgment in the loop.',
    '',
    '## DETECTION AS A RESOURCE',
    'Investigation and response are limited. The group cannot do everything at once \u2014 enforce a realistic limit on how many distinct investigation/response actions they can take in a single turn, and make activating monitoring cost budget.',
    '',
    '## THE STORY BEATS (arc progression)',
    'The scenario is an ordered arc of beats (steps). You are told which beat the group is in and the arc you are running.',
    'A beat is a stage of the story (e.g. Step 1 public response, Step 2 regulator + fraud, Step 3 eradicate + recover). The group works through beats LINEARLY, in order. Each beat is a step forward \u2014 never hold the group in the same beat turn after turn.',
    'ARC LENGTH (Dan, 2026-10-07): the arc has 4-5 beats and the session should run about 5-6 turns (plus the opening). That means roughly ONE BEAT PER TURN \u2014 but do NOT rush: a beat the group handles with a single shallow or partial action should take a second turn to truly close out before the story moves on. A strong, decisive action resolves a beat in one turn; a weak or partial one leaves it open another turn. The goal is 5-6 turns of story, not a 3-turn sprint.',
    'Each turn, decide whether the group has RESOLVED the current beat. A beat is resolved when the group\u2019s actions genuinely close out that stage of the story (not just talk \u2014 the situation at that beat is handled and the story must move on). Be GENEROUS here: if the group made a real, on-target effort at the current beat, treat it as resolved and move on. A beat should normally take no more than ONE turn \u2014 ADVANCE THE ARC EVERY TURN OR TWO. Do not park in Step 1.',
    'When the current beat is resolved, return the NEXT beat\u2019s id in the `beat` field and narrate the transition: how the group\u2019s handling shaped the incoming step. A group that handled the beat WELL should find the next step softer; one that handled it POORLY should find it worse. A single decisive action can skip forward to a later beat when the story warrants it.',
    'Do NOT gate the arc on containment or metrics. Reaching the FINAL beat is itself the resolution \u2014 complete the arc even if a chain stage was missed or a metric is low. Never return `beat: null` to stall the group in the same step more than one turn unless they truly did nothing. EXCEPTION: on a NATURAL 1 you must ALWAYS return `beat: null` \u2014 a critical failure never advances the arc.',
    'Report how the group handled the beat they just completed in `beat_quality`: "good" (strong, on-target), "mixed" (partial, messy), or "poor" (failed, backfired). The engine carries this into the next turn so you can adjust the tone of the incoming beat accordingly.',
    'If the scenario has no beats, ignore this section and simply keep the story advancing turn to turn as described in HOW TO PLAY.',
    '',
    '## SESSION LENGTH (sub-60 minutes)',
    'The whole exercise must start AND finish inside 60 minutes. With intro, discussion, and decisions, players take roughly 7-10 minutes per turn, so the session can support only about 6-8 turns total. Pace the arc to reach resolution well inside that budget \u2014 a tabletop exercise needs enough turns to get interesting, not a sprint to the exit.',
    '- Drive the story toward its RESOLUTION in about 5-6 turns \u2014 the final beat reached (or the attack chain fully contained). Target 5-6: a run that resolves in 3-4 turns is too abrupt, so let the situation develop before the group closes it out. Do not pad past 7 or drag the session over the hour either.',
    '- USE THE PACE BRIEF. Each turn you are told the current turn number, the target resolution turn, how many beats remain, and how many minutes are left on the clock, plus a pacing verdict. The verdict is a DECISION, not decoration \u2014 it tells you how hard this turn should push. Follow it: SPEED UP = advance the arc now and cut a complication; KEEP IT PROPORTIONATE / BREATHE = do NOT pile on, mirror the group\u2019s effort with a measured response; ON THE FINAL BEAT = resolve the story this turn.',
    '- ADVANCE THE ARC EVERY TURN OR TWO. If the group is still on the same beat they were on last turn, move them forward unless they genuinely did nothing. Do NOT re-run Step 1 three or four times.',
    '- Let a decisive, competent action resolve more than one thing at once (e.g. one strong turn can contain a stage AND recover trust AND move to the next beat). Prefer meaningful forward progress over prolonging a beat.',
    '- MATCH THE RESPONSE TO THE ACTION. The size of the world\u2019s reaction should be proportional to what the group actually did this turn. If they took ONE action, respond with ONE proportionate development \u2014 do NOT answer a single move with a whole cascade of setbacks. A one-action turn early in the session, with time and turns to spare, should get a measured, single reaction that leaves room to breathe; only escalate into a multi-front storm as the clock runs down, the situation is already critical, or the group actually tried to do many things at once. Restraint early is what makes later escalation feel earned rather than arbitrary.',
    '- If the group resolves the story early, the session ends then — do not invent extra conflict to fill time.',
    '',
    'Your reply must be STRICT JSON with exactly these fields:',
    '{"narrative": "<what happened, 2-7 sentences, ending on the next development that presses the group>", "state_delta": {"<metric>": <integer change>, ...}, "progress": true|false, "reveal_stage": "<stage id>|null", "contain_stage": "<stage id>|null", "beat": "<next beat id>|null", "beat_quality": "good|mixed|poor|\"\""}',
    '"progress": true if the group\u2019s action meaningfully advanced the situation, false if they stalled, went in circles, or made no real progress. Blank/short actions are NOT automatically stalls \u2014 judge the substance of what they did. On a NATURAL 1, `progress` is ALWAYS false.',
    '"reveal_stage": the id of an attack-chain stage the group just uncovered (or null). "contain_stage": the id of a stage the group just neutralized (or null).',
    '"beat": when the current beat is resolved, the id of the beat the story now moves to (next in the arc, or a later id if the group skipped ahead). null to stay in the current beat.',
    '"beat_quality": how the group handled the beat they just completed ("good", "mixed", "poor"). Only meaningful when a beat just ended; otherwise omit or null.',
    'Only include metrics you actually changed. Return valid JSON and nothing else.',
  ].join('\n') + cast;
}

/**
 * A fate roll is "notable" (worth announcing as a FATE EVENT) only on the four
 * dramatic faces Dan picked (2026-10-07): two NEGATIVE — the crit fail (1) and
 * the fail (5) — and two POSITIVE — the lucky-break twist (11) and the crit
 * success (20). Every other roll still carries scripted guidance, but it is
 * woven in as the ordinary outcome of the turn, not flagged as an event.
 */
export function isNotableFate(roll) {
  const r = Number(roll);
  return r === 1 || r === 5 || r === 11 || r === 20;
}

/** Build the user turn for the DM. */
function buildUserTurn(scenario, run, action, roll, fate, firedEvents) {
  const critFail = Number(roll) === 1;
  const fateLine = critFail
    ? 'CRITICAL FAILURE \u2014 the roll is a natural 1. This is an ABSOLUTE failure regardless of how good the action looked or how much the group put into it. The attempt goes wrong: it backfires, misfires, is mis-timed or turned against them, and leaves the situation materially WORSE. MANDATORY RULES for a natural 1: (a) do NOT resolve or advance the current story beat \u2014 return "beat": null; (b) do NOT mark any attack-chain stage contained \u2014 return "contain_stage": null; (c) return "progress": false; (d) do NOT narrate a success \u2014 no outcome \u201cthat lands as intended,\u201d \u201cworks,\u201d or \u201cpays off\u201d; the group does NOT win this turn. Narrate real, costly damage.'
    : (fate
    ? (isNotableFate(roll)
        ? `The roll of ${roll} lands on a scripted fate event: "${fate.twist}". Weave this into the outcome. FRAMING: if this is a POSITIVE event (11 or 20) but the group\'s action this turn was weak, empty, or off-target, narrate the good turn as EXTERNAL LUCK that arrives despite them \u2014 a journalist happens to find the trail, an ally steps up, a platform acts on its own \u2014 NOT as the group\'s competence. Never let a lucky positive fate read as the group outplaying their own action; it is the world throwing them a break. If this is a NEGATIVE event (1 or 5), let it bite regardless of how well they played \u2014 that is the tension.`
        : `The roll of ${roll} resolves ordinarily. Guidance for this outcome (do not announce it as a special event; just let it read as the natural result): "${fate.twist}".`)
    : '');
  const eventLine = firedEvents && firedEvents.length
    ? `A pre-compiled event fires this turn: ${firedEvents.map((e) => `"${e.text}"`).join(' ')} Weave it into the outcome and apply its consequences.`
    : '';
  const modifierLine = run.rollModifier
    ? `A defender capability is active: the group spent budget to play it, granting a +${run.rollModifier} modifier. The adjusted roll is ${roll + run.rollModifier}. Treat this as a mild nudge toward success, but keep your judgment in the loop.`
    : '';
  const chainLine = run.attackChain && run.attackChain.length
    ? `\nCurrent attack chain:\n${chainBrief(run.attackChain)}\nCurrent breach state: ${run.breachState}`
    : '';

  // Story beats: where the group is in the arc and how the last beat went.
  const beats = run.beats;
  let beatLine = '';
  if (beats && beats.length) {
    const cur = beats[run.currentBeatIndex];
    if (cur) {
      beatLine = `\nSTORY BEAT ${run.currentBeatIndex + 1} of ${beats.length} (${cur.name}): ${cur.narrative}`;
      if (run.lastBeatQuality) {
        beatLine += `\nHow the group handled the previous beat: ${run.lastBeatQuality}. Adjust the tone of this beat accordingly (good -> softer, poor -> harsher, mixed -> uneven).`;
      }
      // Dan (2026-10-07): more story steps that inject as the story moves. Each
      // beat can carry `developments` — a short mid-beat twist that fires on the
      // group's SECOND turn in the beat, so a beat is not closed out in a single
      // turn and the arc reaches 5-6 turns through real story, not padding.
      const dev = run._devThisTurn || (run._pendingDevelopment ? run._pendingDevelopment() : null);
      if (dev) {
        beatLine += `\nMID-BEAT DEVELOPMENT (fires this turn): "${dev.text}". Work this new twist into the scene \u2014 it is a fresh complication or revelation WITHIN this beat, so it keeps the beat alive and gives the group something concrete to respond to before the story moves on.${dev.state_delta ? ` Apply its consequences: ${JSON.stringify(dev.state_delta)}.` : ''}`;
      }
    }
  }

  // PACE: tell the DM exactly what turn it is, how much wall-clock time is left,
  // and whether the group is on pace for the arc. Without this the DM has no
  // sense of turn count or elapsed time and guesses, which is why runs drifted.
  // Also gives the engine a place to carry the auto-advance note to the DM.
  const paceLine = typeof run._paceBrief === 'function' ? run._paceBrief() : '';

  return [
    `Turn ${run.turn + 1}. Current state: ${JSON.stringify(run.state)}`,
    chainLine ? chainLine : '',
    beatLine ? beatLine : '',
    paceLine ? paceLine : '',
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
    this.castInfo = '';  // optional cast block appended to the DM brief
    this.random = false;       // random mode: DM generates the scenario on the fly

    this.state = clone(scenario.opening_state || {});
    this.turn = 0;
    this.history = [];   // transcript of turns for the closing report

    // PACING BUDGET (Dan, 2026-10-07). A session must start AND finish inside its
    // time limit, so the DM needs to know the turn budget to pace the arc. Two
    // numbers are resolved once, at construction:
    //   targetTurn  - the turn by which the arc SHOULD resolve (the "on pace" mark)
    //   totalTurn   - the hard turn ceiling (past which the session is overlong)
    // A scenario may override via `pacing: { target_turns, total_turns }`; otherwise
    // they are derived from the wall-clock limit at ~7-10 min/turn, the same
    // assumption the DM prompt already uses.
    const p = resolvePacing(scenario);
    this.targetTurn = p.targetTurn;
    this.totalTurn = p.totalTurn;
    // Note from the engine's own arc auto-advance (BEAT_STALL_MAX guard), consumed
    // by _paceBrief() on the next turn so the DM knows why the arc moved.
    this._paceNote = '';

    // Pre-compiled conditional events (v3 schema). Each fires at most once.
    this.events = Array.isArray(scenario.events) ? scenario.events : [];
    this.firedEvents = new Set();   // ids of events already fired this session
    this.stallCount = 0;             // consecutive turns the DM judged as no meaningful progress

    // BDB-inspired attack chain (kill chain). Each stage: {id, name, symptom,
    // revealed, contained}. The DM reveals/contains stages; the win condition
    // is to contain all of them.
    this.attackChain = initAttackChain(scenario);
    this.breachState = deriveBreachState(this.attackChain);

    // Story beats (optional arc). Each beat: {id, name, narrative}. The DM
    // advances the current beat when the group resolves it (see takeTurn).
    this.beats = Array.isArray(scenario.beats) ? scenario.beats : [];
    this.currentBeatIndex = 0;       // index into beats the group is in
    this.beatStall = 0;              // consecutive in-progress turns stuck on the current beat
    this.beatHardStall = 0;          // consecutive fail/stall turns stuck on the current beat
    this.beatAutoAdvanced = false;   // set true the turn the engine advanced the arc itself
    this.lastBeatQuality = '';       // 'good' | 'mixed' | 'poor' | '' (persisted)

    // Roll modifier: a defender capability the group "played" (spent budget)
    // to nudge the next D20 roll. Persisted so it survives a restore.
    this.rollModifier = 0;

    // Budget spend tracking: lastBudgetSpend = spend this turn, budgetSpend =
    // cumulative spend since opening. Derived from negative budget deltas.
    this.lastBudgetSpend = 0;
    this.budgetSpend = 0;

    // Consecutive-turn streaks for stat end conditions that require a stat to
    // stay at/below (or at/above) a threshold for N turns before failing.
    // Keyed by end-condition index; reset when the stat leaves the zone.
    this.statStreaks = {};

    // Narrative-collapse state. Collapse is NOT a terminal loss (Dan's design,
    // 2026-10-05): it is in-story pressure the DM narrates, and it only colours
    // the win quality. `collapsed` latches true once the failure zone is
    // reached; `collapseRecord` captures the turn + note for the report.
    this.collapsed = false;
    this.lastCollapseTurn = -1;
    this.collapseRecord = null;

    // Timer
    this.startedAt = null;
    this.durationSeconds = this._durationFromEndConditions() || null;
    this.timerHandle = null;
    this.onTimerTick = null;

    // Token accounting. Usage is reported per turn when the provider exposes
    // it (Ollama eval counts / OpenAI usage); when absent we fall back to a
    // character-based ESTIMATE so the audit always has a number. `tokenUsage`
    // accumulates the session totals.
    this.tokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      prompt_estimated: false,
      completion_estimated: false,
      calls: 0,
    };
  }

  /**
   * Rough token estimate from text length (~4 chars/token). Used only when the
   * provider does not report usage, so the accounting is never empty.
   */
  _estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  /**
   * Record one model call's usage into the session totals. `usage` may be null
   * (provider reported nothing) — we then estimate from the prompt/reply text.
   */
  _recordUsage(usage, promptText, replyText) {
    const u = this.tokenUsage;
    u.calls += 1;
    if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
      u.prompt_tokens += usage.prompt_tokens || 0;
      u.completion_tokens += usage.completion_tokens || 0;
    } else {
      u.prompt_tokens += this._estimateTokens(promptText);
      u.completion_tokens += this._estimateTokens(replyText);
      u.prompt_estimated = true;
      u.completion_estimated = true;
    }
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

  /**
   * Ask the DM to narrate the OPENING SCENE before the group has acted, so the
   * session starts with the DM describing what is actually happening (not a
   * blank "the game has started" state). Especially important in RANDOM mode,
   * where there is no pre-authored intro narrative. This is a pure narration
   * turn: no player action, no roll, no state change. Returns the DM's opening
   * narrative string.
   * @returns {Promise<string>}
   */
  async openScene() {
    const system = buildSystemPrompt(this.scenario, { castInfo: this.castInfo, random: this.random });
    const user =
      'The session is about to begin. NO group action has been taken yet (this is the opening scene, turn 0).\n' +
      'Narrate the opening scene in vivid, forward-driving prose (4-7 sentences): what has just happened, what the group\n' +
      'is observing right now, and the concrete pressure/decision that is immediately in front of them.\n' +
      'HAND OVER THE KEY FACTS UP FRONT: include everything the team would realistically already know at this moment — who is involved, what happened, where/how it started (e.g. which channel or account the incident came through), and what is at stake. Do NOT withhold essential context that the group would have in a real situation; they should not have to ask basic questions to learn how the incident began. Reserve genuine unknowns (e.g. who is behind it, how deep it goes) for discovery through investigation.\n' +
      'Do NOT describe any group actions or outcomes (none have occurred). Do NOT present a menu of choices.\n' +
      'End by leaving the group facing a concrete in-world development they must react to.\n' +
      'Reply with STRICT JSON: {"narrative": "<the opening scene prose>"} and nothing else.';
    const dmResult = await this.provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.8, maxTokens: SCENE_TOKENS, numCtx: DM_NUM_CTX, onUsage: (u) => { this._lastUsage = u; } }
    );
    const openingUsage = this._lastUsage || null;
    this._lastUsage = null;
    this._recordUsage(openingUsage, system + user, dmResult);
    const parsed = this._extractJson(dmResult);
    let narrative = parsed.narrative || dmResult;
    if (!parsed.narrative) {
      const looksLikeJson = /^[{\[]/.test(String(dmResult).trim()) || /^"[\s\S]*"$/.test(String(dmResult).trim());
      if (looksLikeJson) narrative = 'The opening scene unfolds. (The DM narrative could not be parsed cleanly.)';
    }
    if (!String(narrative).trim()) {
      narrative = 'The situation is already live: the group faces an active crisis with the clock running, and their first move will set the tone for everything that follows.';
    }
    // Seed the transcript so the opening scene shows in the closing report.
    // Include the audit trail (both sides of the opening exchange) as well.
    this.history.push({
      turn: 0,
      action: '(opening scene)',
      narrative,
      roll: null,
      dm_prompt: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      dm_reply: dmResult,
      usage: openingUsage,
      tokens_prompt: openingUsage && openingUsage.prompt_tokens != null
        ? openingUsage.prompt_tokens
        : this._estimateTokens(system + user),
      tokens_completion: openingUsage && openingUsage.completion_tokens != null
        ? openingUsage.completion_tokens
        : this._estimateTokens(dmResult),
    });
    return narrative;
  }

  /**
   * ASK THE DM — an out-of-band clarification channel (Dan, 2026-10-08).
   *
   * The group can ask the DM a question, or clarify/correct something the DM
   * got wrong, WITHOUT burning a turn: this method takes NO roll, does NOT
   * advance the turn counter, does NOT change any state or the arc, and never
   * triggers end conditions. It is purely informational back-channel with the
   * moderator.
   *
   * The DM answers in its own voice as the moderator/case-briefer. A question
   * can be a factual query ("what did the console audit show?"), a clarification
   * ("we never said that publicly — correct the record"), or a correction
   * ("that metric moved wrong; the takedown did land"). The DM should acknowledge
   * a correction and reason about it, but must NOT rewrite history or outcomes
   * — the answer is guidance, not a re-resolution of the turn.
   *
   * @param {string} question  the group's question / clarification / correction
   * @returns {Promise<{answer:string, asked:string}>}
   */
  async askDM(question) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Type a question for the DM first.');

    const system = buildSystemPrompt(this.scenario, { castInfo: this.castInfo, random: this.random });
    const user = [
      'OUT-OF-BAND MESSAGE — the group is NOT taking an action and has NOT rolled. This is a question, a clarification, or a correction for the moderator. Do NOT resolve a turn, do NOT change any metric, do NOT advance the story, and do NOT narrate new developments.',
      '',
      `Current state: ${JSON.stringify(this.state)}`,
      this.beats.length ? `Current story step: ${this.currentBeatIndex + 1} of ${this.beats.length} (${this.beats[this.currentBeatIndex] && this.beats[this.currentBeatIndex].name}).` : '',
      '',
      `The group says: "${q}"`,
      '',
      'Answer in the moderator\'s own voice, plainly and concretely (2-6 sentences):',
      '- If it is a factual question the group would plausibly know or could reasonably infer from the situation so far, answer it directly with the in-world facts. Do not withhold realistic context.',
      '- If it is a clarification, clarify.',
      '- If it is a correction (the group says the DM got something wrong), acknowledge it honestly and reason about what it means for the situation \u2014 but do NOT rewrite past outcomes or silently change the score. If the correction materially affects play, say so and note it will be reflected in how the next turn is judged.',
      '- If the question asks what the group SHOULD do, do not prescribe actions; describe the situation and the realistic options instead.',
      'Reply with STRICT JSON: {"answer": "<your reply to the group>"} and nothing else.',
    ].filter(Boolean).join('\n');

    const dmResult = await this.provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.5, maxTokens: SCENE_TOKENS, numCtx: DM_NUM_CTX, onUsage: (u) => { this._lastUsage = u; } }
    );
    const usage = this._lastUsage || null;
    this._lastUsage = null;
    this._recordUsage(usage, system + user, dmResult);

    const parsed = this._extractJson(dmResult);
    let answer = parsed.answer || parsed.narrative || dmResult;
    if (!String(answer).trim()) {
      answer = 'No record of that yet \u2014 the situation is still unfolding, so I can\u2019t confirm it from what the table has established. Ask again once events develop.';
    }
    answer = String(answer).trim();

    // Record the exchange for the audit trail / report, but flagged as a
    // clarification so it is never mistaken for a played turn. Does NOT touch
    // this.turn, this.state, the arc, or the chain.
    this.clarifications = this.clarifications || [];
    const entry = {
      turn: this.turn,
      asked: q,
      answer,
      dm_prompt: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      dm_reply: dmResult,
      usage,
      ts: Date.now(),
    };
    this.clarifications.push(entry);
    return { answer, asked: q };
  }

  secondsLeft() {
    if (!this.startedAt || !this.durationSeconds) return null;
    return Math.max(0, this.durationSeconds - Math.floor((Date.now() - this.startedAt) / 1000));
  }

  /**
   * Build the per-turn PACE brief for the DM: the turn the group is ON, the turn
   * budget, the wall-clock time left, and whether the arc is ahead of, on, or
   * behind pace. This is what lets the DM speed up or slow down instead of
   * guessing. Also surfaces any note left by the engine's own arc auto-advance.
   *
   * @returns {string} a line block (or '' when there is nothing to say)
   */
  _paceBrief() {
    if (!this.beats.length) {
      // No arc to pace against; still report the clock so the DM lands the story
      // inside the hour.
      const mins = this._minutesLeft();
      return mins == null ? '' : `\nTIME: about ${mins} minute${mins === 1 ? '' : 's'} left on the clock. Land the story comfortably within it.`;
    }

    const onTurn = this.turn + 1;          // the turn being resolved now
    const target = this.targetTurn;
    const total = this.totalTurn;
    const reachedFinal = this.currentBeatIndex >= this.beats.length - 1;
    const mins = this._minutesLeft();

    // How many turns the group has to work with, and whether the arc is behind.
    const beatNo = this.currentBeatIndex + 1;
    const beatsLeft = this.beats.length - this.currentBeatIndex - 1;

    let verdict;
    if (reachedFinal) {
      verdict = 'ON THE FINAL BEAT \u2014 resolve the story this turn; do not open new complications.';
    } else if (onTurn > total) {
      verdict = `OVER BUDGET \u2014 past the turn ceiling. Resolve the story this turn; let a strong action skip straight to the final beat.`;
    } else if (beatsLeft > 0 && onTurn + beatsLeft > total) {
      // More beats left than turns to play them in: the arc cannot finish on
      // schedule, so the group is genuinely behind. SPEED UP.
      verdict = `SPEED UP \u2014 ${beatsLeft} beats remain with only ${Math.max(0, total - onTurn + 1)} turn(s) of budget left. Move the arc forward decisively this turn; a strong action should skip a beat.`;
    } else if (onTurn >= target && beatsLeft > 0) {
      verdict = `BREATHE \u2014 you are at the ${target}-turn mark with ${beatsLeft} beat${beatsLeft > 1 ? 's' : ''} to go, so there is room. Keep the response in proportion to what the group did; a small move gets a small reaction.`;
    } else if (beatsLeft > 0 && onTurn + beatsLeft <= target) {
      // Plenty of time left: the DM should mirror the group's effort, not pile on.
      verdict = `KEEP IT PROPORTIONATE \u2014 there is ample time (turn ${onTurn}, ${beatsLeft} beat${beatsLeft > 1 ? 's' : ''} to go, target ${target}). Do NOT pile a cascade of problems onto a single action. Mirror the group\u2019s effort: one action in, one measured reaction out. Let the turn breathe and hold your escalation in reserve.`;
    } else {
      verdict = 'ON PACE \u2014 advance the arc every turn or two, and keep reactions proportionate to the group\u2019s actions.';
    }

    const clock = mins == null ? '' : ` About ${mins} minute${mins === 1 ? '' : 's'} left on the clock.`;
    const budget = `Turn ${onTurn} of about ${total} (target: resolve by turn ${target}). Story beat ${beatNo} of ${this.beats.length}${beatsLeft > 0 ? `, ${beatsLeft} to go` : ''}.${clock}`;
    const note = this._paceNote ? `\n${this._paceNote}` : '';

    return `\nPACE: ${budget}\nPACING VERDICT: ${verdict}${note}`;
  }

  /** Minutes left on the clock, or null when there is no time limit. */
  _minutesLeft() {
    const s = this.secondsLeft();
    return s == null ? null : Math.max(0, Math.round(s / 60));
  }

  /**
   * The mid-beat development to inject this turn, or null.
   *
   * Dan (2026-10-07): beats were resolving in a single turn, so the arc ran
   * only 4 turns. Each beat may now carry `developments` \u2014 short mid-beat twists.
   * The first fires on the group's SECOND turn inside the beat, so a beat takes
   * at least two turns of real story before it can close, stretching the arc to
   * 5-6 turns through content, not padding. Fires at most once per beat, tracked
   * by beat index so a beat that is re-entered never re-fires.
   */
  _pendingDevelopment() {
    const beats = this.beats || [];
    const cur = beats[this.currentBeatIndex];
    if (!cur || !Array.isArray(cur.developments) || !cur.developments.length) return null;
    // "Second turn in the beat": beatStall counts turns spent in this beat
    // without advancing. On the turn we are about to resolve, beatStall is the
    // number of prior stuck turns. Fire when the group has already had one turn
    // in this beat (beatStall >= 1) and we have not fired here yet.
    const key = this.currentBeatIndex;
    this._devFired = this._devFired || new Set();
    if (this._devFired.has(key)) return null;
    const stall = Math.max(this.beatStall || 0, this.beatHardStall || 0);
    if (stall < 1) return null;
    const dev = cur.developments[0];
    this._devFired.add(key);
    return dev;
  }

  /**
   * Resolve one turn: action text + roll -> narrative, state update, end check.
   * @returns {Promise<{narrative, state, event, endCondition, roll}>}
   */
  async takeTurn(action, roll, player = null) {
    if (!action || !action.trim()) throw new Error('Describe an action first.');
    if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error('D20 roll must be 1-20.');

    const fateKey = String(roll);
    const fate = this.scenario.fate_table ? this.scenario.fate_table[fateKey] : null;

    // Pre-chat: find stat/turn events that will fire this turn so they can be
    // woven into the DM's context. Stall events are judged AFTER the DM
    // reports progress, so they are evaluated below. Fired events are
    // tracked and never re-fire.
    const preFired = this._pendingStatTurnEvents();
    // Mid-beat development (Dan 2026-10-07): computed once here (it consumes the
    // fire-once marker) and read by buildUserTurn via the stash below.
    this._devThisTurn = this._pendingDevelopment();

    // ---------------- AUDIT TRAIL (both sides) -----------------------------
    // Capture the exact system + user prompt sent to the DM and the model's raw
    // reply (before parsing), so the closing report can show the full
    // DM<->player conversation for an auditor. See the event object below.
    const system = buildSystemPrompt(this.scenario, { castInfo: this.castInfo, random: this.random });
    const user = buildUserTurn(this.scenario, this, action, roll, fate, preFired);
    this._paceNote = ''; // consumed by the brief above; cleared so it fires once

    const dmResult = await this.provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.8, maxTokens: TURN_TOKENS, numCtx: DM_NUM_CTX, onUsage: (u) => { this._lastUsage = u; } }
    );
    const turnUsage = this._lastUsage || null;
    this._lastUsage = null;
    this._recordUsage(turnUsage, system + user, dmResult);

    const parsed = this._extractJson(dmResult);
    // Never let raw JSON leak to the player as the narrative. If extraction
    // produced no narrative and the raw reply still looks like a JSON object,
    // fall back to a safe generic line rather than showing the JSON fence.
    let narrative = parsed.narrative || dmResult;
    if (!parsed.narrative) {
      const looksLikeJson = /^[{\[]/.test(String(dmResult).trim()) || /^"[\s\S]*"$/.test(String(dmResult).trim());
      if (looksLikeJson) narrative = 'The situation developed. (The moderator narrative could not be parsed cleanly.)';
    }
    // HOLLOW / EMPTY REPLY GUARD (Dan, 2026-10-08): an empty, whitespace-only,
    // or no-op reply used to surface a meta-message to the players ("the
    // moderator returned no narrative — try again") or generic boilerplate that
    // read as "no response, the story continues." Intermittent provider failures
    // should never stall the table. Re-ask the model ONCE for a real development;
    // if it still fails, substitute a concrete in-fiction twist drawn from the
    // scenario so the turn ALWAYS advances the story.
    const blank = !String(narrative).trim();
    const hollow = !blank && this._detectNoopNarrative(narrative);
    if (blank || hollow) {
      const retry = await this._retryNarrative(system, user);
      if (retry) {
        narrative = retry.narrative;
        Object.assign(parsed, retry.parsed);
      }
      // Re-check after the retry; if still blank/hollow, use a real development.
      if (!String(narrative).trim() || this._detectNoopNarrative(narrative)) {
        const isJsonish = !parsed.narrative && /^[{\[]/.test(String(dmResult).trim());
        narrative = this._inFictionFallback(action, roll, { isJsonish });
        parsed.progress = false;
      }
    }

    const delta = parsed.state_delta || {};

    // ------- CRITICAL FAILURE (natural 1) — engine-enforced ---------------
    // A natural 1 is an absolute failure (Dan, 2026-10-08). The DM is told to
    // obey, but it ignores the die often enough that we enforce the outcome
    // structurally here: no progress, no beat advance, no chain containment,
    // and never a "success" narrative. See the CRIT_FAIL_* block near the top.
    const critFail = roll === 1;
    if (critFail) {
      parsed.progress = false;
      parsed.beat = null;
      parsed.contain_stage = null;
      // If the DM narrated a win anyway, replace it with an authored setback so
      // a 1 can never read as success.
      if (CRIT_FAIL_RES.some((re) => re.test(String(narrative)))) {
        narrative = CRIT_FAIL_FALLBACK;
      }
      // Guarantee a real consequence even when a scenario fate_table omits the
      // natural 1 — apply the fallback delta only when the roll contributed none.
      if (!(fate && fate.state_delta)) {
        for (const [k, v] of Object.entries(CRIT_FAIL_FALLBACK_DELTA)) {
          delta[k] = (typeof delta[k] === 'number' ? delta[k] : 0) + v;
        }
      }
    }

    // The DM judges whether the group made meaningful progress this turn.
    // A missing `progress` field defaults to progress (reset to 0) so a
    // missing field never falsely triggers a stall.
    this.stallCount = parsed.progress === false ? this.stallCount + 1 : 0;

    // The DM may reveal or contain an attack-chain stage this turn.
    // A critical failure cannot contain anything (the die is authoritative).
    if (!critFail) this._applyChainJudgment(parsed);

    // Story beats: advance the arc if the DM says the current beat is resolved.
    // A critical failure never advances the arc (the die is authoritative).
    if (!critFail) this._applyBeatJudgment(parsed);

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
    // If the in-fiction fallback fired and carried a development delta, apply it.
    if (this._devFallbackDelta) { merge(this._devFallbackDelta); this._devFallbackDelta = null; }
    // mid-beat development (may be null)
    const dev = this._devThisTurn || null;
    this._devThisTurn = null;
    if (dev && dev.state_delta) merge(dev.state_delta);
    merge(delta);
    this.state = this._applyDelta(this.state, combined);

    // Track budget spend: a negative budget delta = money the group spent on
    // this turn's actions. Positive budget deltas are inflows/recovery (not
    // spend). lastBudgetSpend = this turn's outlay; budgetSpend = running total
    // since opening (never goes below 0).
    const budgetDelta = typeof combined.budget === 'number' ? combined.budget : 0;
    this.lastBudgetSpend = budgetDelta < 0 ? -budgetDelta : 0;
    this.budgetSpend = (this.budgetSpend || 0) + this.lastBudgetSpend;

    this.turn += 1;

    // A roll modifier is consumed by the roll it was granted for.
    this.rollModifier = 0;

    const event = {
      turn: this.turn,
      action,
      // Per-player attribution: which participant took (or spoke for) this
      // action. Null for the opening scene / unattributed play.
      player: player || null,
      roll,
      // Only surface a `fate` on the dramatic faces (1-5, 20) so the UI/log
      // headlines a FATE EVENT for those turns only. Middle rolls still had
      // scripted guidance (already woven into the narrative) but are not
      // announced as special events. Dan (2026-10-07).
      fate: fate && isNotableFate(roll) ? fate.twist : null,
      fate_notable: !!(fate && isNotableFate(roll)),
      events: firedEvents.map((e) => e.id),
      narrative,
      state: clone(this.state),
      attack_chain: clone(this.attackChain),
      breach_state: this.breachState,
      beat: this.beats.length ? this.beats[this.currentBeatIndex].id : null,
      beat_quality: this.lastBeatQuality,
      budget_spend: this.lastBudgetSpend,
      total_budget_spend: this.budgetSpend,
      // Audit trail: both sides of the DM exchange, verbatim.
      //   dm_prompt : the exact [system, user] messages sent to the model
      //   dm_reply  : the raw model reply BEFORE parsing/narrative cleanup
      dm_prompt: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      dm_reply: dmResult,
      // Token accounting for THIS turn (provider-reported, else estimated).
      usage: turnUsage,
      tokens_prompt: turnUsage && turnUsage.prompt_tokens != null
        ? turnUsage.prompt_tokens
        : this._estimateTokens(system + user),
      tokens_completion: turnUsage && turnUsage.completion_tokens != null
        ? turnUsage.completion_tokens
        : this._estimateTokens(dmResult),
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
   * Apply the DM's story-beat judgment: if the DM says the current beat is
   * resolved (returns the next beat id in `beat`), advance the arc. Records
   * how the group handled the just-completed beat (`beat_quality`) so the next
   * beat's tone can be softened or escalated. The DM may also skip forward to
   * a later beat id (a decisive action that collapses multiple steps).
   */
  _applyBeatJudgment(parsed) {
    if (!this.beats.length) {
      this.lastBeatQuality = '';
      return;
    }
    this.beatAutoAdvanced = false;   // reset each turn; set below only on an engine-forced move
    if (parsed.beat_quality === 'good' || parsed.beat_quality === 'mixed' || parsed.beat_quality === 'poor') {
      this.lastBeatQuality = parsed.beat_quality;
    } else if (parsed.beat) {
      // A beat transition without an explicit quality: infer from progress.
      this.lastBeatQuality = parsed.progress === false ? 'poor' : 'mixed';
    }

    let advanced = false;
    if (parsed.beat) {
      const next = this.beats.findIndex((b) => b.id === parsed.beat);
      // Only advance forward (or stay); never go backwards. A beat id that is
      // not in the arc is ignored. If the target index is <= current, treat as
      // "stay in the current beat" (no valid forward move).
      if (next > this.currentBeatIndex) {
        this.currentBeatIndex = next;
        advanced = true;
      }
    }

    // Linear pacing guard (Dan's design, 2026-10-06): the arc is the SPINE and
    // must not drag. The DM sometimes parks the group in Step 1 while playing
    // whack-a-mole on the attack chain. If the group made real progress
    // (progress !== false) and the DM did NOT advance the beat, count it; after
    // BEAT_STALL_MAX turns of a stuck beat, advance the arc ourselves so the
    // story always moves. The final beat is never auto-skipped PAST — once the
    // group is on the last beat we leave it there (reaching it is the win).
    if (advanced) {
      this.beatStall = 0;
      this.beatHardStall = 0;
    } else if (parsed.progress === false) {
      // A genuine stall (the group did nothing / the turn went badly) does not
      // count toward the "stall" guard the same way, BUT it must NOT be allowed
      // to freeze the arc forever. Dan (2026-10-07): a uniformly bad run of
      // rolls was dead-ending — the story could not reach its resolution, which
      // breaks the "even at 0 the story stays playable" contract. So we still
      // count a hard-stall turn toward the guard, at a slower rate, and force
      // the arc forward once a beat has been stuck too long either way.
      this.beatHardStall = (this.beatHardStall || 0) + 1;
      if (this.beatHardStall >= HARD_STALL_MAX && this.currentBeatIndex < this.beats.length - 1) {
        this.currentBeatIndex += 1;
        this.beatHardStall = 0;
        this.beatAutoAdvanced = true;
        this._paceNote = `NOTE: the engine advanced the story arc for you last turn because the group has been stuck on this beat through repeated setbacks \u2014 narrate the transition as the story grinding forward despite them, and let the new beat bite.`;
      }
    } else {
      this.beatStall = (this.beatStall || 0) + 1;
      if (this.beatStall >= BEAT_STALL_MAX && this.currentBeatIndex < this.beats.length - 1) {
        this.currentBeatIndex += 1;
        this.beatStall = 0;
        this.beatAutoAdvanced = true; // flag for the DM/report: the arc moved on
        // Tell the DM next turn that the engine moved the arc for them, so it
        // narrates the transition instead of silently contradicting the beats.
        this._paceNote = `NOTE: the engine advanced the story arc for you last turn because the group was stalled on a beat while still making progress \u2014 narrate the transition naturally and keep the new beat moving.`;
      }
    }
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

  /**
   * When the story ARC resolves (final beat reached), the resolution implies the
   * situation was brought under control. Tidy the attack chain accordingly so a
   * strong run can read as a clean, decisive win rather than always "costly":
   *   - Every REVEALED stage is treated as contained by the resolution (the group
   *     found it and the story closed it out).
   *   - If the group had clear command of the situation (not collapsed, and the
   *     key confidence/containment metrics are healthy), the remaining unrevealed
   *     stage is closed too \u2014 the resolution swept it up.
   * A collapsed or struggling run keeps its open stages, so its win still reads
   * as costly. This never blocks the win; it only affects how the ending reads.
   */
  _tidyChainOnResolution() {
    if (!this.attackChain.length) return;
    // Revealed stages: the story resolved around them, so they end contained.
    for (const s of this.attackChain) {
      if (s.revealed) s.contained = true;
    }
    // Command-of-the-situation bonus: a run that was never in crisis and kept
    // confidence/containment solid sweeps up the last hidden stage too.
    const trust = this.state.public_trust || 0;
    const reg = this.state.regulator_confidence || 0;
    const contain = this.state.containment || 0;
    const inCommand = !this.collapsed && trust >= 55 && reg >= 55 && contain >= 50;
    if (inCommand) {
      for (const s of this.attackChain) s.contained = true;
    }
    this.breachState = deriveBreachState(this.attackChain);
  }

  _checkEnd() {
    // NOTE: a single bad stat does NOT end the game (Dan's design: no instant
    // loss on one metric hitting a threshold). But the NARRATIVE COLLAPSE does:
    // when the scenario's stat loss conditions (public_trust AND
    // regulator_confidence both critically low, by default) hold for
    // `consecutive` turns in a row, the story has collapsed and the session
    // ends as a narrated LOSS (see _checkNarrativeLoss below).

    // WIN = a STORY win, not a score gate (Dan's design: the numeric metrics
    // are advisory texture, never a pass/fail threshold — a five-stat AND-gate
    // is brittle and turns a story exercise into stat-grinding). The exercise
    // is won when the narrative arc resolves:
    //   1. The final story beat is reached (the arc plays out), OR
    //   2. The attack chain is fully contained (every stage neutralized),
    // whichever the scenario uses. Either is a genuine story conclusion.
    // The metrics do NOT gate the win; they only colour how GLORIOUS vs HOW
    // COSTLY the resolution reads (see _winQuality).
    const goal = this.scenario.goal;
    const hasGoal = !!goal;

    const finalBeatReached = this.beats.length > 0 && this.currentBeatIndex >= this.beats.length - 1;

    // When the ARC resolves, the story itself has reached its conclusion \u2014 the
    // threat is dealt with as part of that resolution. So on the final beat we
    // TIDY UP the chain: any stage that was REVEALED (the group found it) is
    // treated as contained by the resolution UNLESS the run is in crisis, and
    // if the group clearly had command of the situation, the last unrevealed
    // stage is closed too. This makes a clean, decisive win REACHABLE for strong
    // play instead of near-impossible (Dan's design, 2026-10-06, option 2).
    if (finalBeatReached) this._tidyChainOnResolution();

    const chainContained = this.attackChain.length > 0 && this.attackChain.every((s) => s.contained);

    // Linear progression (Dan's design, 2026-10-06): reaching the final story
    // beat WINS on its own, even if some attack-chain stages are still open.
    // The arc is the spine; the chain is texture. Leaving a stage uncontained
    // does not block the win — it just reads as costlier (see _winQuality).
    // Fully containing the chain is an ALTERNATIVE win path (the threat is
    // neutralized), not a requirement layered on top of the arc.
    if (finalBeatReached || chainContained) {
      const quality = this._winQuality();
      const why = finalBeatReached
        ? (chainContained
            ? 'The story arc reaches its resolution with the whole attack chain contained.'
            : 'The story arc reaches its resolution.')
        : 'Every stage of the attack chain is contained.';
      const openStages = this.attackChain.filter((s) => !s.contained).map((s) => s.id);
      return {
        type: 'goal',
        result: 'success',
        success_kind: 'story',
        win_quality: quality.tier,
        win_summary: quality.summary,
        ending: (goal && goal.ending) || 'The exercise reaches its resolution.',
        ...(goal || {}),
        final_beat: finalBeatReached ? this.beats[this.beats.length - 1].id : null,
        chain_contained: chainContained || undefined,
        open_stages: openStages.length ? openStages : undefined,
        why,
      };
    }

    // Loss: the NARRATIVE COLLAPSE does NOT end the session (Dan's design,
    // 2026-10-05). Even if EVERY metric is at 0, the group must still be able
    // to play the story to its resolution \u2014 a score must never strangle the
    // narrative. When the collapse condition holds, we flag it as in-story
    // pressure (the DM narrates the strain) and keep playing; the session ends
    // only when the STORY resolves (win, above), the timer runs out, or the
    // group ends it. The collapse instead downgrades the win quality (a fully
    // collapsed run that still resolves the story reads as the costliest win).
    const collapse = this._checkNarrativeLoss();
    if (collapse) {
      // Record (once per turn) that the situation has collapsed, for the DM +
      // report; NEVER return it as a terminal loss.
      if (this.lastCollapseTurn !== this.turn) {
        this.lastCollapseTurn = this.turn;
        this.collapsed = true;
        this.collapseRecord = {
          turn: this.turn,
          stats: collapse.stats || [{ stat: collapse.stat, operator: collapse.operator, value: collapse.value }],
          note: collapse.ending || 'The situation has collapsed into crisis.',
        };
      }
    }

    return null;
  }

  /**
   * The session is in NARRATIVE COLLAPSE: the failure-zone condition holds (e.g.
   * trust AND regulator both critically low). This is NOT a terminal loss \u2014 it
   * is in-story pressure the DM should narrate. Exposed so the UI/report can
   * flag the state, and so the win can be scored as the costliest tier.
   */
  isCollapsed() {
    return this._checkNarrativeLoss() !== null;
  }

  /**
   * A soft, non-gating read on how well the group actually did when the story
   * resolved. The metrics are advisory: they flavour the ending (a clean win
   * versus a costly one) but NEVER decide win versus lose. Returns a tier plus
   * a one-line summary for the report/debrief.
   */
  _winQuality() {
    const advisory = (this.scenario.goal && Array.isArray(this.scenario.goal.win_conditions))
      ? this.scenario.goal.win_conditions
      : [];
    // A run that fell into the narrative collapse still WINS if it resolves the
    // story \u2014 but it reads as the costliest possible win.
    if (this.collapsed) {
      return {
        tier: 'costly',
        collapsed: true,
        summary: 'A desperate resolution: the story concludes, but the situation had already collapsed \u2014 this reads as a comeback won against the odds.',
      };
    }
    // Chain-driven read (Dan's design, 2026-10-06): how the ending reads turns on
    // how much of the attack chain was closed out AND how healthy the key
    // metrics are. After _tidyChainOnResolution a strong run can reach `decisive`.
    const open = this.attackChain.filter((s) => !s.contained).length;
    const trust = this.state.public_trust || 0;
    const reg = this.state.regulator_confidence || 0;
    if (advisory.length) {
      const met = advisory.filter((c) => {
        const v = this.state[c.stat];
        if (typeof v !== 'number') return false;
        if (c.operator === 'lte') return v <= c.value;
        return v >= c.value;
      }).length;
      const ratio = met / advisory.length;
      if (open === 0 && ratio >= 0.999) {
        return { tier: 'decisive', summary: 'A decisive resolution: the story lands, the whole attack chain is contained, and every objective is comfortably met.' };
      }
      if (open === 0 || ratio >= 0.5) {
        return { tier: 'solid', summary: open === 0
          ? 'A clean resolution: the story lands and the whole attack chain is contained.'
          : 'A solid resolution: the story lands, though some objectives were only partly secured.' };
      }
      return { tier: 'costly', summary: 'A hard-won resolution: the story concludes, but the group paid a steep price to get there.' };
    }
    if (open === 0 && trust >= 55 && reg >= 55) {
      return { tier: 'decisive', summary: 'A decisive resolution: the story lands with the whole attack chain contained and confidence intact.' };
    }
    if (open === 0) return { tier: 'solid', summary: 'A clean resolution: the story lands with the whole attack chain contained.' };
    if (open < this.attackChain.length) return { tier: 'solid', summary: `A solid resolution: the story lands, though ${open} stage${open > 1 ? 's' : ''} of the attack chain were left open.` };
    return { tier: 'costly', summary: 'A hard-won resolution: the story concludes, but the attack chain was never contained.' };
  }

  /**
   * The scenario's stat-based loss conditions: end_conditions entries with
   * type 'stat' (result defaults to 'loss'). Supports a single-stat form
   * ({ stat, operator, value }) and a multi-stat form ({ stats: [{ stat,
   * operator, value }, ...] }) where ALL stats must be in the failure zone
   * (the narrative collapse). Falls back to the built-in DEFAULT_LOSS_CONDITION
   * (public_trust AND regulator_confidence both <= 20) when the scenario
   * defines none — every session has a narrative-loss path.
   */
  _lossConditions() {
    const conds = (this.scenario.end_conditions || []).filter(
      (c) => c && c.type === 'stat' && (c.result === undefined || c.result === 'loss')
    );
    return conds.length ? conds : [DEFAULT_LOSS_CONDITION];
  }

  /** True when a single stat constraint is satisfied this turn. */
  _statInZone(c) {
    const v = this.state[c.stat];
    if (typeof v !== 'number') return false;
    if (c.operator === 'lte') return v <= c.value;
    if (c.operator === 'gte') return v >= c.value;
    return false;
  }

  /** True when ALL of a loss condition's stat constraints hold this turn. */
  _lossConditionMet(cond) {
    const constraints = Array.isArray(cond.stats) && cond.stats.length ? cond.stats : [cond];
    return constraints.every((c) => this._statInZone(c));
  }

  /**
   * NARRATIVE-LOSS check: a loss condition that holds for `consecutive`
   * turns in a row ends the session as a narrated LOSS (the collapse ending).
   * The consecutive-turn streak is tracked in this.statStreaks keyed by
   * condition index and is updated at most once per turn (guarded by
   * lastTurn), so repeated _checkEnd calls within one turn never
   * double-count. The streak resets to 0 the turn the condition stops
   * holding (e.g. one confidence metric recovers above the threshold).
   */
  /**
   * Detect the NARRATIVE COLLAPSE condition. IMPORTANT: this is NO LONGER a
   * terminal loss (Dan's design, 2026-10-05). It returns a descriptor of the
   * collapse (which stats, the streak, a note) so the engine can flag the run
   * as collapsed and the DM can narrate the strain — but the session keeps
   * playing so the story can still resolve. The collapse only downgrades the
   * win quality (see _winQuality). The name is retained for continuity.
   * The consecutive-turn streak is tracked in this.statStreaks keyed by
   * condition index and is updated at most once per turn (guarded by
   * lastTurn), so repeated calls within one turn never double-count. The streak
   * resets to 0 the turn the condition stops holding.
   */
  _checkNarrativeLoss() {
    const conds = this._lossConditions();
    for (let i = 0; i < conds.length; i++) {
      const cond = conds[i];
      const met = this._lossConditionMet(cond);
      const streak = this.statStreaks[i] || { count: 0, lastTurn: -1 };
      if (streak.lastTurn !== this.turn) {
        streak.count = met ? streak.count + 1 : 0;
        streak.lastTurn = this.turn;
      }
      this.statStreaks[i] = streak;
      const need = Math.max(1, cond.consecutive || 1);
      if (met && streak.count >= need) {
        return {
          ...cond,
          type: 'collapse',
          result: 'collapse',
          note: cond.ending || DEFAULT_LOSS_CONDITION.ending,
          ending: cond.ending || DEFAULT_LOSS_CONDITION.ending,
        };
      }
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

  /** Detect a no-op narrative: the DM said nothing happened / nothing
   *  responded and "the story continues", which dead-ends the group with no
   *  new development to react to. Returns true when the narrative is hollow.
   *  Case-insensitive; matches the tell-tale phrases the prompt bans. */
  /**
   * Re-ask the model ONCE when its reply was empty or hollow, so an
   * intermittent provider failure does not burn the turn. Returns
   * { narrative, parsed } on a usable reply, or null.
   */
  async _retryNarrative(system, user) {
    try {
      const retryUser = String(user) + '\n\nNOTE: your previous reply was empty or said nothing happened. Reply with the REQUIRED STRICT JSON and a CONCRETE development of 3-6 sentences.';
      const raw = await this.provider.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: retryUser },
        ],
        { temperature: 0.8, maxTokens: TURN_TOKENS, numCtx: DM_NUM_CTX, onUsage: (u) => { this._lastUsage = u; } }
      );
      const usage = this._lastUsage || null;
      this._lastUsage = null;
      this._recordUsage(usage, system + retryUser, raw);
      const parsed = this._extractJson(raw);
      const narrative = String(parsed.narrative || raw || '').trim();
      if (narrative && !this._detectNoopNarrative(narrative)) {
        return { narrative, parsed };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * A concrete, in-fiction fallback used only when the model gives nothing
   * usable TWICE. Prefers the current beat's next un-fired development (real
   * content from the scenario) and otherwise returns a forward-driving
   * complication. Either way the turn advances the story — the players never
   * see a "no response" meta-message.
   */
  _inFictionFallback(action, roll, opts = {}) {
    // Prefer a real scenario development for the current beat that has not yet
    // fired, so the fallback is story-specific rather than generic.
    const beats = this.beats || [];
    const cur = beats[this.currentBeatIndex];
    if (cur && Array.isArray(cur.developments) && cur.developments.length) {
      this._devFired = this._devFired || new Set();
      // Pick the first development not already used this beat.
      const used = this._devFired;
      for (let i = 0; i < cur.developments.length; i++) {
        const key = `${this.currentBeatIndex}:${i}`;
        if (!used.has(key)) {
          used.add(key);
          const dev = cur.developments[i];
          const text = typeof dev === 'string' ? dev : (dev && dev.text);
          if (text) {
            if (dev && dev.state_delta) this._devFallbackDelta = dev.state_delta;
            return `The group\u2019s move is overtaken by events already in motion. ${text}`;
          }
        }
      }
    }
    // Generic forward-driving complication: names the action, escalates, and
    // hands the group a concrete thing to react to.
    const act = action ? `the group\u2019s move (\u201c${action.slice(0, 120)}\u201d)` : 'the group\u2019s move';
    return `Events do not wait on ${act}. A fresh complication surfaces before the group can press its advantage \u2014 the situation has escalated and a new pressure demands an immediate response. ` +
      `The clock is now against them, and letting this development sit will make the next step harder.`;
  }

  _detectNoopNarrative(narrative) {
    if (typeof narrative !== 'string') return false;
    const n = narrative.toLowerCase();
    const markers = [
      'nothing happened',
      'nothing responded',
      'nothing has happened',
      'nothing changed',
      'the story continues',
      'the situation remains unchanged',
      'the situation is unchanged',
      'situation remains unchanged',
      'situation is unchanged',
      'no response yet',
      'no immediate development',
      'no immediate response',
      'they are still waiting',
      'the group is still waiting',
      'didn\u2019t do anything',
      "didn't do anything",
      'did not do anything',
      'no new development',
      'remains the same',
      'nothing of note',
    ];
    return markers.some((m) => n.includes(m));
  }

  /** Build the closing / audit report. */
  buildReport(endCondition) {
    const durationSec = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null;
    const minutes = durationSec ? Math.floor(durationSec / 60) : null;

    // Per-player action counts and token totals, so the in-app report matches
    // the exported report (server/report.js) rather than being a thinner view.
    const byPlayer = {};
    for (const e of this.history) {
      if (!e.player) continue;
      byPlayer[e.player] = (byPlayer[e.player] || 0) + 1;
    }
    const tu = this.tokenUsage || { prompt_tokens: 0, completion_tokens: 0 };
    // Indicative cost (best-effort public list prices, USD per 1M tokens).
    const lastUsage = [...this.history].reverse().find((e) => e && e.usage && e.usage.model);
    const modelId = (lastUsage && lastUsage.usage.model) || null;
    const rates = { 'deepseek-v4-pro': [0.55, 2.19], 'deepseek-v4.1-flash': [0.07, 0.28], 'deepseek': [0.27, 1.1], 'glm': [0.6, 2.2], 'gpt-4o-mini': [0.15, 0.6] };
    const key = String(modelId || '').toLowerCase();
    const matched = Object.keys(rates).find((m) => key.includes(m));
    const [rin, rout] = (matched && rates[matched]) || [0.07, 0.28];
    const costUsd = Math.round(((tu.prompt_tokens || 0) / 1e6 * rin + (tu.completion_tokens || 0) / 1e6 * rout) * 10000) / 10000;

    return {
      report_title: (this.scenario.report && this.scenario.report.title_note) || 'Tabletop Report',
      scenario: this.scenario.title,
      scenario_id: this.scenario.scenario_id,
      generated_at: new Date().toISOString(),
      ending: endCondition ? endCondition.ending : null,
      result: endCondition ? (endCondition.result || null) : null,
      success_kind: endCondition ? (endCondition.success_kind || null) : null,
      win_quality: endCondition ? (endCondition.win_quality || null) : null,
      win_summary: endCondition ? (endCondition.win_summary || null) : null,
      open_stages: endCondition && endCondition.open_stages ? endCondition.open_stages : null,
      collapsed: !!this.collapsed,
      collapse_record: clone(this.collapseRecord),
      turns: this.turn,
      duration_minutes: minutes,
      final_state: clone(this.state),
      log: clone(this.history),
      attack_chain: clone(this.attackChain),
      breach_state: this.breachState,
      actions_by_player: byPlayer,
      token_usage: {
        prompt_tokens: tu.prompt_tokens || 0,
        completion_tokens: tu.completion_tokens || 0,
        total_tokens: (tu.prompt_tokens || 0) + (tu.completion_tokens || 0),
        model_calls: tu.calls || 0,
        estimated: !!(tu.prompt_estimated || tu.completion_estimated),
        model: modelId,
        cost_usd: costUsd,
      },
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
      state: clone(this.state),      turn: this.turn,
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
      currentBeatIndex: this.currentBeatIndex,
      lastBeatQuality: this.lastBeatQuality,
      lastBudgetSpend: this.lastBudgetSpend,
      budgetSpend: this.budgetSpend,
      tokenUsage: clone(this.tokenUsage),
      collapsed: this.collapsed || false,
      lastCollapseTurn: this.lastCollapseTurn ?? -1,
      collapseRecord: clone(this.collapseRecord),
      targetTurn: this.targetTurn,
      totalTurn: this.totalTurn,
      castInfo: this.castInfo || '',
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
    session.currentBeatIndex = snapshot.currentBeatIndex || 0;
    // Pacing budget: prefer the snapshot; otherwise the constructor-derived value
    // (so an older snapshot without these fields still paces sensibly).
    session.targetTurn = snapshot.targetTurn || session.targetTurn;
    session.totalTurn = snapshot.totalTurn || session.totalTurn;
    session.lastBeatQuality = snapshot.lastBeatQuality || '';
    session.lastBudgetSpend = snapshot.lastBudgetSpend || 0;
    session.budgetSpend = snapshot.budgetSpend || 0;
    session.collapsed = snapshot.collapsed || false;
    session.lastCollapseTurn = snapshot.lastCollapseTurn ?? -1;
    session.collapseRecord = clone(snapshot.collapseRecord || null);
    session.castInfo = snapshot.castInfo || '';
    session.tokenUsage = snapshot.tokenUsage
      ? clone(snapshot.tokenUsage)
      : { prompt_tokens: 0, completion_tokens: 0, prompt_estimated: false, completion_estimated: false, calls: 0 };
    return session;
  }
}

export { STATE_MIN, STATE_MAX };
