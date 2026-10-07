/**
 * PLAYTEST — The Deepfake CEO Crisis, ONE SMALL ACTION PER TURN.
 *
 * Dan (2026-10-07): "A turn of 1 action should not have the dm have entire shit
 * storm of things come back, IF there is still time and turns are early."
 *
 * This run deliberately plays a single, modest action each turn (not a five-front
 * blitz) and prints the DM's response + how much the world moved, so a human can
 * judge whether the DM mirrored the effort or over-reacted. Early turns should
 * read as ONE proportionate development; escalation is only earned later.
 *
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/playtest-ceo-small.mjs [maxTurns]
 */
import { readFileSync } from 'node:fs';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX = parseInt(process.argv[2] || '7', 10);
const scenario = JSON.parse(readFileSync(new URL('../scenarios/bramble-badger-deepfake/scenario.json', import.meta.url), 'utf8'));
const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
const s = new DMSession(provider, scenario);
s.companyInfo = 'First Meridian Credit Union — a mid-sized member-owned credit union, ~$4B in assets.';

// Deliberately SMALL: one modest move per turn. If the DM behaves, each turn
// should get roughly one proportionate development, not a cascade.
const PLAYS = [
  'We put out one plain statement confirming the video is fake.',
  'We pin the CEO live on our own channel to deny it in her own words.',
  'We open a single member hotline for people who are worried.',
  'We ask the platform to take down the clip.',
  'We brief our branch staff so they say the same thing.',
  'We ask the agency for their posting logs.',
  'We tell the regulator what we know so far.',
];

const line = (c = '-') => c.repeat(78);
console.log(`\n${line('#')}\n#  PLAYTEST — CEO Crisis, ONE ACTION PER TURN  (${MODEL})\n${line('#')}\n`);

const open = await s.openScene();
console.log(`OPENING  [beat=${s.beats[s.currentBeatIndex].id}, breach=${s.breachState}]`);
console.log(open.trim());
console.log('');

let end = null;
const trail = [];
for (let i = 0; i < MAX && !end; i++) {
  const action = PLAYS[Math.min(i, PLAYS.length - 1)];
  const roll = 13 + (i % 4);
  const before = JSON.stringify(s.state);
  const res = await s.takeTurn(action, roll);
  const beat = s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-';
  const contained = s.attackChain.filter((x) => x.contained).map((x) => x.id);
  const deltaKeys = Object.keys(res.state).filter((k) => JSON.parse(before)[k] !== res.state[k]);
  trail.push({ turn: s.turn, beat, contained: contained.slice() });

  console.log(line('='));
  console.log(`TURN ${s.turn}  [roll ${roll}]  beat=${beat}  breach=${s.breachState}  contained=[${contained.join(',') || '-'}]  beatQuality=${s.lastBeatQuality || '-'}`);
  console.log(`GROUP (ONE action): ${action}`);
  console.log(line('-'));
  console.log(res.narrative.trim());
  console.log('');
  console.log(`  metrics changed: ${deltaKeys.map((k) => `${k}=${res.state[k]}`).join(' ') || '(none)'}`);
  console.log(`  pace verdict was: ${(s._paceBrief().split('PACING VERDICT:')[1] || '').trim().slice(0, 140)}`);
  if (res.event && res.event.fate) console.log(`  FATE: ${res.event.fate}`);
  if (res.endCondition) end = res.endCondition;
}

console.log(`\n${line('#')}\n#  RESULT\n${line('#')}`);
console.log(`beats: ${s.beats.length}   turns played: ${s.turn}`);
console.log(`arc trail: ${trail.map((t) => `t${t.turn}:${t.beat}`).join('  ')}`);
console.log(`distinct beats visited: ${new Set(trail.map((t) => t.beat)).size}/${s.beats.length}`);
if (end) {
  console.log(`ENDING: ${end.type || '?'}/${end.result || '?'}  quality=${end.win_quality?.tier || '-'}  finalBeat=${end.final_beat || '-'}  open=[${(end.open_stages || []).join(',')}]`);
  console.log(`HOW IT READS: ${end.win_quality?.summary || '-'}`);
  if (end.ending) console.log(`\n${end.ending}`);
} else {
  console.log('NO END within max turns.');
}
process.exit(0);
