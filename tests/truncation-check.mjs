// T2 — single-turn truncation check for the DM reply.
// Drives ONE full realistic turn and asserts the narrative COMPLETES.
// Tests BOTH routes: native Ollama (our fix) and the /v1 OpenAI-compatible path.
// Usage: TEST_MODEL=deepseek-v4.1-flash:cloud node tests/truncation-check.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const MODEL = process.env.TEST_MODEL || 'deepseek-v4.1-flash:cloud';
const ROOT = new URL('../', import.meta.url).pathname;
const scenario = JSON.parse(readFileSync(join(ROOT, 'scenarios/bramble-badger-deepfake/scenario.json'), 'utf8'));

const ACTION =
  'Issue a calm public statement confirming the video is fake, freeze the fraudulent ' +
  'accounts, contact the regulator with a full package, brief all branch staff, and ' +
  'launch a member-outreach campaign across email and phone.';

function endsClean(s) {
  return /[.!?"')\]]\s*$/.test(String(s).trim());
}

async function driveOne(baseUrl, label) {
  const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: '', model: MODEL });
  const session = new DMSession(provider, scenario);
  session.companyInfo = 'Bramble Badger Credit Union is a mid-sized member-owned cooperative.';
  session.start();
  const res = await session.takeTurn(ACTION, 15);
  const n = res.narrative || '';
  const leaksJson = /"narrative"\s*:/.test(n) || /^\s*\{/.test(n);
  const fallback = /returned no narrative/i.test(n);
  const ok = n.length > 400 && endsClean(n) && !leaksJson && !fallback;
  console.log(`\n[${label}] base=${baseUrl}`);
  console.log(`  narrative len : ${n.length}`);
  console.log(`  ends clean    : ${endsClean(n)}`);
  console.log(`  json leak     : ${leaksJson}`);
  console.log(`  fallback used : ${fallback}`);
  console.log(`  RESULT        : ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`  tail: ...${n.slice(-90)}`);
  return ok;
}

const results = [];
// Native route (our fix): Ollama honours num_ctx here.
results.push(await driveOne('http://localhost:11434', 'OLLAMA-NATIVE-FIX'));
// /v1 route (what the live browser path is built on).
results.push(await driveOne('http://localhost:11434/v1', 'OLLAMA-V1'));

console.log('\n=== T2 SUMMARY ===');
console.log(`model: ${MODEL}`);
console.log(`passed: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
