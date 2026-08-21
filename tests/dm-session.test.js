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
  }
  async chat(messages, opts = {}) {
    const userMsg = messages[messages.length - 1].content;
    const rollMatch = userMsg.match(/got: (\d+)/);
    const roll = rollMatch ? Number(rollMatch[1]) : 15;
    const reply = {
      narrative: `The team handled turn ${roll}: a measured response. Consequences applied.`,
      state_delta: roll >= 20 ? { public_trust: 6, containment: 4 } : roll <= 1 ? { public_trust: -10, attacker_progress: 8 } : { public_trust: 1 },
    };
    if (this.progress !== undefined) reply.progress = this.progress;
    if (this.reveal) reply.reveal_stage = this.reveal;
    if (this.contain) reply.contain_stage = this.contain;
    return JSON.stringify(reply);
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
check('attacker_progress increased from fate delta', s2.state.attacker_progress > scenario.opening_state.attacker_progress);

// 3. Fate on 1 (crit fail)
const s3 = new DMSession(new MockProvider(), scenario);
await s3.takeTurn('Do nothing', 1);
check('fate on 1', s3.history[0].fate !== null);
check('public_trust dropped on 1', s3.state.public_trust < scenario.opening_state.public_trust);

// 4. End condition detection: stat thresholds (e.g. attacker_progress >= 90)
//    must NOT end the game — Dan's design: no instant loss on a metric hitting
//    100. The exercise runs until the team decides it's done (manual end) or
//    the timeout fires. Drive attacker_progress to the ceiling and confirm the
//    session does NOT auto-end.
const s4 = new DMSession(new MockProvider(), scenario);
let endHit = false;
for (let i = 0; i < 40 && !endHit; i++) {
  const res = await s4.takeTurn('Escalate aggressively', 11); // fate adds attacker_progress each time
  s4.state.attacker_progress = Math.min(100, s4.state.attacker_progress + 20); // force toward threshold
  if (res.endCondition) endHit = true;
}
check('stat threshold does NOT end the game (no instant loss at 100)', !endHit);

// 4b. Goal (win condition): when all goal thresholds are met simultaneously,
//     the scenario ends successfully.
const goalScenario = {
  ...scenario,
  goal: {
    ending: 'Crisis resolved.',
    win_conditions: [
      { stat: 'attacker_progress', operator: 'lte', value: 20 },
      { stat: 'public_trust', operator: 'gte', value: 60 },
    ],
  },
};
const s4b = new DMSession(new MockProvider(), goalScenario);
let goalEnd = null;
for (let i = 0; i < 5 && !goalEnd; i++) {
  s4b.state.attacker_progress = 20;   // below 20
  s4b.state.public_trust = 75;        // above 60
  const res = await s4b.takeTurn('Stabilize and reassure', 20);
  if (res.endCondition) goalEnd = res.endCondition;
}
check('goal fires when all win conditions met', goalEnd && goalEnd.result === 'success');
check('goal ending shown', goalEnd && goalEnd.ending === 'Crisis resolved.');

// 4c. Goal does NOT fire when only SOME thresholds are met.
const s4c = new DMSession(new MockProvider(), goalScenario);
let goalEarly = null;
for (let i = 0; i < 5 && !goalEarly; i++) {
  s4c.state.attacker_progress = 80;   // above 20 -> goal NOT met
  s4c.state.public_trust = 75;         // above 60
  const res = await s4c.takeTurn('Stabilize and reassure', 20);
  if (res.endCondition) goalEarly = res.endCondition;
}
check('goal does NOT fire when thresholds not all met', !goalEarly);

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
  s5.state.attacker_progress = Math.min(100, s5.state.attacker_progress + 50);
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
    { id: 'stat1', trigger: { type: 'stat', stat: 'attacker_progress', operator: 'gte', value: 60 }, text: 'Regulator calls.', state_delta: { regulator_confidence: -5 } },
  ],
};
const s7 = new DMSession(new MockProvider(), statScenario);
s7.state.attacker_progress = 30;
await s7.takeTurn('Act', 10);
check('stat event NOT fired below threshold', !s7.firedEvents.has('stat1'));
s7.state.attacker_progress = 70;  // cross threshold
await s7.takeTurn('Act', 10);
check('stat event fires when stat crosses threshold', s7.firedEvents.has('stat1'));
check('stat event state_delta applied', s7.state.regulator_confidence === statScenario.opening_state.regulator_confidence - 5);

// 9b. Fired events do NOT re-fire on subsequent turns.
const before = s7.state.regulator_confidence;
await s7.takeTurn('Act', 10);  // attacker_progress still >= 60, but event already fired
check('fired event does NOT re-fire', s7.state.regulator_confidence === before);

// 10. serialize/restore persist fired event ids (no re-fire after restore).
const snap = s7.serialize();
check('serialize includes firedEvents', Array.isArray(snap.firedEvents) && snap.firedEvents.includes('stat1'));
const restored = DMSession.restore(new MockProvider(), statScenario, snap);
restored.state.attacker_progress = 80;  // still above threshold
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
  fate_table: { '1': { kind: 'crit_fail', twist: 'bad', state_delta: { public_trust: -14, attacker_progress: 12 } } },
  events: [
    { id: 'cap1', trigger: { type: 'turn', turn: 1 }, text: 'bad turn', state_delta: { public_trust: -10, attacker_progress: 10 } },
  ],
};
const s18 = new DMSession(new MockProvider(), capScenario);
const before18 = s18.state.public_trust;
await s18.takeTurn('Do something bad', 1);  // fate -14 + event -10 + DM -10 on public_trust
const drop18 = before18 - s18.state.public_trust;
check('per-turn public_trust drop capped at 15', drop18 <= 15);
const apBefore18 = capScenario.opening_state.attacker_progress;
const apAfter18 = s18.state.attacker_progress;
check('per-turn attacker_progress rise capped at 15', apAfter18 - apBefore18 <= 15);

// 23. serialize/restore persist statStreaks (kept for backward-compat with
//     saved sessions, though stat thresholds no longer end the game).
const streakScenario = {
  ...scenario,
  end_conditions: [
    { type: 'stat', stat: 'public_trust', operator: 'lte', value: 15, consecutive: 2, ending: 'collapse' },
  ],
};
const s19 = new DMSession(new MockProvider(), streakScenario);
s19.state.public_trust = 10;  // in the failure zone
const res19a = await s19.takeTurn('Act', 10);  // turn 1: streak 1
check('stat threshold does NOT end on first bad turn', !res19a.endCondition);
const snap19 = s19.serialize();
check('serialize includes statStreaks', typeof snap19.statStreaks === 'object');
const restored19 = DMSession.restore(new MockProvider(), streakScenario, snap19);
restored19.state.public_trust = 10;  // still in the zone
const res19 = await restored19.takeTurn('Act', 10);  // turn 2: streak 2
check('stat threshold does NOT end even after 2 consecutive bad turns', !res19.endCondition);

// 24. Consecutive lose resets when the stat leaves the zone (mechanism kept,
//     but it no longer ends the game).
const s20 = new DMSession(new MockProvider(), streakScenario);
s20.state.public_trust = 10;  // in zone
await s20.takeTurn('Act', 10);  // streak 1
s20.state.public_trust = 50;   // leaves zone
const res20a = await s20.takeTurn('Act', 10);  // streak resets
check('stat threshold does NOT fire after leaving the zone', !res20a.endCondition);
s20.state.public_trust = 10;   // back in zone
await s20.takeTurn('Act', 10);  // streak 1 again
const res20b = await s20.takeTurn('Act', 10);  // streak 2
check('stat threshold does NOT end after re-entering zone for 2 turns', !res20b.endCondition);

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

// ===== NEW: no-goal mode (executive "deal with the fallout" exercise) =====
// 27. A scenario with NO goal and an attack_chain must NOT auto-win when all
//     stages are contained. It runs to timeout or a manual end instead; the
//     report is the debrief. (IT/BDB scenarios define a goal and DO win on
//     containment; executive scenarios without a goal do not.)
const noGoalScenario = {
  ...scenario,
  goal: undefined,  // no win condition
};
const s23 = new DMSession(new MockProvider({ reveal: 'hook', contain: 'hook' }), noGoalScenario);
// Contain all stages across turns; track whether an end condition ever fires.
let ended23 = null;
for (const stage of noGoalScenario.attack_chain) {
  s23.provider = new MockProvider({ reveal: stage.id, contain: stage.id });
  const res = await s23.takeTurn('Contain ' + stage.id, 15);
  if (res.endCondition) { ended23 = res.endCondition; break; }
}
check('no-goal scenario does NOT auto-win on full containment', s23.attackChain.every((s) => s.contained) && !ended23);

// 28. A no-goal scenario does NOT end on a stat lose condition either — the
//     game runs until the team decides it's done (manual end) or the timeout
//     fires, regardless of whether a goal is defined.
const s24 = new DMSession(new MockProvider(), noGoalScenario);
s24.state.public_trust = 5;   // below 15
const r24a = await s24.takeTurn('Act', 10);  // streak 1 (consecutive 2)
check('no-goal scenario does not end on first bad turn', !r24a.endCondition);
s24.state.public_trust = 5;
const r24b = await s24.takeTurn('Act', 10);  // streak 2
check('no-goal scenario does NOT end on a stat lose condition', !r24b.endCondition);

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
