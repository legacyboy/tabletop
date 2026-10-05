/**
 * ENDGAME DRIVE — can a session actually be FINISHED?
 *
 * Every other live test stops after N turns. This one drives a session all the
 * way to each of the three terminal states and asserts the ending + report:
 *
 *   WIN      — all goal win_conditions met  -> endCondition.type='goal', result='success'
 *   LOSS     — narrative collapse (loss stats in the failure zone N turns) -> result='loss'
 *   TIMEOUT  — the timer expires -> type='timeout'
 *
 * It uses a PROGRAMMABLE provider (deterministic DM JSON) so the terminal
 * states are reached reliably, then runs ONE real-model session to the same
 * end-game code path to prove the prose pipeline survives a real ending.
 *
 * Usage:
 *   DM_MODEL=deepseek-v4.1-flash:cloud node tests/endgame-drive.mjs
 */
import { readFileSync } from 'node:fs';
import { DMSession } from '../app/js/dm.js';
import { buildReport, renderReportHtml } from '../server/report.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const SCENARIO_ID = process.env.SCENARIO || 'bramble_badger_deepfake';
const ROOT = new URL('../', import.meta.url).pathname;
const registry = JSON.parse(readFileSync(`${ROOT}scenarios/registry.json`, 'utf8'));
const entry = registry.find((e) => e.id === SCENARIO_ID);
const loadScenario = () => JSON.parse(readFileSync(ROOT + entry.path, 'utf8'));

const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

/**
 * Programmable provider. `plan` is a function(turnIndex) -> object of state
 * deltas the fake DM "wants". The provider returns strict DM JSON whose
 * `state_delta` is that object, so we control the arc precisely.
 */
function makeProgrammable(plan) {
  let calls = 0;
  return {
    calls: () => calls,
    async chat(messages) {
      const idx = calls++;
      const isOpening = /opening scene, turn 0/.test(messages[1].content);
      if (isOpening) {
        return JSON.stringify({ narrative: 'A deepfake of the CEO is spreading. The board is panicking and the press is calling. What do you do?' });
      }
      // The opening consumed idx 0; the first real turn is idx 1, so expose a
      // 0-based turn index to the plan.
      const turnIdx = idx - 1;
      const delta = plan(turnIdx) || {};
      return JSON.stringify({
        narrative: 'The team executes. ' + 'Pressure shifts across the crisis. '.repeat(2),
        state_delta: delta,
        beat_judgment: { quality: 'good' },
      });
    },
  };
}

async function drive(provider, { turns = 12 } = {}) {
  const s = new DMSession(provider, loadScenario());
  s.companyInfo = 'A mid-sized member-owned credit union.';
  await s.openScene();
  let end = null;
  for (let i = 0; i < turns && !end; i++) {
    // Avoid fate rolls (1/11/20) so the driven arc isn't perturbed by twists.
    const roll = ((i * 5 + 2) % 20) + 1;
    const safe = roll === 1 || roll === 11 || roll === 20 ? 7 : roll;
    const res = await s.takeTurn('We take decisive coordinated action.', safe);
    if (res.endCondition) end = res.endCondition;
  }
  return { s, end };
}

console.log(`\n############ ENDGAME DRIVE — ${SCENARIO_ID} ############\n`);

// ---- WIN: push every win_condition above threshold -------------------------
const scen = loadScenario();
const goal = scen.goal;
record('scenario has a goal with win_conditions', !!(goal && goal.win_conditions && goal.win_conditions.length), `${goal ? goal.win_conditions.length : 0} conds`);
if (goal && goal.win_conditions.length) {
  const winDelta = {};
  for (const c of goal.win_conditions) {
    // overshoot: gte 65 -> +15/turn (the per-turn cap), lte 20 -> -15/turn
    winDelta[c.stat] = c.operator === 'gte' ? 15 : -15;
  }
  const { end: winEnd } = await drive(makeProgrammable(() => winDelta));
  record('WIN reached', !!winEnd && winEnd.type === 'goal' && winEnd.result === 'success', winEnd ? `${winEnd.type}/${winEnd.result}` : 'no end');
  if (winEnd) {
    record('win ending is the authored goal ending', winEnd.ending === goal.ending, String(winEnd.ending).slice(0, 50));
  }
}

// ---- LOSS: narrative collapse ----------------------------------------------
const lossCond = (scen.end_conditions || []).find((c) => c.type === 'stat' && (c.result === undefined || c.result === 'loss'));
const lossStats = lossCond ? (lossCond.stats || [lossCond]).map((x) => x.stat) : ['public_trust', 'regulator_confidence'];
const consec = (lossCond && lossCond.consecutive) || 2;
{
  const lossDelta = {};
  for (const st of lossStats) lossDelta[st] = -15; // drive into the <=20 failure zone
  const { end: lossEnd, s: lossS } = await drive(makeProgrammable(() => lossDelta));
  record('LOSS reached (narrative collapse)', !!lossEnd && lossEnd.result === 'loss', lossEnd ? lossEnd.type : 'no end');
  if (lossEnd) {
    record('loss ending is the authored collapse text', lossEnd.ending === (lossCond && lossCond.ending), lossEnd.ending ? String(lossEnd.ending).slice(0, 50) + '...' : '-');
    record('collapse fired only after the consecutive streak', lossS.turn >= consec, `ended turn ${lossS.turn}`);
  }
}

// ---- TIMEOUT ---------------------------------------------------------------
{
  const s = new DMSession(makeProgrammable(() => ({})), loadScenario());
  s.durationSeconds = 1; // short timer
  s.start();
  await new Promise((r) => setTimeout(r, 1300));
  const tEnd = s.timeoutEnd ? s.timeoutEnd() : null;
  s.stopTimer();
  const timeoutCond = (scen.end_conditions || []).find((c) => c.type === 'timeout');
  record('TIMEOUT end fires', !!tEnd && tEnd.type === 'timeout', tEnd ? tEnd.type : 'null');
  record('timeout ending is the authored text', !!tEnd && tEnd.ending === timeoutCond.ending, tEnd ? String(tEnd.ending).slice(0, 50) : '-');
}

// ---- Report survives a real ending -----------------------------------------
{
  const winProvider = makeProgrammable(() => Object.fromEntries(goal.win_conditions.map((c) => [c.stat, c.operator === 'gte' ? 15 : -15])));
  const { s, end } = await drive(winProvider);
  if (end) {
    const report = buildReport(s, { ending: end });
    const html = renderReportHtml(report);
    record('report builds on a WIN ending', !!report && !!report.part1_audit);
    record('report end condition recorded', !!report.part2_proof.end_condition, typeof report.part2_proof.end_condition === 'object' ? `${report.part2_proof.end_condition.type}/${report.part2_proof.end_condition.result}` : String(report.part2_proof.end_condition));
    record('HTML renders the ending', html.length > 5000 && /Proof of Play/.test(html));
  } else {
    record('report builds on a WIN ending', false, 'no win end produced');
  }
}

// ---- ONE real-model session to an ending -----------------------------------
console.log('\n  --- real-model endgame run ---');
try {
  const { OpenAICompatibleProvider } = await import('../app/js/providers/openai-compatible.js');
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
  const s = new DMSession(provider, loadScenario());
  s.companyInfo = 'A mid-sized member-owned credit union.';
  const open = await s.openScene();
  record('real model opening ok', !!open && open.trim().length > 100, `${open.length} chars`);
  // Play deliberately BADLY to try to reach a loss/collapse with the real model.
  const BAD = [
    'We do nothing and hope it blows over.',
    'We deny everything publicly and attack the journalists.',
    'We ignore the regulator and delete the evidence.',
    'We stay silent and refuse to comment.',
    'We double down and insult the members.',
    'We do nothing again.',
  ];
  let end = null, cleanTurns = 0, totalTurns = 0;
  for (let i = 0; i < 12 && !end; i++) {
    const res = await s.takeTurn(BAD[i % BAD.length], 1); // roll 1 = critical failure
    const n = (res.narrative || '').trim();
    totalTurns++;
    // "Clean" = the narrative rendered as prose and ends on terminal punctuation
    // (the truncation bug showed a mid-paragraph cutoff). No raw JSON leakage.
    const endsClean = /[.!?"')\]]$/.test(n);
    const noLeak = !/^\s*[{\[]/.test(n) && !/"narrative"\s*:/.test(n);
    if (n.length > 80 && endsClean && noLeak) cleanTurns++;
    if (res.endCondition) end = res.endCondition;
  }
  record('real model: no truncated/leaked narratives through the run', cleanTurns === totalTurns, `${cleanTurns}/${totalTurns} clean`);
  record('real model: reached a terminal state OR ran the arc', !!end || s.turn >= 12, end ? `${end.type}/${end.result}` : `${s.turn} turns, no end`);
  const rep = buildReport(s, { ending: end });
  record('real model: report builds at endgame', !!rep, `final trust=${s.state.public_trust} reg=${s.state.regulator_confidence}`);
} catch (e) {
  record('real model endgame run', false, e.message);
}

// ---- summary ---------------------------------------------------------------
const pass = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${pass}/${results.length} passed ############`);
for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.n}: ${f.d}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
