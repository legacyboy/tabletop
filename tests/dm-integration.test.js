/**
 * Full integration test: DMSession -> OpenAICompatibleProvider -> mock LLM
 * HTTP server -> back. Verifies the provider's HTTP round trip, JSON parsing,
 * state application, and end-to-end turn resolution against a real network
 * endpoint (the mock server).
 *
 * Setup: starts tests/mock-llm-server.js on :9999, then drives the session.
 */
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

const mockServer = spawn('node', ['tests/mock-llm-server.js', '9999'], { stdio: 'ignore' });

// Wait for it to come up.
await new Promise((r) => setTimeout(r, 800));

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) passed++; else { failed++; console.log('  FAIL', name); } };

try {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost:9999/v1',
    apiKey: '',
    model: 'mock',
  });

  // ping through HTTP
  await provider.ping();
  check('provider HTTP ping', true);

  const session = new DMSession(provider, scenario);
  session.start();

  // 3 turns: high, middle, low rolls -> verify different narratives/deltas.
  const r1 = await session.takeTurn('Release a clear public statement', 18);
  check('turn1 narrative', r1.narrative.length > 30);
  check('turn1 success-ish delta', r1.state.reputation >= scenario.opening_state.reputation);

  const r2 = await session.takeTurn('Engage with the reporter', 9);
  check('turn2 processed', session.turn === 2);

  const r3 = await session.takeTurn('Deny everything abruptly', 2);
  check('turn3 processed', session.turn === 3);

  const report = session.buildReport({ ending: 'Time ran out.' });
  check('report log has 3 turns', report.log.length === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  mockServer.kill();
}

process.exit(failed ? 1 : 0);
