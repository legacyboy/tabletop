// Focused live test: Deepfake CEO Crisis, 7 turns, full per-turn detail.
// Usage: node tests/live-deepfake-7.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const MODEL = process.env.TEST_MODEL || 'gemma3:4b';
const BASE = 'http://localhost:11434/v1';
const ROOT = new URL('../', import.meta.url).pathname;

const provider = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: '', model: MODEL });
const scenario = JSON.parse(readFileSync(join(ROOT, 'scenarios/bramble-badger-deepfake/scenario.json'), 'utf8'));
const session = new DMSession(provider, scenario);

console.log(`\n########## ${scenario.title} ##########`);
console.log(`GOAL: ${scenario.goal.description}\n`);

// Opening
const opening = await session.openScene();
console.log(`\n--- OPENING SCENE ---\n${opening}\n`);

// 7 player turns — a realistic crisis-response arc
const actions = [
  'We issue a public statement confirming the video is a deepfake and set up a member hotline.',
  'We brief the board and the regulator, and start tracing where the video was seeded from.',
  'We activate fraud monitoring and warn members about phishing referencing the video.',
  'We publish a second statement with the CEO speaking directly, and post a FAQ for members.',
  'We work with the platform to take down the deepfake and identify the amplifier network.',
  'We follow up with affected members, review our controls, and prepare a lessons-learned.',
  'We hold a town hall for staff and give the regulator a full timeline and evidence package.',
];

for (let i = 0; i < actions.length; i++) {
  const res = await session.takeTurn(actions[i], 12);
  const narr = (res && (res.narrative || res.text)) || '';
  const st = session.state || {};
  console.log(`\n--- TURN ${i + 1} ---`);
  console.log(`ACTION: ${actions[i]}`);
  console.log(`NARRATIVE:\n${narr}\n`);
  console.log(`STATE: budget=${st.budget} trust=${st.public_trust} reg=${st.regulator_confidence} sec=${st.security_posture} contain=${st.containment} erad=${st.eradication} recover=${st.recovery}`);
  console.log('----------------------------------------');
  if (res.endCondition) {
    console.log(`\n*** END: ${res.endCondition.type} (${res.endCondition.result}) ***`);
    console.log(res.endCondition.ending);
    break;
  }
}

// Sanity: the attacker_progress metric is gone entirely.
if ('attacker_progress' in (session.state || {})) {
  console.log('\nFAIL: attacker_progress still present in the state!');
  process.exit(1);
}
const st = session.state || {};
console.log(`\nFINAL: trust=${st.public_trust} reg=${st.regulator_confidence} contain=${st.containment} erad=${st.eradication} recover=${st.recovery}`);
console.log('NO attacker_progress in state. DONE');
