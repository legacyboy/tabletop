/**
 * Function tests for the IT / Backdoors & Breaches mode (BnbSession + decks).
 * No LLM: a mock provider returns a fixed narrative; the mechanics under test
 * are deterministic and owned by the session.
 */
import { BnbSession } from '../app/js/bnb-session.js';
import { drawAttackPath, drawProcedureHand, drawInject, ATTACK_CATEGORIES, _decks } from '../app/js/bnb-mode.js';

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
};

class MockProvider {
  async chat() { return JSON.stringify({ narrative: 'The team works the case.' }); }
}

// A deterministic RNG (mulberry32) so draws/reveals are reproducible.
function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Decks ---------------------------------------------------------------
const path = drawAttackPath(rngFor(1));
check('attack path has four categories', path.length === 4);
check('attack path covers every category once',
  ATTACK_CATEGORIES.every((c) => path.filter((p) => p.category === c.id).length === 1));
check('attack cards start hidden', path.every((p) => p.revealed === false));
check('attack cards carry a name + symptom', path.every((p) => p.name && p.symptom));
const hand = drawProcedureHand(3, rngFor(2));
check('procedure hand has 3 distinct cards', hand.length === 3 && new Set(hand.map((h) => h.id)).size === 3);
const inj = drawInject(new Set(), rngFor(3));
check('inject draw has text + tone', !!inj.text && !!inj.tone);
check('inject avoids already-fired ids', (() => {
  const fired = new Set(_decks.INJECT_DECK.map((c) => c.id));
  const only = drawInject(fired, rngFor(4));
  return !!only.id; // falls back to the full deck when all are fired
})());

// --- Core round mechanics ------------------------------------------------
const mk = (opts = {}) => new BnbSession(new MockProvider(), { rng: rngFor(10), maxRounds: 10, ...opts });

const s1 = mk(); s1.start();
check('starts with 4 uncontained', s1.uncontainedCount() === 4);

// Success (11+) reveals the targeted category.
let r = await s1.resolveRound(s1.procedureHand[0].id, 15, 'initial');
check('roll 15 succeeds', r.success === true);
check('success reveals the targeted category', r.revealed && r.revealed.category === 'initial');
check('revealed card is marked revealed', s1.attackPath.find((c) => c.category === 'initial').revealed === true);
check('uncontained count drops to 3', s1.uncontainedCount() === 3);

// Failure does not reveal.
const s2 = mk(); s2.start();
r = await s2.resolveRound(s2.procedureHand[0].id, 10, 'initial');
check('roll 10 fails (threshold is 11)', r.success === false);
check('failure reveals nothing', r.revealed === null);
check('failure increments the fail streak', s2.failStreak === 1);

// Natural 1 -> inject, no reveal.
const s3 = mk(); s3.start();
r = await s3.resolveRound(s3.procedureHand[0].id, 1, 'initial');
check('natural 1 is a failure', r.success === false);
check('natural 1 fires an inject', !!r.inject && !!r.inject.id);
check('natural 1 reveals nothing', r.revealed === null);
check('inject is logged', s3.injectLog.length === 1);

// Natural 20 -> success + reveal + inject.
const s4 = mk(); s4.start();
r = await s4.resolveRound(s4.procedureHand[0].id, 20, 'pivot');
check('natural 20 succeeds', r.success === true);
check('natural 20 reveals the target', r.revealed && r.revealed.category === 'pivot');
check('natural 20 fires an inject', !!r.inject && !!r.inject.id);

// Three failures in a row -> inject on the third.
const s5 = mk(); s5.start();
await s5.resolveRound(s5.procedureHand[0].id, 5);
await s5.resolveRound(s5.procedureHand[0].id, 6);
check('after two failures no inject yet', s5.injectLog.length === 0);
r = await s5.resolveRound(s5.procedureHand[0].id, 7);
check('third consecutive failure fires an inject', !!r.inject && s5.injectLog.length === 1);
check('fail streak resets after the inject', s5.failStreak === 0);

// Success resets the fail streak.
const s6 = mk(); s6.start();
await s6.resolveRound(s6.procedureHand[0].id, 5);
await s6.resolveRound(s6.procedureHand[0].id, 17, 'initial');
check('a success resets the fail streak', s6.failStreak === 0);

// --- End conditions ------------------------------------------------------
// Win: reveal all four.
const s7 = mk(); s7.start();
let last;
for (const cat of ['initial', 'pivot', 'persist', 'c2']) last = await s7.resolveRound(s7.procedureHand[0].id, 16, cat);
check('uncovering all four ends in a win', last.endCondition && last.endCondition.type === 'bnb_win' && last.endCondition.result === 'success');
check('win ending lists the full attack path', last.endCondition.attack_path.length === 4);

// Loss: round cap with cards hidden.
const s8 = new BnbSession(new MockProvider(), { rng: rngFor(11), maxRounds: 3 }); s8.start();
for (let i = 0; i < 3; i++) last = await s8.resolveRound(s8.procedureHand[0].id, 5);
check('round cap with cards hidden ends in a loss', last.endCondition && last.endCondition.type === 'bnb_loss' && last.endCondition.result === 'loss');

// --- Randomness / replay -------------------------------------------------
const a = drawAttackPath(rngFor(100)).map((p) => p.name).join('|');
const b = drawAttackPath(rngFor(200)).map((p) => p.name).join('|');
check('different seeds produce different attack paths', a !== b);

// --- Validation ----------------------------------------------------------
let threw = false;
try { await s1.resolveRound(s1.procedureHand[0].id, 25); } catch { threw = true; }
check('rejects an out-of-range roll', threw);

// --- Serialise / restore -------------------------------------------------
const snap = s7.serialize();
const restored = BnbSession.restore(new MockProvider(), snap);
check('restore preserves round + attack path', restored.round === s7.round && restored.uncontainedCount() === s7.uncontainedCount());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
