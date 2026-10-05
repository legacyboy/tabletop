// Quick test: build a two-part report from a mock session and render HTML.
import { buildReport, renderReportHtml } from '../server/report.js';

// Mock session with a couple of turns.
const session = {
  scenario: {
    scenario_id: 'bramble_badger_deepfake',
    title: 'Bramble Badger Deepfake Crisis',
    report: { title_note: 'Tabletop Exercise Report', audit_note: 'Internal exercise. Not a real incident.' },
  },
  turn: 2,
  startedAt: Date.now() - 125000,
  ending: null,
  state: { budget: 70, public_trust: 57, containment: 40, eradication: 20, recovery: 15, regulator_confidence: 50 },
  attackChain: [
    { id: 'hook', name: 'How they got in', symptom: 'Fraud callers reference the clip.', revealed: true, contained: true },
    { id: 'spread', name: 'How it spread', symptom: 'The clip is amplified.', revealed: true, contained: false },
    { id: 'take', name: 'What they took', symptom: 'Members report credential requests.', revealed: false, contained: false },
  ],
  breachState: 'active',
  history: [
    {
      action: 'Hang up on callers asking about the badger video.',
      roll: 13,
      fate: null,
      narrative: 'The call center staff began disconnecting callers, triggering negative sentiment.',
      state: { budget: 70, public_trust: 57, containment: 40, eradication: 20, recovery: 15, regulator_confidence: 50 },
    },
    {
      action: 'Tell the regulator it is satire and refuse the briefing.',
      roll: 11,
      fate: 'cheese_audit',
      narrative: 'The cheese audit meme wave hit and trust kept sliding.',
      state: { budget: 70, public_trust: 52, containment: 30, eradication: 15, recovery: 10, regulator_confidence: 50 },
    },
  ],
};

const report = buildReport(session, {
  participants: 'Executive team (blind playthrough)',
  moderator: 'Steve (facilitator)',
  recommendations: [
    'Tighten DM prompt to punish reckless play more consistently.',
    'Add a second scenario for variety.',
  ],
});

const html = renderReportHtml(report);
console.log('Report title:', report.report_title);
console.log('Part 1 turns:', report.part1_audit.turns.length);
console.log('Part 2 fingerprint:', report.part2_proof.fingerprint);
console.log('Recommendations:', report.recommendations.length);
console.log('HTML length:', html.length, 'bytes');
console.log('HTML has Part 1:', html.includes('Part 1 — Full Audit'));
console.log('HTML has Part 2:', html.includes('Part 2 — Proof of Play'));
console.log('HTML has Recommendations:', html.includes('Recommendations'));
console.log('HTML has fingerprint:', html.includes(report.part2_proof.fingerprint));
console.log('Attack chain debrief:', JSON.stringify(report.attack_chain_debrief));
console.log('HTML has attack chain debrief:', html.includes('Attack chain debrief'));
console.log('HTML shows contained stage:', html.includes('How they got in'));
console.log('HTML shows missed stage:', html.includes('How it spread'));
console.log('HTML shows breach state:', html.includes('active'));

// ---- v2.1 additions: transcript, usage, player, readable state -----------
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) passed++; else { failed++; console.log('  FAIL', name); } };

// Player attribution + audit trail fields are surfaced.
const s2 = JSON.parse(JSON.stringify(session));
s2.history[0].player = 'Alice';
s2.history[1].player = 'Bob';
s2.history[0].dm_prompt = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }];
s2.history[0].dm_reply = '{"narrative":"raw reply text"}';
s2.tokenUsage = { prompt_tokens: 100, completion_tokens: 40, calls: 3, prompt_estimated: false, completion_estimated: false };
const r2 = buildReport(s2, {});
const h2 = renderReportHtml(r2);

ok('part1_audit carries player', r2.part1_audit.turns[0].player === 'Alice');
ok('part1b transcript exists', !!r2.part1b_transcript && r2.part1b_transcript.turns.length >= 1);
ok('transcript exposes the prompt', !!r2.part1b_transcript.turns[0].dm_prompt);
ok('transcript exposes the raw reply', r2.part1b_transcript.turns[0].dm_reply_raw.includes('raw reply text'));
ok('part3 usage is present', !!r2.part3_usage);
ok('part3 token totals computed', r2.part3_usage.tokens.total_tokens === 140);
ok('part3 shows actions by player', r2.part3_usage.actions_by_player.Alice === 1 && r2.part3_usage.actions_by_player.Bob === 1);
ok('part3 includes an indicative cost', typeof r2.part3_usage.tokens.cost_usd === 'number' && r2.part3_usage.tokens.cost_usd >= 0);
ok('HTML shows the model line', h2.includes('Model'));
ok('HTML shows indicative cost', /Indicative cost/.test(h2));

ok('HTML has a Player column', /<th[^>]*>Player<\/th>/.test(h2));
ok('HTML shows the player name', h2.includes('Alice'));
ok('HTML shows the transcript heading', h2.includes('Full Transcript'));
ok('HTML shows the raw DM reply block', h2.includes('dm reply (raw)'));
ok('HTML shows Part 3 heading', h2.includes('Resource Usage'));
ok('HTML shows the total token count', h2.includes('140'));
ok('HTML shows per-player attribution', h2.includes('Alice: 1'));
ok('HTML does NOT dump raw JSON for state', !h2.includes('{&quot;budget&quot;'));
ok('HTML state is humanized inline', /Public Trust: <b>/.test(h2));
ok('HTML date is human-readable (no raw ISO)', !/Generated 20\d\d-\d\d-\d\dT/.test(h2));

// Graceful when no player was recorded at all.
const s3 = JSON.parse(JSON.stringify(session));
const r3 = buildReport(s3, {});
ok('no-player session still builds', !!r3 && !!r3.part3_usage);
ok('no-player actions_by_player is empty', Object.keys(r3.part3_usage.actions_by_player).length === 0);

console.log(`report.test additions: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
