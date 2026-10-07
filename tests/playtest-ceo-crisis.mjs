/**
 * PLAYTEST — "The Deepfake CEO Crisis" (bramble_badger_deepfake), played like a
 * real facilitation group: coordinated but imperfect actions, one turn at a
 * time, following the arc. Prints the full DM narrative each turn plus the arc
 * position, containment, breach state, and metrics — so a human can read how the
 * story plays. Then writes the two-sided transcript (JSON + HTML) via the real
 * report builders.
 *
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/playtest-ceo-crisis.mjs [maxTurns]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { buildReport, renderReportHtml } from '../server/report.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX = parseInt(process.argv[2] || '8', 10);
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });

const scenario = JSON.parse(readFileSync(ROOT + 'scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));
const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
const s = new DMSession(provider, scenario);
s.castInfo = 'First Meridian Credit Union — a mid-sized member-owned credit union, ~$4B in assets.';

// A realistic, coordinated-but-imperfect run: strong comms early, but the group
// is a little slow to eradicate and never quite closes the "spread" stage —
// exactly the partial-containment case Dan described.
const PLAYS = [
  'Comms drafts one plain statement confirming the video is fake and pinning the CEO live on the record within the hour; we brief the whole frontline so every branch answer matches, and open a member hotline.',
  'We push platform takedowns on the 30-second cut and the hashtag, brief the regulator and the deposit insurer with what we know and a timeline, and task the fraud team to watch for account-drain patterns.',
  'We lean on the marketing agency for their console logs, get law enforcement looped in on attribution, and start freezing accounts showing the pattern.',
  'We rotate the agency credentials, enforce MFA, revoke the compromised posting account, and put out an hourly member update. We still have not nailed the amplifier network.',
  'We publish a plain-language timeline, make the first fraud victims whole, and start rebuilding trust with a member town hall.',
  'We harden the marketing channel for good, keep the fraud campaign locked out, and hand attribution evidence to law enforcement.',
];

const line = (c = '-') => c.repeat(78);
console.log(`\n${line('#')}\n#  PLAYTEST — The Deepfake CEO Crisis  (${MODEL})\n${line('#')}\n`);

const open = await s.openScene();
console.log(`OPENING SCENE  [beat=${s.beats[s.currentBeatIndex].id}, breach=${s.breachState}]`);
console.log('─'.repeat(78));
console.log(open.trim());
console.log('');

let end = null;
const trail = [];
for (let i = 0; i < MAX && !end; i++) {
  const action = PLAYS[Math.min(i, PLAYS.length - 1)];
  const roll = 12 + (i % 5); // mostly decent rolls, a couple of ordinary ones
  const res = await s.takeTurn(action, roll);
  const beat = s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-';
  const contained = s.attackChain.filter((x) => x.contained).map((x) => x.id);
  trail.push({ turn: s.turn, beat, contained: contained.slice() });

  console.log(line('='));
  console.log(`TURN ${s.turn}  [roll ${roll}]  beat=${beat}  breach=${s.breachState}  contained=[${contained.join(',') || '-'}]  beatQuality=${s.lastBeatQuality || '-'}`);
  console.log(`GROUP: ${action}`);
  console.log(line('-'));
  console.log((res.narrative || '').trim());
  const st = s.state;
  console.log(`\n  metrics: trust=${st.public_trust} reg=${st.regulator_confidence} sec=${st.security_posture} containment=${st.containment} eradication=${st.eradication} recovery=${st.recovery}${s.collapsed ? '   [IN CRISIS]' : ''}`);
  console.log('');
  if (res.endCondition) end = res.endCondition;
}

console.log(line('#'));
console.log('#  RESULT');
console.log(line('#'));
console.log(`beats: ${s.beats.length}   turns played: ${s.turn}`);
console.log('arc trail: ' + trail.map((t) => `t${t.turn}:${t.beat}`).join('  '));
const distinct = new Set(trail.map((t) => t.beat)).size;
console.log(`distinct beats visited: ${distinct}/${s.beats.length}`);
if (end) {
  console.log(`ENDING: ${end.type}/${end.result}${end.success_kind ? '/' + end.success_kind : ''}` +
    `${end.win_quality ? '  quality=' + end.win_quality : ''}` +
    `${end.final_beat ? '  finalBeat=' + end.final_beat : ''}` +
    `${end.open_stages ? '  open=[' + end.open_stages.join(',') + ']' : ''}`);
  console.log(`HOW IT READS: ${end.win_summary || '-'}`);
  console.log(`WHY: ${end.why || '-'}`);
  console.log(`\n${end.ending || ''}`);
} else {
  console.log(`ENDING: none after ${s.turn} turns (still playing)`);
}

// --- write the two-sided transcript via the real report builders ---
const report = buildReport(s, { ending: end });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = join(OUT, `playtest-ceo-crisis-${stamp}.json`);
const htmlPath = join(OUT, `playtest-ceo-crisis-${stamp}.html`);
writeFileSync(jsonPath, JSON.stringify({ report, transcript: s.history }, null, 2));
try {
  writeFileSync(htmlPath, renderReportHtml(report, { title: 'Playtest — The Deepfake CEO Crisis' }));
} catch (e) { console.log('(html render skipped: ' + e.message + ')'); }
console.log(`\ntranscript: ${jsonPath}`);
console.log(`report:     ${htmlPath}\n`);
