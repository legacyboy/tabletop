/**
 * Turn-level truncation sweep — the case that actually bit Dan.
 * Runs many CONSECUTIVE turns in ONE session (context grows each turn, which
 * is where truncation shows up) and checks every narrative completes.
 * Usage: DM_MODEL=... node tests/turn-truncation-sweep.mjs [turns]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const TURNS = parseInt(process.argv[2] || '15', 10);
const ROOT = new URL('../', import.meta.url).pathname;

const endsClean = (s) => /[.!?"')\]]\s*$/.test(String(s).trim());
const cutMidWord = (s) => /[a-z]$/.test(String(s).trim());
const leaksJson = (s) => /"narrative"\s*:/.test(s);
const isFallback = (s) => /returned no narrative|no narrative this turn|could not be parsed cleanly|absorbed by events already in motion/i.test(s);

const registry = JSON.parse(readFileSync(join(ROOT, 'scenarios/registry.json'), 'utf8'));
const scenario = JSON.parse(readFileSync(join(ROOT, registry.find((e) => e.id === 'bramble_badger_deepfake').path), 'utf8'));

// Realistic rotating actions so the session keeps advancing.
const actions = [
  'We issue a calm public statement and open a member hotline.',
  'We brief the board and the regulator with a full timeline.',
  'We activate fraud monitoring and warn members about phishing.',
  'The CEO records a direct-to-camera denial and we post an FAQ.',
  'We work with the platforms to take the video down.',
  'We trace the seed account and preserve forensic evidence.',
  'We follow up with affected members and start clawbacks.',
  'We review controls and rotate the compromised credentials.',
  'We publish a remediation plan with owners and dates.',
  'We give the regulator the forensic package and evidence chain.',
  'We hold a staff town hall with a single-page script.',
  'We coordinate with the deposit insurer on member assurance.',
  'We run a tabletop review of the response and log lessons.',
  'We tighten vendor access and add monitoring on the console.',
  'We publish a plain-language member update and close the loop.',
];

const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
const s = new DMSession(provider, scenario);
s.castInfo = 'A mid-sized member-owned credit union.';

console.log(`\n=== TURN TRUNCATION SWEEP — ${MODEL}, ${TURNS} turns ===\n`);
const open = await s.openScene();
let clean = 0, softFail = 0, hardFail = 0, leak = 0, fb = 0;
console.log(`opening: ${open.length} chars, ends_clean=${endsClean(open)}`);
const row = [];
row.push({ t: 0, len: open.length, ok: endsClean(open), hard: cutMidWord(open) });

for (let i = 0; i < Math.min(TURNS, actions.length); i++) {
  const roll = ((i * 7 + 3) % 20) + 1;
  const res = await s.takeTurn(actions[i], roll);
  const n = res.narrative || '';
  const ok = endsClean(n);
  const hard = cutMidWord(n);
  if (ok && !leaksJson(n) && !isFallback(n)) clean++;
  else if (hard) hardFail++;
  else softFail++;
  if (leaksJson(n)) leak++;
  if (isFallback(n)) fb++;
  row.push({ t: i + 1, len: n.length, ok, hard, roll });
  console.log(`turn ${String(i + 1).padStart(2)} (roll ${String(roll).padStart(2)}): ${String(n.length).padStart(4)} chars  ends_clean=${ok}  ${hard ? 'HARD-TRUNC' : ''}${leaksJson(n) ? ' JSON-LEAK' : ''}${isFallback(n) ? ' FALLBACK' : ''}`);
}

const lens = row.filter((r) => r.t > 0).map((r) => r.len);
console.log(`\n=== RESULT ===`);
console.log(`turns: ${lens.length}`);
console.log(`clean: ${clean}`);
console.log(`soft-fail (no terminal punct, not mid-word): ${softFail}`);
console.log(`HARD truncation (mid-word): ${hardFail}`);
console.log(`json leak: ${leak} | fallback: ${fb}`);
console.log(`narrative length min/avg/max: ${Math.min(...lens)} / ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)} / ${Math.max(...lens)}`);
process.exit(hardFail || leak || fb ? 1 : 0);
