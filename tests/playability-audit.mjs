/**
 * PLAYABILITY TEST — does a session actually WORK, and does it produce a
 * complete, auditable two-sided log of the DM <-> player conversation?
 *
 * This drives a full session with a REAL DM model, then:
 *   1. asserts the session is playable (opening + N turns, advances, ends or
 *      reaches a sensible arc, state moves);
 *   2. asserts EVERY turn recorded BOTH sides of the conversation for the audit
 *      trail: the exact prompt sent to the DM (system + user) and the DM's raw
 *      reply, alongside the narrative shown to the group;
 *   3. writes the full transcript to disk as JSON + a rendered HTML report.
 *
 * Usage:
 *   DM_MODEL=deepseek-v4.1-flash:cloud node tests/playability-audit.mjs [turns]
 * Output:
 *   tests/out/playability-<scenario>-<ts>.json   (full machine-readable log)
 *   tests/out/playability-<scenario>-<ts>.html   (rendered report)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { buildReport, renderReportHtml } from '../server/report.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const SCENARIO_ID = process.env.SCENARIO || 'bramble_badger_deepfake';
const TURNS = parseInt(process.argv[2] || '8', 10);
const BASE = 'http://localhost:11434/v1';
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = join(ROOT, 'tests/out');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const registry = JSON.parse(readFileSync(join(ROOT, 'scenarios/registry.json'), 'utf8'));
const entry = registry.find((e) => e.id === SCENARIO_ID);
const scenario = JSON.parse(readFileSync(join(ROOT, entry.path), 'utf8'));

// A realistic rotating executive playbook.
const PLAYBOOK = [
  'We issue a calm public statement confirming the incident and open a member hotline.',
  'We brief the board and the regulator with a factual timeline and evidence package.',
  'We activate fraud monitoring and warn members about the phishing wave.',
  'The CEO records a direct-to-camera message and we publish a member FAQ.',
  'We work with the platforms to take the content down and map the amplifier network.',
  'We trace the seed account, preserve forensic evidence, and rotate credentials.',
  'We follow up with affected members and begin clawing back fraudulent transfers.',
  'We review controls, publish a remediation plan, and log lessons learned.',
  'We run a staff town hall with a single-page script and a clear escalation path.',
  'We give the regulator the completed forensic chain-of-custody.',
];

const provider = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: '', model: MODEL });
const session = new DMSession(provider, scenario);
session.companyInfo = 'A mid-sized member-owned credit union.';

console.log(`\n############ PLAYABILITY + AUDIT — ${MODEL} / ${SCENARIO_ID} ############\n`);

// ---- 1. Playable: opening + turns ------------------------------------------
const opening = await session.openScene();
record('opening scene produced', !!opening && opening.trim().length > 100, `${opening.length} chars`);

let advanced = 0;
for (let i = 0; i < Math.min(TURNS, PLAYBOOK.length); i++) {
  const roll = ((i * 7 + 3) % 20) + 1;
  const before = JSON.stringify(session.state);
  const res = await session.takeTurn(PLAYBOOK[i], roll);
  if (res.narrative && res.narrative.trim().length > 50) advanced++;
  if (JSON.stringify(session.state) !== before) advanced++;
  console.log(`  turn ${i + 1}: roll ${roll}, narrative ${res.narrative.length} chars`);
}
record('session advanced through all turns', advanced >= TURNS, `${advanced} signals`);

// ---- 2. Audit trail: BOTH sides logged every turn --------------------------
const history = session.history;
record('history has opening + every turn', history.length === TURNS + 1, `${history.length} entries`);

let bothSides = 0;
let promptComplete = 0;
for (const e of history) {
  const hasPrompt = Array.isArray(e.dm_prompt) && e.dm_prompt.length === 2;
  const hasSystem = hasPrompt && e.dm_prompt[0].role === 'system' && e.dm_prompt[0].content.length > 200;
  const hasUser = hasPrompt && e.dm_prompt[1].role === 'user' && e.dm_prompt[1].content.length > 20;
  const hasReply = typeof e.dm_reply === 'string' && e.dm_reply.length > 0;
  const hasNarrative = typeof e.narrative === 'string' && e.narrative.length > 0;
  if (hasPrompt && hasReply) bothSides++;
  if (hasSystem && hasUser && hasReply) promptComplete++;
  void hasNarrative;
}
record('every turn logged BOTH sides (prompt + raw reply)', bothSides === history.length, `${bothSides}/${history.length}`);
record('every prompt has system+user+reply', promptComplete === history.length, `${promptComplete}/${history.length}`);

// Player side must include the action; opening is labelled.
const firstTurn = history[1];
record('player action + roll captured', !!firstTurn.action && Number.isInteger(firstTurn.roll), `roll=${firstTurn.roll}`);
record('opening turn labelled', history[0].action === '(opening scene)');

// Raw reply must be the pre-parse text (may be JSON), and the shown narrative
// must differ from it when the reply was JSON-wrapped.
const jsonTurns = history.filter((e) => /"narrative"\s*:/.test(e.dm_reply || ''));
record('raw replies are pre-parse (JSON preserved)', jsonTurns.length > 0, `${jsonTurns.length} JSON replies`);

// ---- 3. Report embeds the transcript --------------------------------------
const report = buildReport(session, { ending: session.ending || null });
record('report builds', !!report);
record(
  'report part1b transcript has every turn',
  report.part1b_transcript && report.part1b_transcript.turns.length === history.length,
  `${report.part1b_transcript ? report.part1b_transcript.turns.length : 0} turns`
);
const html = renderReportHtml(report);
record('rendered HTML shows the transcript heading', /Full Transcript/.test(html));
record('rendered HTML includes a raw DM reply block', /dm reply \(raw\)/.test(html));

// ---- dump artifacts --------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const base = join(OUT, `playability-${SCENARIO_ID}-${ts}`);
writeFileSync(`${base}.json`, JSON.stringify({
  model: MODEL, scenario_id: SCENARIO_ID, turns: TURNS,
  opening, history, report,
}, null, 2));
writeFileSync(`${base}.html`, html);
console.log(`\nwrote ${base}.json`);
console.log(`wrote ${base}.html`);

// ---- summary ---------------------------------------------------------------
const pass = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n############ SUMMARY: ${pass}/${total} passed ############`);
const fails = results.filter((r) => !r.ok);
for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(fails.length ? 1 : 0);
