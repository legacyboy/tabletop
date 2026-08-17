/**
 * Test tabletop: Steve plays the executive team, Gemma 3 4b (local Ollama) is
 * the DM. Runs a full multi-turn session with real decisions, rolls, and
 * state tracking. This is the "run a test tabletop as the players" demo.
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));
const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434/v1',
  apiKey: '',
  model: process.env.MODEL || 'gemma3:4b',
});

const session = new DMSession(provider, scenario);
session.start();

console.log('='.repeat(70));
console.log(`TABLETOP TEST — ${scenario.title}`);
console.log(`DM: ${session.provider.model} | Players: Steve (executive team)`);
console.log('='.repeat(70));
console.log(`\nINTRO: ${scenario.intro.narrative}\n`);
console.log(`Opening state: ${JSON.stringify(scenario.opening_state)}\n`);

// Steve plays the group. Each turn: decide an action, roll a D20.
const plays = [
  {
    action: 'We assemble the executive team: Security, Legal, Comms, and Risk. We preserve the video and its metadata as evidence, and we do NOT post anything publicly yet. We draft a short internal holding script for the contact centre so staff give one consistent answer.',
    roll: 16,
  },
  {
    action: 'A reporter calls asking if we are hiding a cyber incident. We approve a short holding statement: the clip is unverified, an investigation is underway, and there is no confirmed member account impact. We do not speculate.',
    roll: 12,
  },
  {
    action: 'Fraud reports that callers are referencing the badger clip to ask members for online banking credentials. We issue clear member fraud guidance across web, social, branches, and the contact centre, and we flag the pattern to Security.',
    roll: 18,
  },
  {
    action: 'A board member forwards the clip and asks what is happening. We send a concise board brief: what is known, what is unknown, current actions, and when the next update will come.',
    roll: 9,
  },
];

let turn = 0;
for (const play of plays) {
  turn++;
  console.log('-'.repeat(70));
  console.log(`\n[PLAYER TURN ${turn}] The group decides to:\n  "${play.action}"`);
  console.log(`\n  They roll a D20: ${play.roll}\n`);

  const result = await session.takeTurn(play.action, play.roll);
  console.log(`[DM — roll ${play.roll}]`);
  console.log(`  ${result.narrative}\n`);
  console.log(`  State now: ${JSON.stringify(result.state)}`);

  if (result.endCondition) {
    console.log(`\n  *** END CONDITION: ${result.endCondition.ending} ***`);
    break;
  }
  console.log('');
}

console.log('='.repeat(70));
console.log('\nSESSION SUMMARY');
console.log(`Turns played: ${session.turn}`);
console.log(`Final state: ${JSON.stringify(session.state)}`);

const report = session.buildReport({ ending: 'Test session completed.' });
console.log(`\nReport turns: ${report.turns}`);
console.log('='.repeat(70));
