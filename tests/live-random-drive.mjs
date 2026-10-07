// Headless end-to-end RANDOM run: drive the app's Random-mode path through a
// real local Ollama model — exactly like the browser does.
// Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/live-random-drive.mjs [maxTurns]
import { randomScenarioShell } from '../app/js/scenarios.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX = parseInt(process.argv[2] || '6', 10);
const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });

// Random mode: the app builds a shell and tells the DM to generate the scenario.
const scenario = randomScenarioShell();
const s = new DMSession(provider, scenario);
s.random = true; // mirrors main.js: if (state.isRandom) state.session.random = true

console.log(`=== RANDOM MODE (${MODEL}) ===`);
const opening = await s.openScene();
console.log(`\nOPENING [turn 0] (${opening.length} chars):\n${opening.trim()}\n`);

const ACTIONS = [
  'We convene the leadership team, establish a single point of contact, and get the facts before we say anything publicly.',
  'We put out a short, honest holding statement and brief the front line so every answer matches.',
  'We brief the board and the relevant regulator with a timeline, and protect anyone who raised concerns.',
  'We run our own investigation, fix what is genuinely wrong, and commit to a visible follow-through.',
  'We communicate progress to staff and members and close out the remediation.',
];

let end = null;
for (let i = 0; i < MAX && !end; i++) {
  const roll = [3, 7, 14, 20, 11][i % 5];
  const res = await s.takeTurn(ACTIONS[Math.min(i, ACTIONS.length - 1)], roll);
  const narr = (res.narrative || '').trim();
  const st = s.state || {};
  const beat = s.beats && s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-';
  console.log('='.repeat(78));
  console.log(`TURN ${s.turn}  beat=${beat}  breach=${s.breachState}  d20=${roll}  q=${s.lastBeatQuality || '-'}`);
  console.log(narr);
  console.log(`  metrics: trust=${st.public_trust} reg=${st.regulator_confidence} contain=${st.containment} erad=${st.eradication} rec=${st.recovery}`);
  if (res.endCondition) end = res.endCondition;
}

console.log('='.repeat(78));
if (end) {
  console.log(`ENDING: ${end.type}/${end.result}`);
  console.log(`HOW IT READS: ${end.win_summary || end.why || '-'}`);
} else {
  console.log(`ENDING: none after ${s.turn} turns (still playing)`);
}
console.log(`\nRESULT: random mode ran ${s.turn} turns, opening ${opening.length} chars, ${end ? 'resolved' : 'in progress'}`);
