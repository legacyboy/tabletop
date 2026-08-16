/**
 * Executive Tabletop D20 - Game Engine
 *
 * The engine is the pure logic layer for the tabletop exercise. It is
 * intentionally framework-free and has no DOM dependencies, so it can be
 * unit-tested in isolation.
 *
 * A "scenario" is plain JSON data (see /scenarios). The engine turns that
 * data into a live "run": a snapshot of state, the current decision point,
 * flags, and a log of every roll and its outcome.
 *
 * Key design rule: a scenario's decision points do NOT form a fixed
 * choose-your-own-adventure tree. Each decision point declares a "candidate
 * pool" of possible next beats (`next`), and the engine picks from that pool
 * using the current state, option tags, and the outcome tier of the roll.
 * This keeps scenarios branchy and replayable without exponential authoring.
 *
 * Outcome tiers are based on a single D20 roll, shifted by modifiers:
 *   crit_fail  1        (roll 1)
 *   fail       2 - 7
 *   mixed      8 - 13
 *   success    14 - 19
 *   crit_success 20     (roll 20)
 *
 * All state values are clamped to [0, 100].
 */
(function (global) {
  'use strict';

  /** Human-readable label for each outcome tier. */
  const TIER_LABELS = {
    crit_fail: 'Critical failure',
    fail: 'Failure',
    mixed: 'Mixed',
    success: 'Success',
    crit_success: 'Critical success'
  };

  /** [tier, minEffectiveRoll, maxEffectiveRoll] for each tier. */
  const TIERS = [
    ['crit_fail', 1, 1],
    ['fail', 2, 7],
    ['mixed', 8, 13],
    ['success', 14, 19],
    ['crit_success', 20, 20]
  ];

  /**
   * Deep clone a JSON-safe object. Used whenever a scenario or run is loaded
   * so the working copy is never the original data object.
   */
  const clone = (obj) => JSON.parse(JSON.stringify(obj));

  /** Clamp a state value to the allowed [0, 100] range. */
  const clamp = (value) => Math.max(0, Math.min(100, value));

  /**
   * Validate a scenario object. Returns { valid, errors, warnings }.
   * Errors are blocking problems; warnings are gaps (e.g. a missing outcome
   * tier that would fall back to a default message).
   */
  function validate(scenario) {
    const errors = [];
    const warnings = [];

    if (!scenario.scenario_id) errors.push('Missing scenario_id');
    if (!scenario.title) errors.push('Missing title');
    if (!scenario.opening_state) errors.push('Missing opening_state');
    if (!Array.isArray(scenario.decision_points) || scenario.decision_points.length === 0) {
      errors.push('decision_points must be non-empty');
    }

    // Index of every decision point id so we can cross-reference `next`.
    const ids = new Set((scenario.decision_points || []).map((d) => d.id));

    if (scenario.start_decision_id && !ids.has(scenario.start_decision_id)) {
      errors.push('start_decision_id not found');
    }

    for (const point of scenario.decision_points || []) {
      if (!point.id) errors.push('Decision point missing id');
      if (!point.prompt_seed) errors.push(`${point.id} missing prompt_seed`);
      if (!Array.isArray(point.options) || point.options.length === 0) {
        errors.push(`${point.id} needs options`);
      }

      // Warn when a tier has no authored outcome (falls back to a default).
      for (const tier of Object.keys(TIER_LABELS)) {
        if (!point.outcomes || !point.outcomes[tier]) {
          warnings.push(`${point.id} missing outcome ${tier}`);
        }
      }

      // Every entry in `next` must resolve to a real decision point id.
      for (const nextId of point.next || []) {
        if (!ids.has(nextId)) {
          errors.push(`${point.id} next points to missing ${nextId}`);
        }
      }
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  /**
   * Create a fresh run from a scenario: clone the opening state, set the
   * starting decision point, and initialize bookkeeping (turn, flags, log).
   */
  function create(scenario) {
    const first =
      scenario.decision_points.find((d) => d.id === scenario.start_decision_id) ||
      scenario.decision_points[0];

    return {
      scenario_id: scenario.scenario_id,
      state: clone(scenario.opening_state),
      currentDecisionId: first.id,
      turn: 0,
      flags: [],
      log: [],
      narrative: scenario.opening_narrative || 'Exercise begins.'
    };
  }

  /**
   * Compute the roll modifier for an option given the current state and the
   * scenario's global difficulty modifier.
   *
   * Options can set their own modifier; state pressure then adjusts it:
   *   - high risk        -> harder (-2)
   *   - low reputation   -> harder (-1)
   *   - low morale       -> harder (-1)
   *   - scenario difficulty_modifier             -> easier/harder by config
   */
  function rollModifier(option, state, scenario) {
    let modifier = option.roll_modifier || 0;

    if (state.risk >= 75) modifier -= 2;
    if (state.reputation <= 25) modifier -= 1;
    if (state.morale <= 25) modifier -= 1;

    if (scenario.difficulty_modifier) modifier += scenario.difficulty_modifier;

    return modifier;
  }

  /** Return a shallow-cloned state with the given deltas applied and clamped. */
  function applyDeltas(state, deltas) {
    const next = clone(state);
    Object.entries(deltas).forEach(([key, value]) => {
      next[key] = clamp((next[key] || 0) + value);
    });
    return next;
  }

  /**
   * Map a raw D20 roll + modifier to an outcome tier.
   * Returns the raw roll, the modifier, the effective roll (clamped 1-20),
   * and the winning tier id + label.
   */
  function tierFor(rawRoll, modifier) {
    const effective = Math.max(1, Math.min(20, rawRoll + modifier));
    const hit = TIERS.find((t) => effective >= t[1] && effective <= t[2])[0];

    return {
      rawRoll: rawRoll,
      modifier: modifier,
      effectiveRoll: effective,
      tier: hit,
      tierLabel: TIER_LABELS[hit]
    };
  }

  /**
   * Pick the next decision point from a candidate pool, weighting each
   * candidate based on the outcome tier and current state.
   *
   * Tag-based weighting makes the scenario feel alive:
   *   - complication candidates are likelier on a MIXED roll
   *   - escalation candidates are likelier on FAIL / CRIT_FAIL
   *   - media / member / governance candidates get weight when the relevant
   *     state is in trouble
   *
   * Returns a decision point object, or null if the pool is empty (caller
   * should treat null as "exercise complete").
   */
  function pickNext(candidateIds, scenario, state, tier) {
    const candidates = candidateIds
      .map((id) => scenario.decision_points.find((d) => d.id === id))
      .filter(Boolean);

    if (candidates.length === 0) return null;

    // Build a weighted "bag": each candidate is inserted `weight` times.
    const bag = [];
    for (const point of candidates) {
      let weight = point.weight || 1;

      if (tier === 'mixed' && point.tags && point.tags.includes('complication')) weight += 3;
      if ((tier === 'fail' || tier === 'crit_fail') && point.tags && point.tags.includes('escalation')) weight += 3;
      if (state.reputation < 35 && point.tags && point.tags.includes('media')) weight += 2;
      if (state.member_confidence < 40 && point.tags && point.tags.includes('member')) weight += 2;
      if (state.risk > 70 && point.tags && point.tags.includes('governance')) weight += 2;

      for (let i = 0; i < weight; i++) bag.push(point);
    }

    return bag[Math.floor(Math.random() * bag.length)];
  }

  /**
   * Check end conditions against the current state.
   * Returns the first matching end condition, or null.
   */
  function checkEnd(state, scenario) {
    for (const condition of scenario.end_conditions || []) {
      const value = state[condition.stat];

      if (condition.operator === 'lte' && value <= condition.value) return condition;
      if (condition.operator === 'gte' && value >= condition.value) return condition;
    }

    return null;
  }

  /**
   * Resolve an option choice. This is the heart of the engine: it folds the
   * option's modifiers and the outcome-tier state deltas into the run state,
   * checks end conditions, picks the next decision point, and records a log
   * event.
   *
   * @param run         the current run (mutated into a new object)
   * @param scenario    the scenario data
   * @param optionId    the chosen option id
   * @param manual      optional forced D20 value (1-20); 0/undefined => random
   * @returns { run, event, nextDecision, endCondition }
   */
  function resolve(run, scenario, optionId, manual) {
    const point = scenario.decision_points.find((x) => x.id === run.currentDecisionId);
    const option = point.options.find((x) => x.id === optionId);

    const rawRoll = manual || Math.floor(Math.random() * 20) + 1;
    const result = tierFor(rawRoll, rollModifier(option, run.state, scenario));

    // Apply option modifiers first, then the outcome-tier state delta.
    const state = applyDeltas(
      applyDeltas(run.state, option.modifiers || {}),
      point.outcomes && point.outcomes[result.tier] ? point.outcomes[result.tier].state_delta || {} : {}
    );

    const endCondition = checkEnd(state, scenario);
    const nextDecision = endCondition ? null : pickNext(point.next || [], scenario, state, result.tier);

    const nextRun = clone(run);
    Object.assign(nextRun, {
      state: state,
      currentDecisionId: nextDecision ? nextDecision.id : null,
      turn: run.turn + 1
    });

    if (option.flag && !nextRun.flags.includes(option.flag)) {
      nextRun.flags.push(option.flag);
    }

    const event = {
      turn: nextRun.turn,
      option_label: option.label,
      rawRoll: result.rawRoll,
      modifier: result.modifier,
      effectiveRoll: result.effectiveRoll,
      tier: result.tier,
      tierLabel: result.tierLabel,
      outcome_text:
        (point.outcomes && point.outcomes[result.tier] && point.outcomes[result.tier].text) ||
        'Situation changes.',
      next_decision_id: nextDecision ? nextDecision.id : null,
      ending: endCondition ? endCondition.ending : null,
      state: clone(state)
    };

    nextRun.log.push(event);

    return {
      run: nextRun,
      event: event,
      nextDecision: nextDecision,
      endCondition: endCondition
    };
  }

  global.Engine = { validate: validate, create: create, resolve: resolve, clone: clone };
})(window);
