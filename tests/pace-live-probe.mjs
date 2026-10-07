/**
 * LIVE probe: does the DM actually receive the pace brief, and does the fate
 * table fire good AND bad with the real model? Prints the pace brief per turn.
 * Usage: node tests/pace-live-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));
const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud' });
const s = new DMSession(provider, scenario);
s.start();
console.log(`budget: targetTurn=${s.targetTurn} totalTurn=${s.totalTurn} duration=${s.durationSeconds}s`);
await s.openScene();
const rolls = [7, 11, 1];
let i = 0;
for (const roll of rolls) {
  console.log(`\n===== TURN ${s.turn + 1} (roll ${roll}) =====`);
  console.log(s._paceBrief().trim());
  const r = await s.takeTurn('The group commits to a focused response: one clear public statement and one containment step.', roll);
  const ev = r.event || {};
  console.log(`fate: ${ev.fate ? ev.fate.slice(0, 90) + '...' : '(none)'}`);
  console.log(`beatIdx=${s.currentBeatIndex} turn=${s.turn} metrics=${JSON.stringify(r.state)}`);
  if (r.endCondition) { console.log('END:', JSON.stringify(r.endCondition)); break; }
}
