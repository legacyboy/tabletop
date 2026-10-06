/**
 * PACING PROBE (real model) — plays one real session and prints, per turn,
 * which story beat the group is in, plus whether the session ended by a LINEAR
 * story win (final beat) with stages possibly left open.
 *
 * Purpose: verify Dan's two design asks (2026-10-06):
 *   1. the story must not drag — the arc should advance most turns; and
 *   2. reaching the final beat WINS even if attack-chain stages are left open.
 *
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/pacing-probe.mjs [turns]
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const loadScenarioLocal = () => JSON.parse(readFileSync(ROOT + 'scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX_TURNS = Number(process.argv[2] || 8);

const provider = new OpenAICompatibleProvider({
  baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL,
});
const s = new DMSession(provider, loadScenarioLocal());
s.companyInfo = 'A mid-sized member-owned credit union.';

console.log(`\n############ PACING PROBE — ${MODEL} (max ${MAX_TURNS} turns) ############\n`);
const open = await s.openScene();
console.log(`OPENING (${open.length} chars): beat=${s.beats[s.currentBeatIndex].id}\n`);

// Competent, coordinated plays aimed at the current beat — the "good group".
const PLAYS = [
  'We publish one clear statement confirming the video is fake, post the CEO live and reachable, brief the frontline so every answer matches, and open a member hotline.',
  'We drive takedowns with the platforms, brief the regulator and the deposit insurer with facts and a timeline, and task the fraud team to freeze accounts tied to the panic.',
  'We investigate the agency channel and the amplifier network to attribute the attack, and we keep members updated hourly.',
  'We close the compromised marketing channel, harden it, confirm the fraud campaign is shut out, make victims whole, and rebuild member and board confidence.',
];

let end = null;
const beatTrail = [];
for (let i = 0; i < MAX_TURNS && !end; i++) {
  const res = await s.takeTurn(PLAYS[Math.min(i, PLAYS.length - 1)], 15);
  const beat = s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-';
  const contained = s.attackChain.filter((x) => x.contained).map((x) => x.id);
  beatTrail.push({ turn: s.turn, beat, contained: contained.slice() });
  console.log(`TURN ${s.turn}: beat=${beat}  contained=[${contained.join(',') || '-'}]  q=${s.lastBeatQuality || '-'}`);
  console.log(`   ${(res.narrative || '').replace(/\s+/g, ' ').slice(0, 140)}...`);
  if (res.endCondition) end = res.endCondition;
}

console.log('\n--- beat trail ---');
for (const b of beatTrail) console.log(`  turn ${b.turn}: ${b.beat}`);
const beats = s.beats.map((b) => b.id);
const advances = new Set(beatTrail.map((b) => b.beat)).size - 1;
console.log(`\nbeats=${beats.length}  distinct beats visited=${new Set(beatTrail.map((b) => b.beat)).size}  advances=${advances}`);

if (end) {
  console.log(`\nEND: ${end.type}/${end.result}${end.success_kind ? '/' + end.success_kind : ''}` +
    `${end.win_quality ? ' quality=' + end.win_quality : ''}` +
    `${end.open_stages ? ' open=[' + end.open_stages.join(',') + ']' : ''}` +
    `${end.final_beat ? ' finalBeat=' + end.final_beat : ''}`);
  console.log(`WHY: ${end.why || '-'}`);
} else {
  console.log(`\nEND: none after ${s.turn} turns (still playing)`);
}
console.log('');
