/**
 * Blind playthrough — POOR PLAY variant.
 *
 * The player LLM deliberately plays badly (ignores the situation, makes
 * reckless/indifferent decisions) to stress-test how the DM reacts to poor
 * play. The DM is Gemma 3 4b (local). We want to see: does the DM punish bad
 * decisions? Does state collapse? Do end conditions fire?
 *
 * Usage:
 *   node tests/blind-playthrough-poor.mjs <player-model> [turns]
 *   e.g. node tests/blind-playthrough-poor.mjs glm-5.2:cloud 5
 *        node tests/blind-playthrough-poor.mjs deepseek-v4-pro:cloud 5
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';

const OLLAMA = 'http://localhost:11434/v1';
const DM_MODEL = process.env.DM_MODEL || 'deepseek-v4-flash:cloud';
const PLAYER_MODEL = process.argv[2] || 'glm-5.2:cloud';
const TURNS = Number(process.argv[3]) || 20;

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

const dmProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: DM_MODEL });
const playerProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: PLAYER_MODEL });

const session = new DMSession(dmProvider, scenario);
session.start();

// Player is instructed to play POORLY: dismissive, reckless, indifferent.
const playerSystem = [
  'You are helping a crisis management team at a financial cooperative.',
  'You are deliberately playing POORLY for a stress test: you are dismissive, reckless, and indifferent to the situation.',
  'You ignore warnings, make careless decisions, and do not take the situation seriously.',
  'Reply with ONLY a short, concrete action (1-3 sentences) that reflects this poor, reckless attitude.',
  'Do not mention that you are an AI or a model.',
].join('\n');

console.log('='.repeat(70));
console.log(`POOR-PLAY BLIND TEST — Player: ${PLAYER_MODEL} | DM: ${DM_MODEL}`);
console.log('='.repeat(70));
console.log(`\nINTRO (what the player sees):\n${scenario.intro.narrative}\n`);
console.log(`Opening state: ${JSON.stringify(scenario.opening_state)}\n`);

for (let turn = 1; turn <= TURNS; turn++) {
  console.log('-'.repeat(70));

  const playerContext = [
    `Situation: ${scenario.intro.narrative}`,
    ...session.history.map((e) => `\n[Turn ${e.turn}] You did: "${e.action}" (d20=${e.roll}).\nThe result: ${e.narrative}`),
    `\nIt is now turn ${turn}. What does your team do next?`,
  ].join('\n');

  // Player decides a (poor) action, with retry on empty.
  let action = '';
  for (let attempt = 0; attempt < 3 && !action.trim(); attempt++) {
    const resp = await playerProvider.chat(
      [{ role: 'system', content: playerSystem }, { role: 'user', content: playerContext }],
      { temperature: 0.7, maxTokens: 120 }
    );
    action = (resp || '').trim();
  }
  if (!action.trim()) {
    action = 'The team does nothing and hopes it blows over.';
    console.log('  (player returned no action; using fallback)');
  }

  // Player rolls (deliberately low, to play poorly).
  const rollResp = await playerProvider.chat(
    [
      { role: 'system', content: 'You are rolling a D20 for your reckless action. Reply with ONLY a number from 1 to 20.' },
      { role: 'user', content: `Your team's action: ${action}\nRoll the D20.` },
    ],
    { temperature: 0.5, maxTokens: 5 }
  );
  const rollMatch = rollResp.match(/\b([1-9]|1[0-9]|20)\b/);
  const roll = rollMatch ? Number(rollMatch[1]) : Math.floor(Math.random() * 20) + 1;

  console.log(`\n[PLAYER TURN ${turn}] Action: ${action.trim()}`);
  console.log(`  Roll: ${roll}`);

  const result = await session.takeTurn(action.trim(), roll);
  console.log(`\n[DM] ${result.narrative}`);
  console.log(`  State: ${JSON.stringify(result.state)}`);

  if (result.endCondition) {
    console.log(`\n*** END CONDITION: ${result.endCondition.ending} ***`);
    break;
  }
  console.log('');
}

console.log('='.repeat(70));
console.log('\nSESSION SUMMARY');
console.log(`Turns: ${session.turn}`);
console.log(`Final state: ${JSON.stringify(session.state)}`);
console.log('='.repeat(70));
