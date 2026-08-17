/**
 * Function test of the DM session loop with a MOCK provider (no real LLM).
 * Verifies: state tracking, fate-table firing, narrative extraction, end
 * condition detection, timeout, and report generation.
 */
import { DMSession } from '../app/js/dm.js';
import { readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

/** A fake provider that returns a fixed JSON judgment with a small narrative. */
class MockProvider {
  constructor() {}
  async chat(messages, opts = {}) {
    const userMsg = messages[messages.length - 1].content;
    const rollMatch = userMsg.match(/got: (\d+)/);
    const roll = rollMatch ? Number(rollMatch[1]) : 15;
    // Return a durable narrative string; state_delta scaled by roll magnitude a bit.
    return JSON.stringify({
      narrative: `The team handled turn ${roll}: a measured response. Consequences applied.`,
      state_delta: roll >= 20 ? { reputation: 6, morale: 4 } : roll <= 1 ? { reputation: -10, risk: 8 } : { reputation: 1 },
    });
  }
}

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name); } };

// 1. Basic turn resolves and updates state
const s1 = new DMSession(new MockProvider(), scenario);
s1.start();
const r1 = await s1.takeTurn('Issue a calm public statement', 15);
check('narrative returned', typeof r1.narrative === 'string' && r1.narrative.length > 0);
check('turn incremented', s1.turn === 1);
check('state is object', typeof r1.state === 'object');
check('history length', s1.history.length === 1);

// 2. Fate table fires on roll 11
const s2 = new DMSession(new MockProvider(), scenario);
await s2.takeTurn('Reassure members', 11);
check('fate event recorded on 11', s2.history[0].fate !== null);
check('risk increased from fate delta', s2.state.risk > scenario.opening_state.risk);

// 3. Fate on 1 (crit fail)
const s3 = new DMSession(new MockProvider(), scenario);
await s3.takeTurn('Do nothing', 1);
check('fate on 1', s3.history[0].fate !== null);
check('reputation dropped on 1', s3.state.reputation < scenario.opening_state.reputation);

// 4. End condition detection: drive risk up via repeated low rolls + fate
//    (min_turns=0 so the stat end can fire immediately — this test checks
//    detection, not the minimum-duration floor).
const s4 = new DMSession(new MockProvider(), { ...scenario, min_turns: 0 });
let endHit = false;
for (let i = 0; i < 12 && !endHit; i++) {
  const res = await s4.takeTurn('Escalate aggressively', 11); // fate adds risk each time
  s4.state.risk = Math.min(100, s4.state.risk + 20); // force toward threshold
  if (res.endCondition) endHit = true;
}
check('end condition fires when risk >= 90', endHit);

// 4b. Minimum-duration floor: with min_turns set, a stat end does NOT fire early.
const s4b = new DMSession(new MockProvider(), { ...scenario, min_turns: 20 });
let earlyEnd = false;
for (let i = 0; i < 10; i++) {
  const res = await s4b.takeTurn('Escalate aggressively', 11);
  s4b.state.risk = Math.min(100, s4b.state.risk + 20); // force toward threshold
  if (res.endCondition) earlyEnd = true;
}
check('stat end does NOT fire before min_turns', !earlyEnd);
check('min_turns floor respected (turn < 20)', s4b.turn < 20);

// 5. Timeout end condition
const timeout = s4.timeoutEnd();
check('timeout end has ending', timeout && timeout.ending);

// 6. Report generation
const report = s4.buildReport({ ending: 'Risk overload.' });
check('report has turns', report.turns >= 1);
check('report has log', Array.isArray(report.log) && report.log.length > 0);
check('report has final_state', !!report.final_state);

// 7. Clamp: state never exceeds 100
const s5 = new DMSession(new MockProvider(), scenario);
for (let i = 0; i < 5; i++) {
  await s5.takeTurn('Push hard', 20);
  s5.state.risk = Math.min(100, s5.state.risk + 50);
}
for (const [k, v] of Object.entries(s5.state)) {
  check(`clamp ${k} <= 100`, v <= 100);
  check(`clamp ${k} >= 0`, v >= 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
