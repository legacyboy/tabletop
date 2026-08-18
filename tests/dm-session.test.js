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
//    until a failure end fires.
const s4 = new DMSession(new MockProvider(), scenario);
let endHit = false;
for (let i = 0; i < 40 && !endHit; i++) {
  const res = await s4.takeTurn('Escalate aggressively', 11); // fate adds risk each time
  s4.state.risk = Math.min(100, s4.state.risk + 20); // force toward threshold
  if (res.endCondition) endHit = true;
}
check('failure end fires when risk >= 90', endHit);

// 4b. Goal (win condition): when all goal thresholds are met simultaneously,
//     the scenario ends successfully.
const goalScenario = {
  ...scenario,
  goal: {
    ending: 'Crisis resolved.',
    win_conditions: [
      { stat: 'risk', operator: 'lte', value: 45 },
      { stat: 'reputation', operator: 'gte', value: 60 },
    ],
  },
};
const s4b = new DMSession(new MockProvider(), goalScenario);
let goalEnd = null;
for (let i = 0; i < 5 && !goalEnd; i++) {
  s4b.state.risk = 20;          // below 45
  s4b.state.reputation = 75;    // above 60
  const res = await s4b.takeTurn('Stabilize and reassure', 20);
  if (res.endCondition) goalEnd = res.endCondition;
}
check('goal fires when all win conditions met', goalEnd && goalEnd.result === 'success');
check('goal ending shown', goalEnd && goalEnd.ending === 'Crisis resolved.');

// 4c. Goal does NOT fire when only SOME thresholds are met.
const s4c = new DMSession(new MockProvider(), goalScenario);
let goalEarly = null;
for (let i = 0; i < 5 && !goalEarly; i++) {
  s4c.state.risk = 80;          // above 45 -> goal NOT met
  s4c.state.reputation = 75;    // above 60
  const res = await s4c.takeTurn('Stabilize and reassure', 20);
  if (res.endCondition) goalEarly = res.endCondition;
}
check('goal does NOT fire when thresholds not all met', !goalEarly);

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

// 8. Conditional events (v3): stall trigger fires after N stalled turns.
const stallScenario = {
  ...scenario,
  events: [
    { id: 'stall1', trigger: { type: 'stall', turns: 2 }, text: 'The room goes quiet.', state_delta: { morale: -5 } },
  ],
};
const s6 = new DMSession(new MockProvider(), stallScenario);
await s6.takeTurn('x', 10);   // stall turn 1 (very short action)
check('stall event NOT fired after 1 stalled turn', !s6.firedEvents.has('stall1'));
await s6.takeTurn('ok', 10);   // stall turn 2 -> fires
check('stall event fires after 2 consecutive stalled turns', s6.firedEvents.has('stall1'));
check('stall event state_delta applied', s6.state.morale === stallScenario.opening_state.morale - 5);
check('stall event recorded in history', s6.history[1].events.includes('stall1'));

// 8b. Stall counter resets on a meaningful action.
const s6b = new DMSession(new MockProvider(), stallScenario);
await s6b.takeTurn('x', 10);  // stall
await s6b.takeTurn('Issue a real statement', 10);  // meaningful -> resets
await s6b.takeTurn('x', 10);  // stall 1 again
check('stall counter resets after a meaningful action', !s6b.firedEvents.has('stall1'));

// 9. Conditional events (v3): stat trigger fires when the stat crosses threshold.
const statScenario = {
  ...scenario,
  events: [
    { id: 'stat1', trigger: { type: 'stat', stat: 'risk', operator: 'gte', value: 60 }, text: 'Regulator calls.', state_delta: { regulator_confidence: -5 } },
  ],
};
const s7 = new DMSession(new MockProvider(), statScenario);
s7.state.risk = 30;
await s7.takeTurn('Act', 10);
check('stat event NOT fired below threshold', !s7.firedEvents.has('stat1'));
s7.state.risk = 70;  // cross threshold
await s7.takeTurn('Act', 10);
check('stat event fires when stat crosses threshold', s7.firedEvents.has('stat1'));
check('stat event state_delta applied', s7.state.regulator_confidence === statScenario.opening_state.regulator_confidence - 5);

// 9b. Fired events do NOT re-fire on subsequent turns.
const before = s7.state.regulator_confidence;
await s7.takeTurn('Act', 10);  // risk still >= 60, but event already fired
check('fired event does NOT re-fire', s7.state.regulator_confidence === before);

// 10. serialize/restore persist fired event ids (no re-fire after restore).
const snap = s7.serialize();
check('serialize includes firedEvents', Array.isArray(snap.firedEvents) && snap.firedEvents.includes('stat1'));
const restored = DMSession.restore(new MockProvider(), statScenario, snap);
restored.state.risk = 80;  // still above threshold
await restored.takeTurn('Act', 10);
check('restored session does NOT re-fire a previously fired event', !restored.history[0].events.includes('stat1'));

// 11. Turn trigger fires on a specific turn number.
const turnScenario = {
  ...scenario,
  events: [
    { id: 'turn1', trigger: { type: 'turn', turn: 3 }, text: 'An influencer amplifies the clip.', state_delta: { reputation: -3 } },
  ],
};
const s8 = new DMSession(new MockProvider(), turnScenario);
await s8.takeTurn('Act', 10);  // turn 1
await s8.takeTurn('Act', 10);  // turn 2
check('turn event NOT fired before its turn', !s8.firedEvents.has('turn1'));
await s8.takeTurn('Act', 10);  // turn 3 -> fires
check('turn event fires on its turn number', s8.firedEvents.has('turn1'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
