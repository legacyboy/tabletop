/**
 * Function test of the DM session loop with a MOCK provider (no real LLM).
 * Verifies: state tracking, fate-table firing, narrative extraction, end
 * condition detection, timeout, report generation, attack-chain reveal/contain,
 * roll modifiers, breach state, and random mode.
 */
import { DMSession } from '../app/js/dm.js';
import { readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

/** A fake provider that returns a fixed JSON judgment with a small narrative. */
class MockProvider {
  constructor(opts = {}) {
    // Optional: force the DM's progress judgment. Defaults to true (progress).
    this.progress = opts.progress;
    // Optional: force reveal/contain stage ids.
    this.reveal = opts.reveal;
    this.contain = opts.contain;
    // Optional: force the DM's beat transition (advance the story arc).
    this.beat = opts.beat;
    this.beatQuality = opts.beat_quality;
  }
  async chat(messages, opts = {}) {
    const userMsg = messages[messages.length - 1].content;
    const rollMatch = userMsg.match(/got: (\d+)/);
    const roll = rollMatch ? Number(rollMatch[1]) : 15;
    const reply = {
      narrative: `The team handled turn ${roll}: a measured response. Consequences applied.`,
      state_delta: roll >= 20 ? { public_trust: 6, containment: 4 } : roll <= 1 ? { public_trust: -10 } : { public_trust: 1 },
    };
    if (this.progress !== undefined) reply.progress = this.progress;
    if (this.reveal) reply.reveal_stage = this.reveal;
    if (this.contain) reply.contain_stage = this.contain;
    if (this.beat) reply.beat = this.beat;
    if (this.beatQuality) reply.beat_quality = this.beatQuality;
    return JSON.stringify(reply);
  }
}

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name); } };

// Story-win model (Dan's design 2026-10-05): the numeric win_conditions are
// ADVISORY only \u2014 they must be explicitly marked as such so nobody mistakes
// them for a pass/fail gate again.
check('goal win_conditions are marked advisory (not a gate)',
  typeof scenario.goal.win_conditions_note === 'string' && /advisory/i.test(scenario.goal.win_conditions_note));
check('goal defines a story ending (used when the arc resolves)',
  typeof scenario.goal.ending === 'string' && scenario.goal.ending.length > 0);

// 1. Basic turn resolves and updates state
const s1 = new DMSession(new MockProvider(), scenario);
s1.start();
const r1 = await s1.takeTurn('Issue a calm public statement', 15);
check('narrative returned', typeof r1.narrative === 'string' && r1.narrative.length > 0);
check('turn incremented', s1.turn === 1);
check('state is object', typeof r1.state === 'object');
check('history length', s1.history.length === 1);

// 2. Fate table fires on roll 11 (a GOOD twist now - Dan's design, 2026-10-07)
const s2 = new DMSession(new MockProvider(), scenario);
await s2.takeTurn('Reassure members', 11);
check('fate event recorded on 11', s2.history[0].fate !== null);
check('fate delta applied on 11 (public_trust rose - good twist)', s2.state.public_trust > scenario.opening_state.public_trust);

// 2b. Fate table fires on roll 5 (a BAD one), so both directions exist.
const s2b = new DMSession(new MockProvider(), scenario);
await s2b.takeTurn('Stumble through the response', 5);
check('fate event recorded on 5', s2b.history[0].fate !== null);
check('fate delta applied on 5 (public_trust dropped - bad fate)', s2b.state.public_trust < scenario.opening_state.public_trust);

// 2c. The fate table has a real SPREAD and both good and bad outcomes, so a roll
// can plausibly land either way (Dan's design, 2026-10-07).
{
  const ft = scenario.fate_table || {};
  const keys = Object.keys(ft).map(Number).sort((a, b) => a - b);
  const sums = keys.map((k) => Object.values(ft[k].state_delta || {}).reduce((a, b) => a + b, 0));
  check('fate table spans at least 6 D20 slots', keys.length >= 6, `keys=${keys.join(',')}`);
  check('fate table includes BAD outcomes (net-negative deltas)', sums.some((v) => v < 0));
  check('fate table includes GOOD outcomes (net-positive deltas)', sums.some((v) => v > 0));
  check('fate table has both a low failure and a high success', !!ft['1'] && !!ft['20']);
  // Every scenario must carry this spread, not just the deepfake one.
  for (const name of ['executive-scandal', 'rogue-ai', 'toxic-workplace-viral-post', 'whistleblower']) {
    const sc = JSON.parse(readFileSync(`scenarios/${name}/scenario.json`, 'utf8'));
    const t = sc.fate_table || {};
    const s = Object.keys(t).map((k) => Object.values(t[k].state_delta || {}).reduce((a, b) => a + b, 0));
    check(`scenario '${name}' fate table is spread with good and bad`, Object.keys(t).length >= 6 && s.some((v) => v > 0) && s.some((v) => v < 0));
  }
}

// 3. Fate on 1 (crit fail)
const s3 = new DMSession(new MockProvider(), scenario);
await s3.takeTurn('Do nothing', 1);
check('fate on 1', s3.history[0].fate !== null);
check('public_trust dropped on 1', s3.state.public_trust < scenario.opening_state.public_trust);

// 4. End conditions: a single bad stat does NOT end the game (Dan's design:
//    no instant loss on one metric hitting a threshold). NOR does the NARRATIVE
//    COLLAPSE end it (Dan's design, 2026-10-05): even with every metric at 0 the
//    group must still be able to play the story to its resolution, so the
//    collapse is in-story pressure that only downgrades the win quality.
//    NOTE: beats are stripped here so the arc cannot auto-advance to a story
//    win mid-loop — this block is about the METRICS, not the arc.
const s4 = new DMSession(new MockProvider(), { ...scenario, beats: undefined });
let endHit = false;
for (let i = 0; i < 10 && !endHit; i++) {
  const res = await s4.takeTurn('Escalate aggressively', 5); // fate 5 chips public_trust each turn
  s4.state.containment = Math.min(100, s4.state.containment + 20); // force ONE metric to the ceiling
  if (res.endCondition) endHit = true;
}
check('single stat at 100 does NOT end the game (no instant loss)', !endHit);

// 4b. Narrative collapse: BOTH confidence stats critically low for
//     `consecutive` turns flags a collapse but does NOT end the session — the
//     story must stay playable to its resolution.
const s4L = new DMSession(new MockProvider(), scenario);
s4L.state.public_trust = 12;
s4L.state.regulator_confidence = 15;
const r4La = await s4L.takeTurn('Act', 10);   // collapse turn 1: streak 1
check('collapse does NOT end on the first low turn', !r4La.endCondition);
s4L.state.public_trust = 12;                   // still collapsed
const r4Lb = await s4L.takeTurn('Act', 10);   // collapse turn 2: streak 2
check('collapse does NOT end the session as a loss (story stays playable)', !r4Lb.endCondition);
check('collapse is recorded as in-story pressure, not a terminal end', s4L.isCollapsed() && s4L.collapsed);
check('a collapsed session can still WIN the story (costliest tier)', (() => {
  s4L.attackChain.forEach((st) => { st.contained = true; st.revealed = true; });
  const end = s4L._checkEnd();
  return !!end && end.result === 'success' && end.success_kind === 'story' && end.win_quality === 'costly';
})());

// 4c. ONE confidence metric recovering breaks the collapse: no loss.
const s4R = new DMSession(new MockProvider(), scenario);
s4R.state.public_trust = 12;
s4R.state.regulator_confidence = 15;
await s4R.takeTurn('Act', 10);                // collapse turn 1: streak 1
s4R.state.regulator_confidence = 55;          // regulator recovers: collapse broken
const r4Rb = await s4R.takeTurn('Act', 10);   // streak reset
check('recovery of one confidence metric prevents the loss', !r4Rb.endCondition);

// 4d. STORY WIN (Dan's design 2026-10-05): the win is narrative, NOT a score
//     gate. The session ends successfully when the story arc resolves — the
//     final beat is reached, or the attack chain is fully contained. Reaching
//     the numeric thresholds is NOT required.
const storyWinScenario = {
  ...scenario,
  goal: {
    ending: 'Crisis resolved.',
    // Advisory only: these colour the win, they do NOT gate it.
    win_conditions: [
      { stat: 'public_trust', operator: 'gte', value: 60 },
      { stat: 'containment', operator: 'gte', value: 80 },
    ],
  },
  beats: [
    { id: 'b1', name: 'Step 1' },
    { id: 'b2', name: 'Step 2' },
  ],
};

// 4d-i. Reaching the FINAL beat wins by story, even with ragged metrics.
const s4d = new DMSession(new MockProvider({ beat: 'b2' }), storyWinScenario);
let goalEnd = null;
for (let i = 0; i < 5 && !goalEnd; i++) {
  // Deliberately BAD metrics: the old gate would refuse the win.
  s4d.state.public_trust = 30;
  s4d.state.containment = 25;
  const res = await s4d.takeTurn('Resolve the crisis', 20);
  if (res.endCondition) goalEnd = res.endCondition;
}
check('story win fires when the final beat is reached (metrics do NOT gate)', goalEnd && goalEnd.result === 'success');
check('story win is labelled as a story win', goalEnd && goalEnd.success_kind === 'story');
check('story win ending shown', goalEnd && goalEnd.ending === 'Crisis resolved.');

// 4d-ii. Fully containing the attack chain also wins by story, no thresholds.
const chainScenario = {
  ...scenario,
  goal: { ending: 'Threat neutralised.' },
  attack_chain: [
    { id: 's1', name: 'Hook', symptom: 'probe' },
    { id: 's2', name: 'Spread', symptom: 'wave' },
  ],
};
const s4d2 = new DMSession(new MockProvider({ contain_stage: 's1' }), chainScenario);
let chainEnd = null;
for (let i = 0; i < 5 && !chainEnd; i++) {
  s4d2.state.public_trust = 10;   // bad metrics must not block the story win
  const res = await s4d2.takeTurn('Contain the threat', 20);
  // Second stage gets contained on the next pass via the mock's fixed id.
  if (res.endCondition) chainEnd = res.endCondition;
  else s4d2.attackChain.forEach((s) => { s.contained = true; s.revealed = true; });
}
check('story win fires on full attack-chain containment (metrics do NOT gate)', chainEnd && chainEnd.result === 'success' && chainEnd.success_kind === 'story');

// 4d-iii. LINEAR PROGRESSION + PARTIAL CONTAINMENT (Dan's design, 2026-10-06):
//   reaching the FINAL beat wins even if attack-chain stages are still OPEN.
//   Leaving a stage uncontained must NOT block the win; it only reads costlier.
const partialScenario = {
  ...scenario,
  goal: { ending: 'Story resolved with a loose end.' },
  attack_chain: [
    { id: 'p1', name: 'Hook', symptom: 'probe' },
    { id: 'p2', name: 'Spread', symptom: 'wave' },
    { id: 'p3', name: 'Take', symptom: 'cash-out' },
  ],
};
{
  const s = new DMSession(new MockProvider({}), partialScenario);
  // Reach the final beat, but only contain ONE of three chain stages.
  s.currentBeatIndex = s.beats.length - 1;
  s.attackChain[0].contained = true;
  s.attackChain[0].revealed = true;
  const open = s.attackChain.filter((x) => !x.contained).map((x) => x.id);
  const end = s._checkEnd();
  check('final beat wins with chain stages still open (linear win)', !!end && end.result === 'success' && end.success_kind === 'story');
  check('the win reports which stages were left open', !!end && Array.isArray(end.open_stages) && end.open_stages.length === 2);
  check('open stages are exactly the uncontained ones', !!end && end.open_stages.join(',') === open.join(','));
  check('a partial-containment win reads as costlier (not decisive)', !!end && end.win_quality !== 'decisive');
}

// 4e. The metrics are ADVISORY: a story win with ragged numbers is still a win
//     (it just reads as more costly). It must NEVER be blocked by low metrics.
const s4e = new DMSession(new MockProvider({ beat: 'b2' }), storyWinScenario);
let goalEarly = null;
for (let i = 0; i < 5 && !goalEarly; i++) {
  s4e.state.public_trust = 5;      // far below the old 60 threshold
  s4e.state.containment = 5;      // far below the old 80 threshold
  const res = await s4e.takeTurn('Resolve the crisis', 20);
  if (res.endCondition) goalEarly = res.endCondition;
}
check('low metrics do NOT block the story win', !!goalEarly && goalEarly.result === 'success');
check('story win reports a win-quality tier', !!goalEarly && typeof goalEarly.win_quality === 'string');

// 5. Timeout end condition
const timeout = s4.timeoutEnd();
check('timeout end has ending', timeout && timeout.ending);

// 6. Report generation
const report = s4.buildReport({ ending: 'Attack overload.' });
check('report has turns', report.turns >= 1);
check('report has log', Array.isArray(report.log) && report.log.length > 0);
check('report has final_state', !!report.final_state);
check('report includes attack_chain', Array.isArray(report.attack_chain));
check('report includes breach_state', typeof report.breach_state === 'string');

// 7. Clamp: state never exceeds 100
const s5 = new DMSession(new MockProvider(), scenario);
for (let i = 0; i < 5; i++) {
  await s5.takeTurn('Push hard', 20);
  s5.state.containment = Math.min(100, s5.state.containment + 50);
}
for (const [k, v] of Object.entries(s5.state)) {
  check(`clamp ${k} <= 100`, v <= 100);
  check(`clamp ${k} >= 0`, v >= 0);
}

// 8. Conditional events (v3): stall trigger fires after N turns the DM
//    judged as no meaningful progress.
const stallScenario = {
  ...scenario,
  events: [
    { id: 'stall1', trigger: { type: 'stall', turns: 2 }, text: 'The room goes quiet.', state_delta: { public_trust: -5 } },
  ],
};
// DM returns progress:false every turn -> stall counter climbs.
const s6 = new DMSession(new MockProvider({ progress: false }), stallScenario);
await s6.takeTurn('x', 10);   // DM judges no progress (turn 1)
check('stall event NOT fired after 1 stalled turn', !s6.firedEvents.has('stall1'));
await s6.takeTurn('ok', 10);  // DM judges no progress (turn 2) -> fires
check('stall event fires after 2 consecutive stalled turns', s6.firedEvents.has('stall1'));
// The stall event applies -5 to public_trust on turn 2; the DM also returns a
// small delta (+1) on each of the two turns. Net: opening + 1 - 5 + 1.
check('stall event state_delta applied', s6.state.public_trust === stallScenario.opening_state.public_trust + 1 - 5 + 1);
check('stall event recorded in history', s6.history[1].events.includes('stall1'));

// 8b. Stall counter resets when the DM judges progress (progress:true).
//     Even a short/blank action is NOT a stall when the DM says progress.
const s6b = new DMSession(new MockProvider({ progress: false }), stallScenario);
await s6b.takeTurn('x', 10);  // DM: no progress (stall 1)
// Switch to a provider that reports progress:true -> resets the counter.
s6b.provider = new MockProvider({ progress: true });
await s6b.takeTurn('x', 10);  // short action, but DM judges progress -> resets
s6b.provider = new MockProvider({ progress: false });
await s6b.takeTurn('x', 10);  // stall 1 again
check('stall counter resets after a DM-judged progress turn', !s6b.firedEvents.has('stall1'));

// 8c. A missing `progress` field does NOT trigger a stall (defaults to progress).
const s6c = new DMSession(new MockProvider(), stallScenario);  // no progress field
await s6c.takeTurn('x', 10);  // short action, but no progress field -> not a stall
await s6c.takeTurn('x', 10);  // still no progress field -> counter stays 0
check('missing progress field does NOT trigger a stall', !s6c.firedEvents.has('stall1'));
check('missing progress field keeps stallCount at 0', s6c.stallCount === 0);

// 9. Conditional events (v3): stat trigger fires when the stat crosses threshold.
const statScenario = {
  ...scenario,
  events: [
    { id: 'stat1', trigger: { type: 'stat', stat: 'containment', operator: 'gte', value: 60 }, text: 'Regulator calls.', state_delta: { regulator_confidence: -5 } },
  ],
};
const s7 = new DMSession(new MockProvider(), statScenario);
s7.state.containment = 30;
await s7.takeTurn('Act', 10);
check('stat event NOT fired below threshold', !s7.firedEvents.has('stat1'));
s7.state.containment = 70;  // cross threshold
await s7.takeTurn('Act', 10);
check('stat event fires when stat crosses threshold', s7.firedEvents.has('stat1'));
check('stat event state_delta applied', s7.state.regulator_confidence === statScenario.opening_state.regulator_confidence - 5);

// 9b. Fired events do NOT re-fire on subsequent turns.
const before = s7.state.regulator_confidence;
await s7.takeTurn('Act', 10);  // containment still >= 60, but event already fired
check('fired event does NOT re-fire', s7.state.regulator_confidence === before);

// 10. serialize/restore persist fired event ids (no re-fire after restore).
const snap = s7.serialize();
check('serialize includes firedEvents', Array.isArray(snap.firedEvents) && snap.firedEvents.includes('stat1'));
const restored = DMSession.restore(new MockProvider(), statScenario, snap);
restored.state.containment = 80;  // still above threshold
await restored.takeTurn('Act', 10);
check('restored session does NOT re-fire a previously fired event', !restored.history[0].events.includes('stat1'));

// 11. Turn trigger fires on a specific turn number.
const turnScenario = {
  ...scenario,
  events: [
    { id: 'turn1', trigger: { type: 'turn', turn: 3 }, text: 'An influencer amplifies the clip.', state_delta: { public_trust: -3 } },
  ],
};
const s8 = new DMSession(new MockProvider(), turnScenario);
await s8.takeTurn('Act', 10);  // turn 1
await s8.takeTurn('Act', 10);  // turn 2
check('turn event NOT fired before its turn', !s8.firedEvents.has('turn1'));
await s8.takeTurn('Act', 10);  // turn 3 -> fires
check('turn event fires on its turn number', s8.firedEvents.has('turn1'));

// ===== NEW: attack chain (kill chain) =====
// 12. Attack chain is initialized from the scenario (all hidden).
const s9 = new DMSession(new MockProvider(), scenario);
check('attack chain initialized', Array.isArray(s9.attackChain) && s9.attackChain.length === scenario.attack_chain.length);
check('attack chain stages start hidden', s9.attackChain.every((s) => !s.revealed && !s.contained));
check('initial breach state is contained (nothing revealed)', s9.breachState === 'contained');

// 13. DM reveals a stage -> it becomes revealed, breach escalates.
const s10 = new DMSession(new MockProvider({ reveal: 'hook' }), scenario);
await s10.takeTurn('Investigate the fraud calls', 15);
check('stage revealed by DM', s10.attackChain.find((s) => s.id === 'hook').revealed === true);
check('breach state becomes active after one revealed stage', s10.breachState === 'active');
check('revealed stage recorded in history', s10.history[0].attack_chain.find((s) => s.id === 'hook').revealed === true);

// 14. DM contains a stage -> it becomes contained, breach de-escalates.
const s11 = new DMSession(new MockProvider({ reveal: 'hook', contain: 'hook' }), scenario);
await s11.takeTurn('Contain the fraud hook', 15);
const hook = s11.attackChain.find((s) => s.id === 'hook');
check('stage contained by DM', hook.contained === true);
check('containing implies revealed', hook.revealed === true);
// Only one of three stages is contained, so the breach is still active.
check('breach state active after one stage contained', s11.breachState === 'active');

// 15. Containing ALL stages is a win (BDB-style "contain all stages").
const s12 = new DMSession(new MockProvider({ reveal: 'hook', contain: 'hook' }), scenario);
// Reveal + contain all stages across turns; track whether a goal end fires.
let end12 = null;
for (const stage of scenario.attack_chain) {
  s12.provider = new MockProvider({ reveal: stage.id, contain: stage.id });
  const res = await s12.takeTurn('Contain ' + stage.id, 15);
  if (res.endCondition) { end12 = res.endCondition; break; }
}
check('containing all stages ends in success (goal win)', !!end12 && end12.result === 'success');
check('goal win is the contain-all-stages success', !!end12 && end12.type === 'goal');
// All stages contained + breach fully de-escalated.
const lastRes = s12.history[s12.history.length - 1];
check('all stages contained', s12.attackChain.every((s) => s.contained));
check('breach state contained at end', s12.breachState === 'contained');

// 16. serialize/restore persist attack chain + breach state.
const s13 = new DMSession(new MockProvider({ reveal: 'hook' }), scenario);
await s13.takeTurn('Investigate', 15);
const snap13 = s13.serialize();
check('serialize includes attackChain', Array.isArray(snap13.attackChain) && snap13.attackChain.length > 0);
check('serialize includes breachState', typeof snap13.breachState === 'string');
const restored13 = DMSession.restore(new MockProvider(), scenario, snap13);
check('restored attack chain preserved', restored13.attackChain.find((s) => s.id === 'hook').revealed === true);
check('restored breach state preserved', restored13.breachState === s13.breachState);

// ===== NEW: roll modifiers =====
// 17. grantRollModifier sets the modifier; it is consumed by the next roll.
const s14 = new DMSession(new MockProvider(), scenario);
check('roll modifier starts at 0', s14.rollModifier === 0);
s14.grantRollModifier(3);
check('grantRollModifier sets +3', s14.rollModifier === 3);
await s14.takeTurn('Play a defender capability', 10);
check('roll modifier consumed after the roll', s14.rollModifier === 0);

// 18. serialize/restore persist roll modifier.
const s15 = new DMSession(new MockProvider(), scenario);
s15.grantRollModifier(2);
const snap15 = s15.serialize();
check('serialize includes rollModifier', snap15.rollModifier === 2);
const restored15 = DMSession.restore(new MockProvider(), scenario, snap15);
check('restored roll modifier preserved', restored15.rollModifier === 2);

// ===== NEW: random mode =====
// 19. Random scenario shell is valid and the DM prompt includes RANDOM MODE.
import { randomScenarioShell, validateScenario, isRandomEntry } from '../app/js/scenarios.js';
const shell = randomScenarioShell();
const v = validateScenario(shell);
check('random shell is valid', v.valid === true);
check('random shell has random id', shell.scenario_id === 'random_generated');
check('isRandomEntry detects random marker', isRandomEntry({ random: true }) === true);
check('isRandomEntry detects random id', isRandomEntry({ id: 'random' }) === true);
check('isRandomEntry false for normal entry', isRandomEntry({ id: 'bramble_badger_deepfake' }) === false);

// 20. Random-mode session builds a prompt with the RANDOM MODE block.
const s16 = new DMSession(new MockProvider(), shell);
s16.random = true;
// Verify the DM brief instructs generation by checking the shell's
// situation text and that a turn resolves.
const r16 = await s16.takeTurn('The team convenes to assess the situation', 12);
check('random-mode turn resolves', typeof r16.narrative === 'string' && r16.narrative.length > 0);
check('random-mode state tracked', typeof r16.state === 'object');

// 21. Round counter: turn is tracked and turn-triggered events fire on schedule.
const s17 = new DMSession(new MockProvider(), scenario);
check('turn starts at 0', s17.turn === 0);
await s17.takeTurn('Act', 10);
check('turn increments to 1', s17.turn === 1);
await s17.takeTurn('Act', 10);
check('turn increments to 2', s17.turn === 2);

// ===== NEW: per-turn total cap (anti-snowball) =====
// 22. A single turn cannot swing a metric by more than PER_TURN_MAX_CHANGE,
//     even when fate + event + DM deltas all push the same metric.
const capScenario = {
  ...scenario,
  fate_table: { '1': { kind: 'crit_fail', twist: 'bad', state_delta: { public_trust: -14, containment: 12 } } },
  events: [
    { id: 'cap1', trigger: { type: 'turn', turn: 1 }, text: 'bad turn', state_delta: { public_trust: -10, containment: 10 } },
  ],
};
const s18 = new DMSession(new MockProvider(), capScenario);
const before18 = s18.state.public_trust;
await s18.takeTurn('Do something bad', 1);  // fate -14 + event -10 + DM -10 on public_trust
const drop18 = before18 - s18.state.public_trust;
check('per-turn public_trust drop capped at 15', drop18 <= 15);
const containAfter18 = s18.state.containment;   // +12 +10 from fate + event, capped at 15
check('per-turn containment rise capped at 15', containAfter18 - capScenario.opening_state.containment <= 15);

// 23. Stat-based collapse conditions are tracked with consecutive-turn
//     streaks: a single-stat condition (public_trust <= 15) flags the collapse
//     after 2 consecutive turns in the zone, and the streak persists across
//     serialize/restore. The collapse is NOT terminal (Dan's design), so no
//     endCondition fires — the streak itself is what we assert.
const streakScenario = {
  ...scenario,
  beats: undefined,   // arc off: this block tests the collapse streak, not the arc
  end_conditions: [
    { type: 'stat', stat: 'public_trust', operator: 'lte', value: 15, consecutive: 2, ending: 'collapse' },
  ],
};
const s19 = new DMSession(new MockProvider(), streakScenario);
s19.state.public_trust = 10;  // in the failure zone
const res19a = await s19.takeTurn('Act', 10);  // turn 1: streak 1
check('collapse does NOT fire on the first bad turn', !res19a.endCondition && !s19.isCollapsed());
const snap19 = s19.serialize();
check('serialize includes statStreaks', typeof snap19.statStreaks === 'object');
const restored19 = DMSession.restore(new MockProvider(), streakScenario, snap19);
restored19.state.public_trust = 10;  // still in the zone
const res19 = await restored19.takeTurn('Act', 10);  // turn 2: streak 2 -> collapse
check('collapse flags after 2 consecutive bad turns (streak survives restore)', !res19.endCondition && restored19.isCollapsed());
check('the streak survives serialize/restore (count carried)', (restored19.statStreaks[0] || {}).count >= 2);

// 24. The collapse streak RESETS when the stat leaves the zone: leaving and
//     re-entering starts the streak over, so the collapse flags only after 2
//     CONSECUTIVE turns back in the zone.
const s20 = new DMSession(new MockProvider(), streakScenario);
s20.state.public_trust = 10;  // in zone
await s20.takeTurn('Act', 10);  // streak 1
s20.state.public_trust = 50;   // leaves zone
const res20a = await s20.takeTurn('Act', 10);  // streak resets
check('no collapse after leaving the zone', !res20a.endCondition && !s20.isCollapsed());
s20.state.public_trust = 10;   // back in zone
const res20m = await s20.takeTurn('Act', 10);  // streak 1 again
check('no collapse on the first turn back in the zone (streak was reset)', !res20m.endCondition && !s20.isCollapsed());
const res20b = await s20.takeTurn('Act', 10);  // streak 2 -> collapse
check('collapse flags after 2 consecutive turns back in the zone', !res20b.endCondition && s20.isCollapsed());

// ===== NEW: roll-modifier mechanic (targeted) =====
// 25. A granted roll modifier is fed to the DM as an adjusted roll and is
//     consumed by that roll. This exercises the full defender-capability flow
//     that the blind playthrough never triggered.
class CapturingProvider {
  constructor() { this.lastUser = ''; }
  async chat(messages) {
    this.lastUser = messages[messages.length - 1].content;
    return JSON.stringify({ narrative: 'The capability pays off.', state_delta: { public_trust: 2 } });
  }
}
const s21 = new DMSession(new CapturingProvider(), scenario);
check('roll modifier starts at 0', s21.rollModifier === 0);
s21.grantRollModifier(3);
check('grantRollModifier sets +3', s21.rollModifier === 3);
await s21.takeTurn('Play a defender capability', 10);
check('adjusted roll (+3) fed to the DM', s21.provider.lastUser.includes('adjusted roll is 13'));
check('roll modifier consumed after the roll', s21.rollModifier === 0);

// 26. Without a modifier, no adjusted-roll line is sent to the DM.
const s22 = new DMSession(new CapturingProvider(), scenario);
await s22.takeTurn('Act normally', 10);
check('no adjusted-roll line when no modifier', !s22.provider.lastUser.includes('adjusted roll'));

// ===== no-goal mode (executive "deal with the fallout" exercise) =====
// 27. Under the STORY-WIN model (Dan's design 2026-10-05), containing the full
//     attack chain resolves the story and WINS — the goal object is optional.
//     A scenario with no `goal` still wins on full containment; the `goal` only
//     supplies the ending text (with a generic fallback when absent).
const noGoalScenario = {
  ...scenario,
  goal: undefined,  // no goal object at all
};
const s23 = new DMSession(new MockProvider({ reveal: 'hook', contain: 'hook' }), noGoalScenario);
let ended23 = null;
for (const stage of noGoalScenario.attack_chain) {
  s23.provider = new MockProvider({ reveal: stage.id, contain: stage.id });
  const res = await s23.takeTurn('Contain ' + stage.id, 15);
  if (res.endCondition) { ended23 = res.endCondition; break; }
}
check('no-goal scenario WINS by story once the chain is fully contained', s23.attackChain.every((s) => s.contained) && !!ended23 && ended23.result === 'success');
check('no-goal story win still carries a fallback ending', !!ended23 && typeof ended23.ending === 'string' && ended23.ending.length > 0);

// 28. A no-goal scenario does NOT end on the narrative collapse either (Dan's
//     design): the collapse is in-story pressure, so the session keeps playing
//     to the timeout or a manual end — never a score-driven game over.
const s24 = new DMSession(new MockProvider(), noGoalScenario);
s24.state.public_trust = 8;            // collapsed
s24.state.regulator_confidence = 9;    // collapsed
const r24a = await s24.takeTurn('Act', 10);  // collapse turn 1: streak 1
check('no-goal scenario does not end on the first collapse turn', !r24a.endCondition);
const r24b = await s24.takeTurn('Act', 10);  // collapse turn 2: streak 2
check('no-goal scenario does NOT end in a collapse loss (story stays playable)', !r24b.endCondition && s24.isCollapsed());

// 29. A no-goal scenario with a timeout ends cleanly on timeout.
check('no-goal scenario keeps its timeout end condition', noGoalScenario.end_conditions.some((c) => c.type === 'timeout'));

// ===== NEW: story beats (v4) =====
// A provider that can advance the beat and report quality.
class BeatProvider {
  constructor(opts = {}) {
    this.beat = opts.beat || null;        // next beat id, or null to stay
    this.quality = opts.quality || null;   // good/mixed/poor
    this.lastSystem = '';
    this.lastUser = '';
  }
  async chat(messages) {
    this.lastSystem = messages[0].content;
    this.lastUser = messages[messages.length - 1].content;
    const reply = { narrative: 'The team acted and the story moved forward.', state_delta: { public_trust: 1 } };
    if (this.beat) reply.beat = this.beat;
    if (this.quality) reply.beat_quality = this.quality;
    return JSON.stringify(reply);
  }
}

// 30. Beat is initialized to the first beat in the arc.
const beatsScenario = {
  ...scenario,
  beats: [
    { id: 'b1', name: 'Step 1', narrative: 'First step.' },
    { id: 'b2', name: 'Step 2', narrative: 'Second step.' },
    { id: 'b3', name: 'Step 3', narrative: 'Third step.' },
  ],
};
const sBeats0 = new DMSession(new BeatProvider(), beatsScenario);
check('beats initialized from scenario', sBeats0.beats.length === 3);
check('current beat starts at 0 (b1)', sBeats0.currentBeatIndex === 0 && sBeats0.beats[0].id === 'b1');
check('current beat id exposed on event', sBeats0.beats[0].id === 'b1');

// 31. DM advances the beat by returning the next id.
const sBeats1 = new DMSession(new BeatProvider({ beat: 'b2', quality: 'good' }), beatsScenario);
await sBeats1.takeTurn('Public statement issued', 15);
check('beat advances to b2 when DM returns next id', sBeats1.currentBeatIndex === 1);
check('beat_quality recorded (good)', sBeats1.lastBeatQuality === 'good');
check('beat id on history event reflects the new beat', sBeats1.history[0].beat === 'b2');

// 32. DM can skip forward to a later beat (decisive action collapses steps).
const sBeats2 = new DMSession(new BeatProvider({ beat: 'b3', quality: 'good' }), beatsScenario);
await sBeats2.takeTurn('Resolve everything at once', 20);
check('decisive action skips forward to b3', sBeats2.currentBeatIndex === 2);

// 33. Beat does NOT go backwards (returning an earlier id is ignored).
const sBeats3 = new DMSession(new BeatProvider({ beat: 'b1' }), beatsScenario);
// Advance once to b2 first.
sBeats3.provider = new BeatProvider({ beat: 'b2' });
await sBeats3.takeTurn('Action', 10);
// Now try to go back to b1.
sBeats3.provider = new BeatProvider({ beat: 'b1' });
await sBeats3.takeTurn('Action', 10);
check('beat does not move backwards', sBeats3.currentBeatIndex === 1);

// 34. An unknown beat id is ignored (stays in current beat).
const sBeats4 = new DMSession(new BeatProvider({ beat: 'does-not-exist' }), beatsScenario);
await sBeats4.takeTurn('Action', 10);
check('unknown beat id is ignored', sBeats4.currentBeatIndex === 0);

// 35. A scenario with NO beats leaves the mechanic inert (no beat line in user turn).
const noBeatsScenario = { ...scenario, beats: undefined };
const noBeatsProv = new BeatProvider();
const sBeats5 = new DMSession(noBeatsProv, noBeatsScenario);
await sBeats5.takeTurn('Action', 10);
check('no beats -> lastBeatQuality stays empty', sBeats5.lastBeatQuality === '');
check('no beats -> no STORY BEAT line in user turn', !noBeatsProv.lastUser.includes('STORY BEAT'));

// 36. With beats, the user turn carries the STORY BEAT context.
const beatProv6 = new BeatProvider();
const sBeats6 = new DMSession(beatProv6, beatsScenario);
await sBeats6.takeTurn('Action', 10);
check('beats -> STORY BEAT line present in user turn', beatProv6.lastUser.includes('STORY BEAT 1 of 3'));
check('beats -> beat name shown in user turn', beatProv6.lastUser.includes('Step 1'));

// 37. A prior beat_quality is carried into the next user turn (soften/escalate).
const beatProv7 = new BeatProvider();
const sBeats7 = new DMSession(new BeatProvider({ beat: 'b2', quality: 'poor' }), beatsScenario);
await sBeats7.takeTurn('Action', 10); // advances to b2, quality=poor
sBeats7.provider = beatProv7;
await sBeats7.takeTurn('Action', 10); // now in b2; last quality carried
check('prior beat_quality carried into next user turn', beatProv7.lastUser.includes('previous beat: poor'));

// 38. serialize/restore persist the beat arc state.
const sBeats8 = new DMSession(new BeatProvider({ beat: 'b2', quality: 'mixed' }), beatsScenario);
await sBeats8.takeTurn('Action', 10);
const snapB = sBeats8.serialize();
check('serialize includes currentBeatIndex', snapB.currentBeatIndex === 1);
check('serialize includes lastBeatQuality', snapB.lastBeatQuality === 'mixed');
const restoredB = DMSession.restore(new BeatProvider(), beatsScenario, snapB);
check('restored currentBeatIndex preserved', restoredB.currentBeatIndex === 1);
check('restored lastBeatQuality preserved', restoredB.lastBeatQuality === 'mixed');

// 39. The system prompt carries the STORY BEATS section and the momentum rule
//     (no flat dead ends; advance the world each turn).
const beatProv9 = new BeatProvider();
const sBeats9 = new DMSession(beatProv9, beatsScenario);
await sBeats9.takeTurn('Action', 10);
check('system prompt has STORY BEATS section', beatProv9.lastSystem.includes('THE STORY BEATS'));
check('system prompt has the forward-momentum rule', beatProv9.lastSystem.includes('KEEP THE MOMENTUM'));
check('system prompt bans menus but requires world advancement', beatProv9.lastSystem.includes('advance the world') && beatProv9.lastSystem.includes('NEVER present a menu'));

// 40. The momentum rule must advance with EVENTS, never DIRECTIVES - the DM
//     must not suggest solutions or tell the team what to decide/do (Dan:
//     'it can lay out the problems but not suggest a solution').
check('prompt advances with events, not directives', beatProv9.lastSystem.includes('ADVANCE WITH EVENTS, NEVER DIRECTIVES'));
check('prompt bans leading phrasings', ['the team needs to', 'consider', 'the next step is to', 'it may be wise to'].every((p) => beatProv9.lastSystem.includes(p)) && beatProv9.lastSystem.includes('Those lead the group'));

// ===== NEW: budget spend tracking (v4 state panel) =====
// A provider that reports a negative budget delta (money spent this turn).
class SpendProvider {
  constructor(delta) { this.delta = delta || { budget: -12 }; }
  async chat() { return JSON.stringify({ narrative: 'The team spent budget on response actions.', state_delta: this.delta }); }
}

// 41. A negative budget delta is recorded as this-turn spend + cumulative total.
const sSpend1 = new DMSession(new SpendProvider(), scenario);
await sSpend1.takeTurn('Deploy extra monitoring', 10);
check('lastBudgetSpend records the budget outlay', sSpend1.lastBudgetSpend === 12);
check('budgetSpend accumulates the total', sSpend1.budgetSpend === 12);
await sSpend1.takeTurn('Hire external comms firm', 10);
check('budgetSpend accumulates across turns', sSpend1.budgetSpend === 24);

// 42. A POSITIVE budget delta (inflow/recovery) is NOT counted as spend.
const sSpend2 = new DMSession(new SpendProvider({ budget: 5 }), scenario);
await sSpend2.takeTurn('Secure a relief allocation', 10);
check('positive budget delta is not counted as spend', sSpend2.lastBudgetSpend === 0 && sSpend2.budgetSpend === 0);

// 43. Spend is recorded on the history event and persists across serialize/restore.
const sSpend3 = new DMSession(new SpendProvider(), scenario);
await sSpend3.takeTurn('Spend', 10);
check('event carries budget_spend', sSpend3.history[0].budget_spend === 12);
check('event carries total_budget_spend', sSpend3.history[0].total_budget_spend === 12);
const snapSpend = sSpend3.serialize();
check('serialize includes budgetSpend', snapSpend.budgetSpend === 12);
const restoredSpend = DMSession.restore(new SpendProvider(), scenario, snapSpend);
check('restore preserves budgetSpend', restoredSpend.budgetSpend === 12);

// 44. openScene() narrates the opening before the group acts (esp. Random).
const sOpen = new DMSession(new MockProvider(), scenario);
const opening = await sOpen.openScene();
check('openScene returns a narration string', typeof opening === 'string' && opening.length > 0);
check('openScene seeds history turn 0', sOpen.history.length === 1 && sOpen.history[0].turn === 0 && sOpen.history[0].action === '(opening scene)');
check('openScene does not advance turn count', sOpen.turn === 0);
check('openScene does not mutate state', JSON.stringify(sOpen.state) === JSON.stringify(scenario.opening_state || {}));
// Random-mode shell also works (no pre-authored narrative to rely on).
const randSession = new DMSession(new MockProvider(), randomScenarioShell());
const randOpening = await randSession.openScene();
check('openScene works in random mode', typeof randOpening === 'string' && randOpening.length > 0);

// 45. Blank/empty narrative from the provider never reaches the player as a
// blank story — a fallback line is shown instead (intermittent provider failure).
class BlankProvider {
  async chat() { return ''; } // empty reply -> extraction yields nothing
}
const sBlank = new DMSession(new BlankProvider(), scenario);
const blankOpening = await sBlank.openScene();
check('openScene falls back when provider returns empty', typeof blankOpening === 'string' && blankOpening.trim().length > 0);
const blankTurn = await sBlank.takeTurn('We respond publicly.', 12);
check('takeTurn falls back when provider returns empty', typeof blankTurn.narrative === 'string' && blankTurn.narrative.trim().length > 0);

// 46. (Issue 2B) A NO-OP narrative from the DM ("didn't do anything but the
// story continues") must NEVER surface to the player. It must be replaced with
// a forward-driving fallback and flagged as no-progress so stall mechanics apply.
class NoopProvider {
  async chat() {
    return JSON.stringify({ narrative: 'Nothing happened but the story continues, the situation remains unchanged, no immediate development, still waiting.', state_delta: { public_trust: 0 } });
  }
}
const sNoop = new DMSession(new NoopProvider(), scenario);
const noopTurn = await sNoop.takeTurn('The group takes decisive action.', 12);
check('no-op narrative is NOT surfaced to the player', !String(noopTurn.narrative).toLowerCase().includes('nothing happened') && !String(noopTurn.narrative).toLowerCase().includes('story continues'));
check('no-op narrative is replaced with a fallback', String(noopTurn.narrative).trim().length > 0 && String(noopTurn.narrative) !== "Nothing happened but the story continues, the situation remains unchanged, no immediate development, still waiting.");
check('no-op narrative flags no progress (stallCount increments)', sNoop.stallCount >= 1);

// 46b. (GLM F1/F2 canary) A LEGITIMATE narrative that mentions 'unchanged' or
// 'still waiting' about a specific metric/front must NOT be treated as a no-op
// (false positive). Only scoped markers should match.
class LegitProvider {
  async chat() {
    return JSON.stringify({
      narrative: 'Trust is unchanged this turn, but the regulator just called demanding the full timeline by tonight, so the group faces a fresh deadline.',
      state_delta: { public_trust: 0, regulator_confidence: -2 },
    });
  }
}
const sLegit = new DMSession(new LegitProvider(), scenario);
const legitTurn = await sLegit.takeTurn('Brief the board.', 12);
check('legit narrative mentioning "unchanged" is NOT treated as a no-op', String(legitTurn.narrative).includes('Trust is unchanged') && String(legitTurn.narrative).includes('regulator just called'));
check('legit narrative does not force progress=false', sLegit.stallCount === 0);

// 46c. (GLM F1 canary) A pressure narrative about the regulator 'still waiting'
// for a response must NOT be flagged as a no-op (scoped marker check).
class RegulatorWaitProvider {
  async chat() {
    return JSON.stringify({
      narrative: 'The regulator is still waiting for your response, and the media have begun to cover the delay.',
      state_delta: { regulator_confidence: -3 },
    });
  }
}
const sRegWait = new DMSession(new RegulatorWaitProvider(), scenario);
const regWaitTurn = await sRegWait.takeTurn('File the response.', 12);
check('regulator "is still waiting" narrative is NOT a no-op', String(regWaitTurn.narrative).includes('still waiting for your response'));
check('regulator wait narrative does not force progress=false', sRegWait.stallCount === 0);

// 47. (Issue 2A) The system prompt must ban no-op narratives explicitly.
class NoopPromptProvider {
  constructor() { this.lastSystem = ''; }
  async chat(messages) {
    this.lastSystem = messages[0].content;
    return JSON.stringify({ narrative: 'The team acted and events developed.', state_delta: { public_trust: 1 } });
  }
}
const noopPromptProv = new NoopPromptProvider();
const noopPromptSession = new DMSession(noopPromptProv, scenario);
await noopPromptSession.takeTurn('The group responds.', 12);
const noopPromptSys = noopPromptProv.lastSystem;
check('system prompt bans no-op narratives', noopPromptSys.includes('NO-OP NARRATIVE') && noopPromptSys.toLowerCase().includes('the story continues') && noopPromptSys.includes('concrete development'));

// 48. (Issue 1b) The closing report must capture BOTH the action the group
// took AND the DM's response per turn, not half of each exchange.
const sFull = new DMSession(new MockProvider(), scenario);
const full1 = await sFull.takeTurn('Issue a public apology.', 14);
const reportFull = sFull.buildReport({ result: 'ended', ending: 'The group concluded.' });
const turn0 = reportFull.log[0];
check('report log entry has the group action', typeof turn0 && ('action' in turn0) && String(turn0.action).length > 0 && String(turn0.action).includes('public apology'));
check('report log entry has the DM narrative', typeof turn0 && typeof turn0.narrative === 'string' && String(turn0.narrative).trim().length > 0);

// ===== PACE AWARENESS (Dan, 2026-10-07) =====
// The DM must be told the turn number, the turn budget, the minutes left, and a
// pacing verdict every turn — otherwise it guesses and runs drift off the hour.

// 49. Scenario pacing block is read; defaults derive from the 60-minute limit.
const paceScenario = { ...scenario };
const paceS = new DMSession(new MockProvider(), paceScenario);
check('pacing block gives target/total turns (6/7 from scenario)', paceS.targetTurn === 6 && paceS.totalTurn === 7);

// 49b. A scenario WITHOUT a pacing block derives a sane budget from the timeout.
const noPace = { ...scenario };
delete noPace.pacing;
const noPaceS = new DMSession(new MockProvider(), noPace);
check('pacing defaults derive from the 60-min timeout (7 total, 6 target)',
  noPaceS.totalTurn === 7 && noPaceS.targetTurn === 6, `${noPaceS.targetTurn}/${noPaceS.totalTurn}`);

// 50. The per-turn user prompt carries the PACE block: turn number, budget,
// beats remaining, and a verdict.
const paceProv = (() => {
  let p;
  class P { constructor() { this.lastUser = ''; } async chat(m) { this.lastUser = m[1].content;
    return JSON.stringify({ narrative: 'Things develop concretely on the ground.', state_delta: { public_trust: 1 }, progress: true }); } }
  p = new P(); return p;
})();
const paceRun = new DMSession(paceProv, scenario);
paceRun.start(); // starts the clock so minutes-left is real
await paceRun.takeTurn('We act.', 12);
check('user prompt includes a PACE block', /PACE:/.test(paceProv.lastUser));
check('PACE block names the turn and the budget', /Turn 1 of about 7/.test(paceProv.lastUser) && /target: resolve by turn 6/.test(paceProv.lastUser));
check('PACE block names the story-beat position', /Story beat 1 of \d+/.test(paceProv.lastUser));
check('PACE block reports minutes left on the clock', /minutes? left on the clock/.test(paceProv.lastUser));
check('PACE block carries a pacing verdict', /PACING VERDICT:/.test(paceProv.lastUser));

// 51. Ahead-of-pace verdict: deep into the turn budget with beats still to go.
const paceProv2 = (() => {
  class P { constructor() { this.lastUser = ''; } async chat(m) { this.lastUser = m[1].content;
    return JSON.stringify({ narrative: 'The situation develops further.', state_delta: {}, progress: true }); } }
  return new P();
})();
const pacedScenario = {
  ...scenario,
  pacing: { target_turns: 6, total_turns: 7 },
  beats: [
    { id: 'b1', name: 'First', narrative: 'First beat.' },
    { id: 'b2', name: 'Second', narrative: 'Second beat.' },
    { id: 'b3', name: 'Third', narrative: 'Third beat.' },
    { id: 'b4', name: 'Fourth', narrative: 'Fourth beat.' },
    { id: 'b5', name: 'Fifth', narrative: 'Fifth beat.' },
  ],
};
const pacedRun = new DMSession(paceProv2, pacedScenario);
pacedRun.turn = 5;              // turn 6 of 7, still on beat 1 of 5
pacedRun.currentBeatIndex = 0;
const brief = pacedRun._paceBrief();
check('pace brief flags SPEED UP late in the budget with beats remaining', /SPEED UP/.test(brief), brief.split('\n')[1]);
check('pace brief reports beats to go', /4 to go/.test(brief));

// 52. On the final beat the verdict tells the DM to resolve now.
const finalRun = new DMSession(new MockProvider(), pacedScenario);
finalRun.currentBeatIndex = pacedScenario.beats.length - 1;
const finalBrief = finalRun._paceBrief();
check('pace brief tells the DM to resolve on the final beat', /FINAL BEAT/.test(finalBrief));

// 52b. The verdict must be an actionable DECISION, not just a status: early with
// room to spare it must say SLOW DOWN so a turn can fail and build suspense
// (Dan's refinement, 2026-10-07).
const earlyRun = new DMSession(new MockProvider(), pacedScenario);
earlyRun.turn = 0;
earlyRun.currentBeatIndex = 0;
const earlyBrief = earlyRun._paceBrief();
check('pace brief tells the DM it can SLOW DOWN when there is room', /SLOW DOWN/.test(earlyBrief), earlyBrief.split('\n')[1]);
const behindRun = new DMSession(new MockProvider(), pacedScenario);
behindRun.turn = 5; behindRun.currentBeatIndex = 0;
check('pace brief says SPEED UP when the arc cannot finish on schedule', /SPEED UP/.test(behindRun._paceBrief()));

// 53. Action density: the prompt tells the DM a turn is 1-2 committed moves, not
// five+ (Dan's refinement, 2026-10-07).
const densityRun = new DMSession(new MockProvider(), scenario);
const densitySys = densityRun.constructor && (() => {
  class P { constructor() { this.lastSystem = ''; } async chat(m) { this.lastSystem = m[0].content; return JSON.stringify({ narrative: 'It develops.', state_delta: {} }); } }
  return new P();
})();
await densityRun.takeTurn('We act.', 12);
// Rebuild the system prompt via a fresh session so we can read it.
const dprov = (() => { class P { constructor() { this.lastSystem = ''; } async chat(m) { this.lastSystem = m[0].content; return JSON.stringify({ narrative: 'It develops concretely.', state_delta: {} }); } } return new P(); })();
const drun = new DMSession(dprov, scenario);
await drun.takeTurn('We act.', 12);
check('system prompt caps a turn at one or two moves, not five', /ONE or TWO committed moves/i.test(dprov.lastSystem) && /not a laundry list/i.test(dprov.lastSystem));
check('system prompt says too-many actions should partly slip', /should not be uniformly rewarded|part of it slip/i.test(dprov.lastSystem));

// 53. Pacing survives serialize/restore (a resumed run keeps its budget).
const paceSnap = pacedRun.serialize();
check('serialize carries the pacing budget', paceSnap.targetTurn === 6 && paceSnap.totalTurn === 7);
const restoredRun = DMSession.restore(new MockProvider(), pacedScenario, paceSnap);
check('restore preserves the pacing budget', restoredRun.targetTurn === 6 && restoredRun.totalTurn === 7);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
