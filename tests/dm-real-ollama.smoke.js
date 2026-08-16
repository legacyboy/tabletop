/**
 * Integration smoke test of ONE real DM turn against a local Ollama
 * OpenAI-compatible endpoint. Verifies the LLM actually returns parseable JSON
 * and the session applies it. Skips silently if Ollama is unreachable.
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

const BASE = process.env.OLLAMA_URL || 'http://localhost:11434/v1';
const MODEL = process.env.MODEL || 'glm-5.2:cloud';

console.log(`Testing against ${BASE} model=${MODEL}...`);

const provider = new OpenAICompatibleProvider({
  baseUrl: BASE,
  apiKey: '',
  model: MODEL,
});

// Quick ping
try {
  await provider.ping();
  console.log('  ping OK');
} catch (e) {
  console.log('  SKIP: Ollama unreachable or model missing:', e.message);
  process.exit(0);
}

const session = new DMSession(provider, scenario);
session.companyInfo = 'Bramble Badger Credit Union is a mid-sized member-owned cooperative.';
session.start();

const res = await session.takeTurn(
  'Issue a calm public statement saying the video is a hoax, reassure members their funds are safe, and tell staff what to say.',
  15
);

console.log('  NARRATIVE:', res.narrative.slice(0, 200));
console.log('  TURN:', session.turn);
console.log('  STATE:', JSON.stringify(res.state));
console.log('\nOne real DM turn completed:', res.narrative.length > 20 && session.turn === 1 ? 'OK' : 'ISSUE');
process.exit(res.narrative.length > 20 ? 0 : 1);
