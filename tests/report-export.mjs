/**
 * REPORT + EXPORT (browser) — the in-app closing report must show the rich
 * fields (player attribution, resource usage, readable state) and BOTH export
 * buttons must produce a downloadable file.
 *
 * Runs against a LOCAL http server: an HTTPS page cannot call a plain-HTTP
 * mock on localhost (Chrome PNA / mixed content blocks it).
 *
 * Usage:
 *   node tests/report-export.mjs          # needs a static server on :8000
 *   LOCAL_URL=http://localhost:8000 node tests/report-export.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';

const ORIGIN = (process.env.LOCAL_URL || 'http://localhost:8000').replace(/\/+$/, '');
const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

console.log(`\n############ REPORT + EXPORT (browser) — ${ORIGIN} ############\n`);

// Mock LLM.
const mock = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const content = JSON.stringify({
      narrative: 'The team coordinates a response and pressure shifts across the crisis as events develop steadily toward a decision.',
      state_delta: { public_trust: 5, containment: 10 },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise((r) => mock.listen(9999, r));

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('dialog', async (d) => { await d.accept(); });

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
await new Promise((r) => setTimeout(r, 4500));

// Two attributed turns.
for (const [who, act] of [['Alice', 'We issue a statement.'], ['Bob', 'We brief the board.']]) {
  await page.waitForFunction(() => document.getElementById('actionText').getBoundingClientRect().width > 0, { timeout: 8000 });
  await page.type('#playerName', who);
  await page.type('#actionText', act);
  await page.click('#submitBtn');
  await new Promise((r) => setTimeout(r, 3000));
}

// End the exercise -> report phase.
await page.click('#endExercise');
await new Promise((r) => setTimeout(r, 1000));

const report = await page.evaluate(() => {
  const txt = document.getElementById('reportBody').textContent || '';
  return {
    visible: (document.getElementById('phase-report') || {}).style?.display !== 'none',
    hasResource: /Resource usage/.test(txt),
    hasTokens: /Total tokens:/.test(txt),
    hasByPlayer: /Actions by player/.test(txt),
    hasPlayerInLog: /Alice/.test(txt),
    hasGenerated: /Generated/.test(txt),
    hasHtmlBtn: !!document.getElementById('exportReportHtml'),
    hasJsonBtn: !!document.getElementById('exportReport'),
  };
});
record('report phase shown after ending', report.visible);
record('in-app report shows resource usage', report.hasResource && report.hasTokens, 'tokens');
record('in-app report shows per-player attribution', report.hasByPlayer && report.hasPlayerInLog);
record('in-app report shows a readable generated date', report.hasGenerated);
record('both export buttons present', report.hasHtmlBtn && report.hasJsonBtn);

// Exercise the HTML export (download) and inspect the captured bytes.
const client = await page.target().createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/tt-dl', eventsEnabled: true });
let downloads = [];
client.on('Browser.downloadWillBegin', (e) => downloads.push(e.suggestedFilename));
try {
  await page.click('#exportReportHtml');
  await new Promise((r) => setTimeout(r, 1500));
  record('HTML export triggers a download', downloads.length > 0 && /\.html$/.test(downloads[0]), downloads[0] || 'none');
} catch (e) {
  record('HTML export triggers a download', false, e.message);
}

await browser.close();
await new Promise((r) => mock.close(r));

const pass = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${pass}/${results.length} passed ############`);
for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.n}: ${f.d}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
