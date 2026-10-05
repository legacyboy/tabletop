/**
 * LIVE BROWSER BUDGET — does the *shipped* Pages bundle actually carry the
 * raised token budgets that fix the truncation bug, on the real network path?
 *
 * The truncation fix is a data-flow guarantee:
 *   app/js/dm.js        -> SCENE_TOKENS/TURN_TOKENS/DM_NUM_CTX constants
 *   provider.chat(...)  -> sends max_tokens (+ num_ctx for Ollama)
 *   Ollama /api/chat    -> honours num_ctx (the /v1 endpoint ignores it)
 *
 * Unit tests cover the provider in isolation. This test closes the gap by
 * checking the DEPLOYED artifacts and, in browser mode, capturing the actual
 * outbound request from the live app.
 *
 * Modes:
 *   static (default) : fetch the live bundle files, assert the raised budgets
 *                      are present and the retired model id is not the default.
 *   --browser        : boot the live site headless, point it at a local mock
 *                      LLM, drive one turn, and assert the request body carries
 *                      max_tokens=8192 (and num_ctx when Ollama-routed).
 *
 * Usage:
 *   LIVE_URL=https://legacyboy.github.io/tabletop node tests/live-browser-budget.mjs
 *   LIVE_URL=... node tests/live-browser-budget.mjs --browser
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIVE = (process.env.LIVE_URL || 'https://legacyboy.github.io/tabletop').replace(/\/+$/, '');
const BROWSER = process.argv.includes('--browser');
const ROOT = new URL('../', import.meta.url).pathname;

const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

console.log(`\n############ LIVE BROWSER BUDGET — ${LIVE} ############\n`);

// ---- static: the deployed constants ---------------------------------------
console.log('S1 — Deployed bundle carries the raised budgets');
{
  const dmSrc = await (await fetch(`${LIVE}/app/js/dm.js`)).text();
  record('live dm.js served', dmSrc.length > 1000, `${dmSrc.length} bytes`);
  record('live dm.js TURN_TOKENS = 8192', /TURN_TOKENS\s*=\s*8192/.test(dmSrc));
  record('live dm.js SCENE_TOKENS = 4096', /SCENE_TOKENS\s*=\s*4096/.test(dmSrc));
  record('live dm.js DM_NUM_CTX = 16384', /DM_NUM_CTX\s*=\s*16384/.test(dmSrc));
  record('live dm.js captures the audit trail (dm_prompt/dm_reply)', /dm_prompt/.test(dmSrc) && /dm_reply/.test(dmSrc));

  const provSrc = await (await fetch(`${LIVE}/app/js/providers/openai-compatible.js`)).text();
  record('live provider routes Ollama to /api/chat', /\/api\/chat/.test(provSrc));
  record('live provider sends num_ctx', /num_ctx/.test(provSrc));
  record('live provider sends num_predict from maxTokens', /num_predict/.test(provSrc) && /maxTokens/.test(provSrc));

  const regSrc = await (await fetch(`${LIVE}/app/js/providers/registry.js`)).text();
  record('live registry defaults to deepseek-v4.1-flash:cloud', /deepseek-v4\.1-flash:cloud/.test(regSrc));
}

// ---- static: index.html boots the right bundle ----------------------------
console.log('\nS2 — Page loads the app');
try {
  const html = await (await fetch(`${LIVE}/`)).text();
  record('live index.html served', html.length > 200, `${html.length} bytes`);
  record('live index.html references a module entry', /type="module"|app\/js\/main|\.js/.test(html));
} catch (e) {
  record('live index.html served', false, e.message);
}

// ---- browser: capture the real outbound request ----------------------------
if (BROWSER) {
  console.log('\nS3 — Headless browser captures the outbound model request');
  const { default: puppeteer } = await import('puppeteer');

  // Spin a local mock LLM that records the request body.
  let captured = null;
  const http = await import('node:http');
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { captured = JSON.parse(raw); } catch { captured = { raw }; }
      const content = JSON.stringify({ narrative: 'The team acts and the situation develops. Pressure mounts on the crisis response as events force a decision.' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ id: 'mock', choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise((r) => mock.listen(9999, r));

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => {
    if (/9999|chat\/completions/.test(r.url()) && r.method() === 'POST') {
      try { captured = JSON.parse(r.postData() || '{}'); } catch { /* body may be unavailable */ }
    }
  });
  await page.goto(`${LIVE}/`, { waitUntil: 'networkidle0' });
  // Point the app at our non-Ollama mock so it uses /chat/completions and we
  // can read max_tokens directly (Ollama path is covered by S1 static checks).
  await page.evaluate(() => {
    localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
      provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:9999/v1', model: 'mock', allowCompanyFetch: false,
    }));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  try {
    // The app starts on the scenario-select phase. Pick the first scenario,
    // load it (-> intro phase), then start the session.
    await page.waitForFunction(() => {
      const sel = document.getElementById('scenarioSelect');
      return sel && sel.options && sel.options.length > 0;
    }, { timeout: 10000 });
    await page.select('#scenarioSelect', await page.$eval('#scenarioSelect', (s) => s.options[0].value));
    await page.click('#loadScenarioBtn');
    await page.waitForFunction(() => {
      const b = document.getElementById('startButton');
      return b && !b.disabled && b.getBoundingClientRect().width > 0;
    }, { timeout: 10000 });
    await page.click('#startButton');
    // The opening scene is an async model call (SCENE_TOKENS = 4096).
    await new Promise((r) => setTimeout(r, 6000));
    // Opening request captured: it must carry the scene budget.
    record('opening request carries max_tokens = 4096 (scene budget)', captured && captured.max_tokens === 4096, `max_tokens=${captured ? captured.max_tokens : 'none'}`);

    // Now submit a real turn via the action box -> the TURN budget (8192).
    await page.waitForFunction(() => {
      const t = document.getElementById('actionText');
      return t && t.getBoundingClientRect().width > 0;
    }, { timeout: 8000 });
    await page.type('#actionText', 'We issue a coordinated public statement and open a member hotline.');
    await page.click('#submitBtn');
    await new Promise((r) => setTimeout(r, 6000));
  } catch (e) {
    record('browser start button reached', false, e.message);
  }
  await browser.close();
  await new Promise((r) => mock.close(r));

  if (captured) {
    record('browser sent a model request', true);
    record('turn request carries max_tokens = 8192 (the fix)', captured.max_tokens === 8192, `max_tokens=${captured.max_tokens}`);
  } else {
    record('browser sent a model request', false, `no request captured${pageErrors.length ? ' | pageerrors: ' + pageErrors.slice(0, 2).join(' / ') : ''}`);
  }
} else {
  console.log('\n(S3 browser capture skipped — run with --browser)');
}

// ---- summary ---------------------------------------------------------------
const pass = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${pass}/${results.length} passed ############`);
for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.n}: ${f.d}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
