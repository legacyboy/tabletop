/**
 * BNB Session — the IT / Backdoors & Breaches-style incident run.
 *
 * A separate orchestrator from the executive DMSession. Where the executive
 * version plays a paced story arc, this one mirrors Backdoors & Breaches:
 *
 *   - The Incident Master draws a HIDDEN attack path: one card from each of
 *     four categories (Initial Compromise, Pivot & Escalate, Persistence,
 *     C2 & Exfil).
 *   - Each round the Defenders pick a Procedure (a detection/response
 *     capability) and roll a d20. 11+ succeeds.
 *   - A successful Procedure that matches the category the group is hunting
 *     REVEALS that hidden attack card.
 *   - A natural 1 or 20, or three failures in a row, triggers a random INJECT.
 *   - The Defenders WIN by revealing all four attack cards (contained) before
 *     the round cap; they LOSE if the round cap runs out with cards unrevealed.
 *
 * The LLM (DM) narrates the fiction and adjudicates what a Procedure actually
 * finds; this class owns the deterministic mechanics so they are testable.
 */
import {
  ATTACK_CATEGORIES,
  drawAttackPath,
  drawProcedureHand,
  drawProcedure,
  drawInject,
} from './bnb-mode.js';

const MAX_ROUNDS_DEFAULT = 10;
const SUCCESS_THRESHOLD = 11;   // d20 total >= 11 succeeds
const FAIL_STREAK_INJECT = 3;   // 3 failures in a row -> inject

export class BnbSession {
  /**
   * @param {object} provider  .chat(messages, opts) LLM provider (narration)
   * @param {object} [opts]    { targetCompany, maxRounds, rng, scenarioHint }
   */
  constructor(provider, opts = {}) {
    if (!provider || typeof provider.chat !== 'function') {
      throw new Error('BnbSession requires a provider with .chat()');
    }
    this.provider = provider;
    this.rng = opts.rng || Math.random;
    this.maxRounds = opts.maxRounds || MAX_ROUNDS_DEFAULT;
    this.targetCompany = opts.targetCompany || '';
    this.scenarioHint = opts.scenarioHint || '';

    this.attackPath = drawAttackPath(this.rng);   // hidden kill chain
    this.procedureHand = drawProcedureHand(3, this.rng);
    this.inject = null;                            // active inject for this round
    this.firedInjectIds = new Set();
    this.injectLog = [];

    this.round = 0;
    this.failStreak = 0;
    this.history = [];
    this.startedAt = null;
    this.durationSeconds = (opts.minutes || 60) * 60;
    this._revealedOrder = [];
  }

  /** Categories still hidden (what the group can still uncover). */
  hiddenCategories() {
    return this.attackPath.filter((c) => !c.revealed).map((c) => ({
      id: c.category,
      name: c.category_name,
      prompt: (ATTACK_CATEGORIES.find((x) => x.id === c.category) || {}).prompt,
    }));
  }

  revealedCards() {
    return this.attackPath.filter((c) => c.revealed);
  }

  /** How many of the four hidden cards are still unrevealed. */
  uncontainedCount() {
    return this.attackPath.filter((c) => !c.revealed).length;
  }

  /** Refill the Defenders' procedure hand (called at the top of each round). */
  refillHand() {
    this.procedureHand = drawProcedureHand(3, this.rng);
    return this.procedureHand;
  }

  start() {
    this.startedAt = Date.now();
  }

  secondsLeft() {
    if (!this.startedAt || !this.durationSeconds) return null;
    return Math.max(0, this.durationSeconds - Math.floor((Date.now() - this.startedAt) / 1000));
  }

  /**
   * Resolve one round.
   * @param {string} procedureId  which procedure from the hand was played
   * @param {number} roll         the d20 the group rolled (1-20)
   * @param {string} [categoryId] the category the group is targeting, if any
   * @param {string} [note]       free-text what the group is looking for
   * @returns {{ narrative:string, roll:number, success:boolean, revealed:object|null,
   *            inject:object|null, round:number, endCondition:object|null }}
   */
  async resolveRound(procedureId, roll, categoryId = null, note = '') {
    if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error('D20 roll must be 1-20.');
    const proc = this.procedureHand.find((p) => p.id === procedureId)
      || drawProcedure(this.rng); // tolerate an id not in the current hand

    this.round += 1;
    const success = roll >= SUCCESS_THRESHOLD;

    // Reveal logic: on success, if the group targeted a still-hidden category
    // (or there is exactly one obvious lead), reveal that card. The DM narrates
    // the find. A natural 20 is a clean reveal; a plain success reveals too.
    let revealed = null;
    if (success) {
      this.failStreak = 0;
      let target = null;
      if (categoryId) {
        target = this.attackPath.find((c) => c.category === categoryId && !c.revealed);
      }
      if (!target) {
        // Fall back to the first still-hidden card so a success always advances
        // the case (the DM can decide which lead it maps to).
        target = this.attackPath.find((c) => !c.revealed) || null;
      }
      if (target) {
        target.revealed = true;
        this._revealedOrder.push(target.category);
        revealed = target;
      }
    } else {
      this.failStreak += 1;
    }

    // INJECT: natural 1, natural 20, or three failures in a row.
    let inject = null;
    const natCrit = roll === 1 || roll === 20;
    if (natCrit || this.failStreak >= FAIL_STREAK_INJECT) {
      inject = drawInject(this.firedInjectIds, this.rng);
      this.firedInjectIds.add(inject.id);
      this.inject = inject;
      this.injectLog.push({ round: this.round, id: inject.id, text: inject.text, tone: inject.tone });
      this.failStreak = 0;   // fires once, then the streak resets
    } else {
      this.inject = null;
    }

    // Narrate with the LLM (best-effort; mechanics already decided).
    let narrative = '';
    try {
      narrative = await this._narrate({ proc, roll, success, revealed, inject, note });
    } catch (err) {
      narrative = this._fallbackNarrative({ proc, roll, success, revealed, inject });
    }

    this.history.push({
      round: this.round, procedure: proc, roll, success,
      target_category: categoryId || null,
      revealed: revealed ? { category: revealed.category, name: revealed.name } : null,
      inject: inject ? { id: inject.id, text: inject.text, tone: inject.tone } : null,
      note: note || '', narrative, ts: Date.now(),
    });

    const endCondition = this._checkEnd();
    return { narrative, roll, success, revealed, inject, round: this.round, endCondition };
  }

  async _narrate({ proc, roll, success, revealed, inject, note }) {
    const hidden = this.hiddenCategories();
    const known = this.revealedCards();
    const system = [
      'You are the Incident Master (facilitator) of an IT / incident-response tabletop exercise.',
      'This is a Backdoors & Breaches-style game: the defenders run procedures and roll a d20 (11+ succeeds) to uncover a hidden attack path of four stages.',
      'Narrate in tense, concrete, blue-team prose. NEVER name hidden attack cards the group has not revealed. Do NOT present a menu of choices or tell them what to do.',
      'Keep the fiction technical and realistic (real tool names, real telemetry, real TTPs where they fit). 3-6 sentences.',
    ].join(' ');
    const user = [
      `Round ${this.round} of ${this.maxRounds}.${this.targetCompany ? ` Environment: ${this.targetCompany}.` : ''}`,
      `Defenders ran procedure: "${proc.name}" (${proc.skill}).`,
      `They rolled ${roll} on a d20 — ${success ? 'SUCCESS (11+)' : 'FAILURE (below 11)'}.`,
      revealed
        ? `RESULT: the procedure uncovered this attack-path stage — [${revealed.category_name}] "${revealed.name}". What they observed: ${revealed.symptom}. Narrate the discovery.`
        : (success
            ? 'RESULT: the procedure ran successfully but did not land on the hidden attack path — it confirmed the environment and ruled something out, without revealing a hidden stage.'
            : 'RESULT: the procedure failed — the noise, the wrong place, or the attacker noticing. Describe the wasted effort or the friction.'),
      inject ? `INJECT (a random twist fires now): ${inject.text} Weave it into the scene.` : '',
      this.failStreak >= FAIL_STREAK_INJECT ? 'NOTE: the defenders are on a losing streak — the pressure should feel real.' : '',
      known.length ? `Already uncovered: ${known.map((c) => c.name).join(', ')}.` : '',
      hidden.length ? `Still hidden (do not name these): ${hidden.map((h) => h.name).join(', ')}.` : 'All attack-path stages uncovered.',
      note ? `The group said they are looking for: "${note}".` : '',
      'Reply with STRICT JSON: {"narrative": "<3-6 sentences>"} and nothing else.',
    ].filter(Boolean).join('\n');

    const raw = await this.provider.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.8, maxTokens: 2048 }
    );
    const parsed = this._extractJson(raw);
    return String(parsed.narrative || raw || '').trim() || this._fallbackNarrative({ proc, roll, success, revealed, inject });
  }

  _fallbackNarrative({ proc, roll, success, revealed, inject }) {
    const bits = [];
    bits.push(`The team ran ${proc.name} and rolled ${roll}.`);
    if (revealed) bits.push(`The procedure uncovered the ${revealed.category_name} stage: ${revealed.symptom}`);
    else if (success) bits.push('The procedure came back clean on the hidden path — useful, but no new stage fell out.');
    else bits.push('The procedure fell flat — the trail went cold.');
    if (inject) bits.push(`Then the situation shifted: ${inject.text}`);
    return bits.join(' ');
  }

  _extractJson(raw) {
    if (typeof raw !== 'string') return {};
    let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch { /* */ }
    const open = s.indexOf('{'), close = s.lastIndexOf('}');
    if (open !== -1 && close > open) {
      try { const o = JSON.parse(s.slice(open, close + 1)); if (o && typeof o === 'object') return o; } catch { /* */ }
    }
    return {};
  }

  _checkEnd() {
    const open = this.uncontainedCount();
    if (open === 0) {
      return {
        type: 'bnb_win', result: 'success',
        ending: `The defenders uncovered the full attack path in ${this.round} round${this.round === 1 ? '' : 's'}: ` +
          this.attackPath.map((c) => `${c.category_name} — ${c.name}`).join('; ') + '.',
        attack_path: this.attackPath.map((c) => ({ category: c.category_name, name: c.name, symptom: c.symptom })),
      };
    }
    if (this.round >= this.maxRounds) {
      return {
        type: 'bnb_loss', result: 'loss',
        ending: `The round cap was reached with ${open} attack-path stage${open === 1 ? '' : 's'} still hidden — the attackers kept their foothold. ` +
          `Uncovered: ${this.revealedCards().map((c) => c.name).join(', ') || 'nothing'}.`,
        attack_path: this.attackPath.map((c) => ({ category: c.category_name, name: c.name, symptom: c.symptom })),
      };
    }
    return null;
  }

  /** Serialise for a resumable snapshot. */
  serialize() {
    return {
      attackPath: this.attackPath,
      procedureHand: this.procedureHand,
      firedInjectIds: [...this.firedInjectIds],
      injectLog: this.injectLog,
      round: this.round,
      failStreak: this.failStreak,
      maxRounds: this.maxRounds,
      targetCompany: this.targetCompany,
      history: this.history,
      startedAt: this.startedAt,
      durationSeconds: this.durationSeconds,
      _revealedOrder: this._revealedOrder,
    };
  }

  static restore(provider, snap) {
    const s = new BnbSession(provider, { maxRounds: snap.maxRounds, targetCompany: snap.targetCompany });
    s.attackPath = snap.attackPath || s.attackPath;
    s.procedureHand = snap.procedureHand || s.procedureHand;
    s.firedInjectIds = new Set(snap.firedInjectIds || []);
    s.injectLog = snap.injectLog || [];
    s.round = snap.round || 0;
    s.failStreak = snap.failStreak || 0;
    s.history = snap.history || [];
    s.startedAt = snap.startedAt || null;
    s.durationSeconds = snap.durationSeconds || s.durationSeconds;
    s._revealedOrder = snap._revealedOrder || [];
    return s;
  }
}
