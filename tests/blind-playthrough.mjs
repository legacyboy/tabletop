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
import { randomScenarioShell } from '../app/js/scenarios.js';
import { readFileSync } from 'node:fs';

const OLLAMA = 'http://localhost:11434/v1';
const DM_MODEL = 'gemma3:4b';
const PLAYER_MODEL = process.argv[2] || 'gemma4:31b-cloud';
const TURNS = Number(process.argv[3]) || 20;
const RANDOM = process.argv.includes('--random') || process.argv.includes('random');

// Load the scenario. In random mode we use the generated shell: the DM invents
// the brief, opening state, goal, and events on the fly from a generic prompt.
let scenario;
if (RANDOM) {
  scenario = randomScenarioShell();
} else {
  scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));
}

// The DM (Gemma 4b, local).
const dmProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: DM_MODEL });
// The player (Gemma 31b cloud by default — reliable, no empty replies).
const playerProvider = new OpenAICompatibleProvider({ baseUrl: OLLAMA, apiKey: '', model: PLAYER_MODEL });

const session = new DMSession(dmProvider, scenario);
if (RANDOM) session.random = true;
session.start();

// In random mode, the DM needs to invent and narrate the opening scene before
// the player can act. We ask the DM to generate it as turn 0, then feed that
// narration to the player as the situation it must respond to.
let generatedIntro = scenario.intro.narrative;
if (RANDOM) {
  console.log('Random mode: asking the DM to generate the opening scene...');
  const scene = await session.takeTurn(
    'The executive team convenes to open the session. The moderator asks the DM to present the situation and the opening scene.',
    playerRoll()
  );
  generatedIntro = scene.narrative;
  console.log(`\n[DM-GENERATED OPENING] ${generatedIntro}\n`);
  console.log(`Generated opening state: ${JSON.stringify(scene.state)}\n`);
}

// Player system prompt: they advise the executive team, blind to the design.
// Framed as "helping a crisis team" (not "you ARE the team") because some
// models (DeepSeek Pro) return empty on direct roleplay framing.
const playerSystem = [
  'You are helping a crisis management team at a financial cooperative.',
  'Given a developing situation, state the single most sensible next action the team should take.',
  'Be concrete, decisive, and realistic. You are under time pressure.',
  'Reply with ONLY a short, concrete action (1-3 sentences). Do not ask questions — state what the team does.',
  'Never return an empty or blank reply. If you are unsure, still commit to one concrete action.',
  'Do not mention that you are an AI or a model.',
].join('\n');

// The action prompt is very short and must yield a concrete action. Because
// some player models return empty replies on the first try, we use escalating
// prompt variants and keep retrying until we get a real, non-empty action.
// A test that silently falls back to a canned action on empty replies gives
// misleading balance results, so we treat empty as a hard failure to fix.
const playerActionTemplates = [
  (ctx) => ctx + '\n\nWhat does your team do next? Reply with ONE concrete action.',
  (ctx) => ctx + '\n\nGive exactly ONE specific, actionable step the team takes right now (1-2 sentences). Do not be vague. Do not return blank.',
  (ctx) => ctx + '\n\nYou MUST reply with a concrete action now. State the single most important thing the team does. No preamble, no questions, no blank.',
];

// Tried-and-true constructive fallback if the model still refuses to answer
// after every retry. We log it as a HARD failure so the run is clearly marked
// as degraded, not silently accepted.
const CONSTRUCTIVE_FALLBACK =
  'The team issues a clear public statement confirming the video is a hoax, directs members to official channels, and instructs contact-centre staff to route suspicious calls to a dedicated fraud line.';

/**
 * Get a non-empty action from the player model, retrying with escalating
 * prompts. Returns { action, usedFallback }.
 */
async function getPlayerAction(playerProvider, playerContext, turn) {
  let emptyCount = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const template = playerActionTemplates[Math.min(attempt, playerActionTemplates.length - 1)];
    const resp = await playerProvider.chat(
      [
        { role: 'system', content: playerSystem },
        { role: 'user', content: template(playerContext) },
      ],
      { temperature: 0.7, maxTokens: 120 }
    );
    const action = (resp || '').trim();
    if (action) return { action, usedFallback: false };
    emptyCount++;
    console.log(`  (player returned empty on attempt ${attempt + 1}, retrying...)`);
  }
  // Hard failure: the model gave nothing after 6 tries.
  console.log(`  *** WARNING: player returned ${emptyCount} empty replies in a row; using constructive fallback ***`);
  return { action: CONSTRUCTIVE_FALLBACK, usedFallback: true };
}

/**
 * Generate the player's D20 roll.
 *
 * IMPORTANT: we do NOT ask the LLM to "roll" — LLMs cannot produce uniformly
 * random numbers (they cluster near 10-16), which biased the earlier runs.
 * The real app uses Math.floor(Math.random()*20)+1 (a uniform 1-20 digital
 * die) or a physical die. We mirror that here so the test roll distribution
 * matches the real game.
 */
function playerRoll() {
  return Math.floor(Math.random() * 20) + 1;
}

console.log('='.repeat(70));
console.log(`BLIND PLAYTHROUGH — Player: ${PLAYER_MODEL} | DM: ${DM_MODEL}${RANDOM ? ' | RANDOM MODE' : ''}`);
console.log('='.repeat(70));
console.log(`\nINTRO (what the player sees):\n${generatedIntro}\n`);
if (!RANDOM) console.log(`Opening state: ${JSON.stringify(scenario.opening_state)}\n`);

for (let turn = 1; turn <= TURNS; turn++) {
  console.log('-'.repeat(70));

  // Build the player's context: intro + DM narrative so far.
  const playerContext = [
    `Situation: ${generatedIntro}`,
    ...session.history.map((e) => `\n[Turn ${e.turn}] You did: "${e.action}" (d20=${e.roll}).\nThe result: ${e.narrative}`),
    `\nIt is now turn ${turn}. What does your team do next?`,
  ].join('\n');

  // Player decides an action (robust retry — see getPlayerAction).
  const { action, usedFallback } = await getPlayerAction(playerProvider, playerContext, turn);

  // Player rolls a D20 — truly random, mirroring the real app's digital die.
  const roll = playerRoll();

  console.log(`\n[PLAYER TURN ${turn}] Action: ${action.trim()}${usedFallback ? ' [FALLBACK]' : ''}`);
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
