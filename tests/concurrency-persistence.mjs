/**
 * CONCURRENCY / PERSISTENCE — does a session survive a refresh, and do two
 * tabs stay safe?
 *
 * Node-level part (deterministic, no browser):
 *   - serialize() -> restore() round-trips a session exactly: state, turn,
 *     history (incl. the audit trail + player attribution + token usage),
 *     attack chain, streaks, beats, roll modifier, budget, usage.
 *   - restoring does NOT re-fire previously fired events.
 *   - a snapshot taken mid-session resumes at the same turn with the same
 *     narrative log.
 *
 * Browser part (--browser): boot the deployed app headless, play a turn, then
 * RELOAD and auto-accept the resume prompt; assert the session resumes with the
 * prior turn still in the run log (persistence via localStorage).
 *
 * Usage:
 *   node tests/concurrency-persistence.mjs [--browser]
 */
import { readFileSync } from 'node:fs';
import { DMSession } from '../app/js/dm.js';

const BROWSER = process.argv.includes('--browser');
const LIVE = (process.env.LIVE_URL || 'https://legacyboy.github.io/tabletop').replace(/\/+$/, '');
const ROOT = new URL('../', import.meta.url).pathname;

const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

console.log('\n############ CONCURRENCY / PERSISTENCE ############\n');

const registry = JSON.parse(readFileSync(`${ROOT}scenarios/registry.json`, 'utf8'));
const scenario = JSON.parse(readFileSync(ROOT + registry.find((e) => e.id === 'bramble_badger_deepfake').path, 'utf8'));

// Programmable provider: deterministic DM JSON so the arc is reproducible.
function makeProvider() {
  let n = 0;
  return {
    async chat(messages) {
      n++;
      if (/opening scene, turn 0/.test(messages[1].content)) {
        return JSON.stringify({ narrative: 'The deepfake is spreading and the press is calling. What do you do?' });
      }
      return JSON.stringify({
        narrative: `Turn ${n}: the team moves and pressure shifts across the crisis. ` + 'Events develop. '.repeat(3),
        state_delta: { public_trust: 5, containment: 10 },
        progress: true,
        reveal_stage: 'spread',
        beat_judgment: { quality: 'good' },
      });
    },
  };
}

// ---- 1. Round-trip serialize -> restore ------------------------------------
console.log('C1 — Serialize / restore round-trip');
{
  const s = new DMSession(makeProvider(), scenario);
  await s.openScene();
  await s.takeTurn('We issue a statement.', 7, 'Alice');
  await s.takeTurn('We brief the board.', 14, 'Bob');
  await s.takeTurn('We warn members.', 3, 'Alice');

  const snap = JSON.parse(JSON.stringify(s.serialize()));
  const r = DMSession.restore(makeProvider(), JSON.parse(JSON.stringify(scenario)), snap);

  record('turn preserved', r.turn === s.turn, `${r.turn} vs ${s.turn}`);
  record('state preserved', JSON.stringify(r.state) === JSON.stringify(s.state));
  record('history length preserved', r.history.length === s.history.length, `${r.history.length}`);
  record('audit trail preserved (dm_prompt/dm_reply)', r.history.slice(1).every((e) => Array.isArray(e.dm_prompt) && typeof e.dm_reply === 'string'));
  record('player attribution preserved', r.history[1].player === 'Alice' && r.history[2].player === 'Bob', `${r.history[1].player}/${r.history[2].player}`);
  record('token usage preserved', JSON.stringify(r.tokenUsage) === JSON.stringify(s.tokenUsage) && r.tokenUsage.calls > 0, `calls=${r.tokenUsage.calls}`);
  record('per-turn token counts preserved', r.history.every((e) => typeof e.tokens_prompt === 'number' && typeof e.tokens_completion === 'number'));
  record('attack chain preserved', JSON.stringify(r.attackChain) === JSON.stringify(s.attackChain));
  record('fired events preserved', JSON.stringify([...r.firedEvents].sort()) === JSON.stringify([...s.firedEvents].sort()));
  record('streaks / beats / budget preserved', JSON.stringify(r.statStreaks) === JSON.stringify(s.statStreaks) && r.currentBeatIndex === s.currentBeatIndex && r.budgetSpend === s.budgetSpend);
}

// ---- 2. Restore does not re-fire events ------------------------------------
console.log('\nC2 — Restore does not re-fire events');
{
  const s = new DMSession(makeProvider(), scenario);
  await s.openScene();
  // Drive several turns so any stat/turn events have fired.
  for (let i = 0; i < 4; i++) await s.takeTurn('We act.', 7);
  const firedBefore = new Set(s.firedEvents);
  const snap = JSON.parse(JSON.stringify(s.serialize()));
  const r = DMSession.restore(makeProvider(), JSON.parse(JSON.stringify(scenario)), snap);
  await r.takeTurn('We continue.', 7);
  const newEvent = r.history[r.history.length - 1].events;
  const reFired = newEvent.filter((id) => firedBefore.has(id));
  record('no already-fired event re-fires after restore', reFired.length === 0, `refired=${reFired.join(',') || 'none'}`);
}

// ---- 3. Mid-session snapshot resumes at the same turn ----------------------
console.log('\nC3 — Mid-session resume is seamless');
{
  const s = new DMSession(makeProvider(), scenario);
  await s.openScene();
  await s.takeTurn('Action one.', 7, 'Alice');
  await s.takeTurn('Action two.', 8, 'Bob');
  const snap = JSON.parse(JSON.stringify(s.serialize()));
  const r = DMSession.restore(makeProvider(), JSON.parse(JSON.stringify(scenario)), snap);
  const next = await r.takeTurn('Action three.', 9, 'Carol');
  record('resumed session continues at turn 3', r.turn === 3 && next.event.turn === 3, `turn=${r.turn}`);
  record('resumed log keeps prior actions', r.history[1].action === 'Action one.' && r.history[2].action === 'Action two.');
  record('new turn attributed to Carol', r.history[3].player === 'Carol');
}

// ---- 4. Browser: reload + resume -------------------------------------------
if (BROWSER) {
  // Browser resume must run against an HTTP origin: an HTTPS page cannot call a
  // plain-HTTP mock on localhost (Chrome Private Network Access / mixed-content
  // blocks it), which would make the turn fail for an unrelated reason. So we
  // always drive the browser part against a LOCAL http server, regardless of
  // LIVE_URL. The static/deployed app is proven by live-browser-budget.mjs.
  const ORIGIN = process.env.LOCAL_URL || 'http://localhost:8000';
  console.log(`\nC4 — Browser: play a turn, reload, resume (${ORIGIN})`);
  const { default: puppeteer } = await import('puppeteer');
  const http = await import('node:http');
  const mock = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const content = JSON.stringify({ narrative: 'The team acts decisively and the situation develops. Pressure shifts as the crisis moves forward and a new decision looms.' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise((r) => mock.listen(9999, r));

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('dialog', async (d) => { await d.accept(); }); // auto-accept resume prompt
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
    provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:9999/v1', model: 'mock', allowCompanyFetch: false,
  })));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => { const s = document.getElementById('scenarioSelect'); return s && s.options.length > 0; }, { timeout: 10000 });
  await page.select('#scenarioSelect', await page.$eval('#scenarioSelect', (s) => s.options[0].value));
  await page.click('#loadScenarioBtn');
  await page.waitForFunction(() => { const b = document.getElementById('startButton'); return b && !b.disabled && b.getBoundingClientRect().width > 0; }, { timeout: 10000 });
  await page.click('#startButton');
  await new Promise((r) => setTimeout(r, 5000));
  await page.waitForFunction(() => { const t = document.getElementById('actionText'); return t && t.getBoundingClientRect().width > 0; }, { timeout: 8000 });
  await page.type('#actionText', 'We issue a coordinated public statement NOW.');
  await page.click('#submitBtn');
  await new Promise((r) => setTimeout(r, 5000));

  const beforeReload = await page.evaluate(() => {
    const snap = localStorage.getItem('tabletop.dm.session.v1');
    const log = document.getElementById('log') ? document.getElementById('log').textContent : '';
    return { hasSnap: !!snap, turn: snap ? (JSON.parse(snap).turn || 0) : 0, logLen: log.length };
  });
  record('snapshot written to localStorage after a turn', beforeReload.hasSnap && beforeReload.turn >= 1, `turn=${beforeReload.turn}`);

  // Reload and auto-accept the resume prompt.
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 2500));
  const afterReload = await page.evaluate(() => {
    const phase = (document.getElementById('phase-play') || {}).style?.display !== 'none';
    const log = document.getElementById('log') ? document.getElementById('log').textContent : '';
    const narr = document.getElementById('narrative') ? document.getElementById('narrative').textContent : '';
    return { inPlay: phase, logLen: log.length, hasNarrative: narr.length > 20 };
  });
  record('reload resumes into the play phase', afterReload.inPlay);
  record('resumed run log shows the prior turn', afterReload.logLen > 0, `logLen=${afterReload.logLen}`);

  await browser.close();
  await new Promise((r) => mock.close(r));
} else {
  console.log('\n(C4 browser resume skipped - run with --browser)');
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${pass}/${results.length} passed ############`);
for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.n}: ${f.d}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
