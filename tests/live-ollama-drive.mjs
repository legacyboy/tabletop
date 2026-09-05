// Headless end-to-end test: drive each scenario through a real local Ollama model.
// Usage: node tests/live-ollama-drive.mjs [scenario_id ...]
// Uses local Ollama (OpenAI-compatible) so no API key needed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const MODEL = process.env.TEST_MODEL || 'gemma3:4b';
const BASE = 'http://localhost:11434/v1';
const SCEN_DIR = new URL('../', import.meta.url).pathname; // tabletop root; registry paths start with 'scenarios/'

const provider = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: '', model: MODEL });

function loadScenario(entry) {
  const f = join(SCEN_DIR, entry.path);
  return JSON.parse(readFileSync(f, 'utf8'));
}

const registry = JSON.parse(readFileSync(join(SCEN_DIR, 'scenarios/registry.json'), 'utf8'))
  .filter((e) => e.id !== 'random');

const targets = process.argv.slice(2);
const entries = targets.length
  ? registry.filter((e) => targets.includes(e.id))
  : registry;

let pass = 0, fail = 0;
for (const entry of entries) {
  const id = entry.id;
  const scenario = loadScenario(entry);
  const session = new DMSession(provider, scenario);
  const label = `${id} (${scenario.title})`;
  try {
    // 1. Opening scene must be narrated
    const opening = await session.openScene();
    if (!opening || opening.length < 20) throw new Error('opening scene too short/empty');
    console.log(`\n=== ${label} ===`);
    console.log(`OPENING (${opening.length} chars): ${opening.slice(0, 140).replace(/\n/g,' ')}...`);

    // 2. A few player turns with realistic actions
    const actions = [
      'We issue a public statement and set up a crisis line for members.',
      'We brief the board and regulator, and start an internal investigation.',
      'We follow up with affected members and review our controls.',
    ];
    for (let i = 0; i < actions.length; i++) {
      const res = await session.takeTurn(actions[i], 12);
      const narr = (res && (res.narrative || res.text)) || '';
      if (!narr || narr.length < 20) throw new Error(`turn ${i + 1} produced no narrative`);
      const st = session.state || {};
      console.log(`TURN ${i + 1} (${narr.length} chars): ${narr.slice(0, 110).replace(/\n/g,' ')}...`);
      console.log(`   state: trust=${st.public_trust} reg=${st.regulator_confidence} contain=${st.containment}`);
    }
    pass++;
    console.log(`PASS ${label}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${label}: ${e.message}`);
  }
}
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
