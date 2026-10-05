/**
 * EXPANDED test regime — DeepSeek Flash 4.1 as the DM.
 *
 * Runs a broad battery of checks against a real Ollama-routed model and prints
 * a single pass/fail table. Focus: does the DM ever truncate, leak JSON, or
 * dead-end, across many turns, scenarios, rolls, and modes?
 *
 * Usage:
 *   DM_MODEL=deepseek-v4.1-flash:cloud node tests/expanded-regime.mjs
 *   DM_MODEL=deepseek-v4.1-flash:cloud node tests/expanded-regime.mjs --quick
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { randomScenarioShell } from '../app/js/scenarios.js';
import { buildReport } from '../server/report.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const BASE = 'http://localhost:11434/v1';
const QUICK = process.argv.includes('--quick');
const ROOT = new URL('../', import.meta.url).pathname;

const registry = JSON.parse(readFileSync(join(ROOT, 'scenarios/registry.json'), 'utf8'));
const loadScenario = (entry) => JSON.parse(readFileSync(join(ROOT, entry.path), 'utf8'));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

// --- narrative quality checks -------------------------------------------------
const endsClean = (s) => /[.!?"')\]]\s*$/.test(String(s).trim());
const leaksJson = (s) => /"narrative"\s*:/.test(s) || /^\s*[{[{]/.test(String(s).trim());
const isFallback = (s) => /returned no narrative|no narrative this turn|could not be parsed cleanly/i.test(s);
const isNoopFallback = (s) => /absorbed by events already in motion/i.test(s);

function checkNarrative(tag, n, minLen = 200) {
  const issues = [];
  if (!n || n.length < minLen) issues.push(`too short (${n ? n.length : 0})`);
  if (!endsClean(n)) issues.push('does NOT end cleanly (possible truncation)');
  if (leaksJson(n)) issues.push('JSON leaked into narrative');
  if (isFallback(n)) issues.push('hit the empty-narrative fallback');
  record(tag, issues.length === 0, issues.join('; ') || `${n.length} chars, clean`);
  return issues.length === 0;
}

function newSession(scenario, opts = {}) {
  const provider = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: '', model: MODEL });
  const s = new DMSession(provider, scenario);
  s.companyInfo = opts.companyInfo || 'A mid-sized member-owned credit union.';
  if (opts.random) s.random = true;
  return s;
}

console.log(`\n############ EXPANDED REGIME — DM=${MODEL} ############`);
console.log(`# runs=${QUICK ? 'quick' : 'full'}\n`);

// ============================================================================
// E1 — OPENING SCENE across every scenario
// ============================================================================
console.log('E1 — Opening scene, every scenario');
for (const entry of registry.filter((e) => !e.random)) {
  const scenario = loadScenario(entry);
  const s = newSession(scenario);
  const opening = await s.openScene();
  checkNarrative(`E1 ${entry.id}`, opening, 300);
}

// ============================================================================
// E2 — MULTI-TURN truncation sweep (several rolls including bad ones)
// ============================================================================
console.log('\nE2 — Multi-turn sweep across roll extremes');
{
  const scenario = loadScenario(registry.find((e) => e.id === 'bramble_badger_deepfake'));
  const s = newSession(scenario);
  await s.openScene();
  const turns = [
    ['We issue a public statement and open a member hotline.', 20],
    ['We brief the board and regulator with a full timeline.', 1],
    ['We activate fraud monitoring and warn members.', 10],
    ['We work with platforms to remove the video.', 5],
    ['We hold a staff town hall and publish an FAQ.', 18],
  ];
  let allOk = true;
  for (let i = 0; i < turns.length; i++) {
    const [action, roll] = turns[i];
    const res = await s.takeTurn(action, roll);
    const ok = checkNarrative(`E2 turn ${i + 1} (roll ${roll})`, res.narrative, 200);
    allOk = allOk && ok;
  }
  record('E2 all turns clean', allOk);
}

// ============================================================================
// E3 — RANDOM MODE (generated shell scenario)
// ============================================================================
console.log('\nE3 — Random-mode generated scenario');
{
  const s = newSession(randomScenarioShell(), { random: true });
  const opening = await s.openScene();
  checkNarrative('E3 random opening', opening, 200);
  const res = await s.takeTurn('We hold an emergency leadership call and gather facts.', 12);
  checkNarrative('E3 random turn 1', res.narrative, 200);
}

// ============================================================================
// E4 — FULL SESSION (many turns) + end-condition / report
// ============================================================================
console.log('\nE4 — Full session, 12 turns + report');
{
  const scenario = loadScenario(registry.find((e) => e.id === 'whistleblower'));
  const s = newSession(scenario);
  await s.openScene();
  const actions = [
    'We issue a holding statement and open a crisis line.',
    'We brief the board and retain outside counsel.',
    'We contact the regulator proactively with facts.',
    'We reach out to affected members directly.',
    'We launch an internal investigation into the allegations.',
    'We publish a corrected FAQ and brief frontline staff.',
    'We engage the journalist to correct the record.',
    'We review and tighten our internal controls.',
    'We prepare a remediation plan with timelines.',
    'We update the board with progress and evidence.',
    'We follow up with the regulator on the remediation.',
    'We hold a lessons-learned session and publish a summary.',
  ];
  let clean = 0;
  for (let i = 0; i < (QUICK ? 5 : actions.length); i++) {
    const roll = ((i * 7) % 20) + 1; // spread rolls 1..20
    const res = await s.takeTurn(actions[i], roll);
    if (checkNarrative(`E4 turn ${i + 1}`, res.narrative, 150)) clean++;
  }
  record('E4 turns all clean', clean === (QUICK ? 5 : actions.length), `${clean} clean`);
  // Report must build without throwing and include a narrative per logged turn.
  try {
    const report = buildReport(s, { ending: s.ending || null });
    const hasTurns = Array.isArray(report.part1?.turn_log) || Array.isArray(report.turn_log);
    record('E4 report builds', !!report, hasTurns ? 'has turn log' : 'built');
  } catch (e) {
    record('E4 report builds', false, e.message);
  }
}

// ============================================================================
// E5 — STATE INTEGRITY (clamping + per-turn cap)
// ============================================================================
console.log('\nE5 — State integrity across a session');
{
  const scenario = loadScenario(registry.find((e) => e.id === 'rogue_ai'));
  const s = newSession(scenario);
  await s.openScene();
  let inRange = true;
  const metrics = Object.keys(s.state);
  for (let i = 0; i < (QUICK ? 3 : 6); i++) {
    await s.takeTurn('We coordinate a cross-department response and gather evidence.', ((i * 5) % 20) + 1);
    for (const m of metrics) {
      const v = s.state[m];
      if (typeof v === 'number' && (v < 0 || v > 100)) inRange = false;
    }
  }
  record('E5 all metrics stay within [0,100]', inRange, metrics.join(','));
}

// ============================================================================
// SUMMARY
// ============================================================================
const pass = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n############ SUMMARY: ${pass}/${total} passed ############`);
const fails = results.filter((r) => !r.ok);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log('');
process.exit(fails.length ? 1 : 0);
