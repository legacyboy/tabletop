/**
 * Blind playthrough test.
 *
 * A "player" LLM (GLM 5.2 or DeepSeek Pro) plays the executive team BLIND:
 * it only sees the scenario intro (like a real player), makes decisions, and
 * rolls a D20. The DM (Gemma 3 4b, local) adjudicates each action and updates
 * state. This tests whether the DM runs a coherent, open-ended session and
 * whether the player can play sensibly without seeing the scenario design.
 *
 * Usage:
 *   node tests/blind-playthrough.mjs <player-model> [turns]
 *   e.g. node tests/blind-playthrough.mjs glm-5.2:cloud 4
 *        node tests/blind-playthrough.mjs deepseek-v4-pro:cloud 4
 *
 * The player is prompted as a fresh executive team member who has just been
 * handed the situation. It never sees the DM brief, fate table, or end
 * conditions — only the intro narrative and the DM's in-world responses.
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';

const OLLAMA = 'http://localhost:11434/v1';
const DM_MODEL = 'gemma3:4b';
const PLAYER_MODEL = process.argv[2] || 'glm-5.2:cloud';
const TURNS = Number(process.argv[3]) || 4;

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

// The DM (Gemma 4b, local).
const dmProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: DM_MODEL });
// The player (GLM 5.2 or DeepSeek Pro).
const playerProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: PLAYER_MODEL });

const session = new DMSession(dmProvider, scenario);
session.start();

// Player system prompt: they advise the executive team, blind to the design.
// Framed as "helping a crisis team" (not "you ARE the team") because some
// models (DeepSeek Pro) return empty on direct roleplay framing.
const playerSystem = [
  'You are helping a crisis management team at a financial cooperative.',
  'Given a developing situation, state the single most sensible next action the team should take.',
  'Be concrete, decisive, and realistic. You are under time pressure.',
  'Reply with ONLY a short, concrete action (1-3 sentences). Do not ask questions — state what the team does.',
  'Do not mention that you are an AI or a model.',
].join('\n');

console.log('='.repeat(70));
console.log(`BLIND PLAYTHROUGH — Player: ${PLAYER_MODEL} | DM: ${DM_MODEL}`);
console.log('='.repeat(70));
console.log(`\nINTRO (what the player sees):\n${scenario.intro.narrative}\n`);
console.log(`Opening state: ${JSON.stringify(scenario.opening_state)}\n`);

let roll = 0;
for (let turn = 1; turn <= TURNS; turn++) {
  console.log('-'.repeat(70));

  // Build the player's context: intro + DM narrative so far.
  const playerContext = [
    `Situation: ${scenario.intro.narrative}`,
    ...session.history.map((e) => `\n[Turn ${e.turn}] You did: "${e.action}" (d20=${e.roll}).\nThe result: ${e.narrative}`),
    `\nIt is now turn ${turn}. What does your team do next?`,
  ].join('\n');

  // Player decides an action (retry if empty).
  let action = '';
  for (let attempt = 0; attempt < 3 && !action.trim(); attempt++) {
    const resp = await playerProvider.chat(
      [
        { role: 'system', content: playerSystem },
        { role: 'user', content: playerContext },
      ],
      { temperature: 0.7, maxTokens: 120 }
    );
    action = (resp || '').trim();
    if (!action.trim() && attempt < 2) {
      console.log('  (player returned empty action, retrying...)');
    }
  }
  if (!action.trim()) {
    action = 'The team convenes to reassess the situation and prepare a coordinated response.';
    console.log('  (player returned no action; using fallback)');
  }

  // Player rolls a D20 (the player model picks a number 1-20).
  const rollResp = await playerProvider.chat(
    [
      { role: 'system', content: 'You are rolling a D20 for your action. Reply with ONLY a number from 1 to 20.' },
      { role: 'user', content: `Your team's action: ${action}\nRoll the D20.` },
    ],
    { temperature: 0.5, maxTokens: 5 }
  );
  const rollMatch = rollResp.match(/\b([1-9]|1[0-9]|20)\b/);
  roll = rollMatch ? Number(rollMatch[1]) : Math.floor(Math.random() * 20) + 1;

  console.log(`\n[PLAYER TURN ${turn}] Action: ${action.trim()}`);
  console.log(`  Roll: ${roll}`);

  // DM adjudicates.
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
