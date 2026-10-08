/**
 * E2E for the 2026-10-08 additions: executive "Story as we know it" panel and
 * the Auto-roll buttons in both the executive and IT modes.
 *
 * Requires: app server on :8000 and mock LLM on :9999.
 */
import puppeteer from 'puppeteer';
const BASE = 'http://localhost:8000';
const MOCK = 'http://localhost:9999/v1';

let passed = 0, failed = 0;
const check = (n, c, extra) => { if (c) passed++; else { failed++; console.log('  FAIL', n, extra || ''); } };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const type = async (sel, val) => { await page.focus(sel); await page.evaluate((s) => { document.querySelector(s).value = ''; }, sel); await page.type(sel, val); };

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.evaluate((mock) => {
  localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
    provider: 'openai-compatible', apiKey: '', baseUrl: mock, model: 'mock',
  }));
}, MOCK);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));

// --- EXECUTIVE MODE ------------------------------------------------------
await page.evaluate(() => document.getElementById('loadScenarioBtn').click());
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.getElementById('startButton').click());
await new Promise((r) => setTimeout(r, 400));

// Story-as-we-know-it panel present on the executive play phase.
check('story recap panel exists', await page.$('#storyRecap') !== null);
const recapBefore = await page.$eval('#storyRecap', (e) => e.textContent);
check('recap names the current step', /Step 1|Right now/.test(recapBefore), recapBefore.slice(0, 80));

// Auto-roll button exists and is clickable; needs an action first.
check('exec auto-roll button exists', await page.$('#autoRollBtn') !== null);
await page.evaluate(() => document.getElementById('autoRollBtn').click());
await new Promise((r) => setTimeout(r, 200));
const needAction = await page.$eval('#outcome', (e) => e.textContent);
check('auto-roll asks for an action first', /first|Type what/i.test(needAction), needAction);

// Type an action and auto-roll -> a turn resolves without manual dice.
await page.type('#actionText', 'Issue a calm public statement and brief the board.');
await page.evaluate(() => document.getElementById('autoRollBtn').click());
await new Promise((r) => setTimeout(r, 2600));
const afterAuto = await page.evaluate(() => ({
  narrative: document.getElementById('narrative').textContent,
  log: document.querySelectorAll('#log .logItem').length,
  recap: document.getElementById('storyRecap').textContent,
}));
check('auto-roll resolves a turn (narrative)', afterAuto.narrative.length > 20);
check('auto-roll logs a turn', afterAuto.log >= 1);
check('recap updates after a turn (where we left off)', /where we left off/i.test(afterAuto.recap));

// --- IT MODE -------------------------------------------------------------
await page.evaluate(() => document.getElementById('newSession').click());
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => { const s = document.getElementById('modeSelect'); s.value = 'it'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 250));
await page.evaluate(() => document.getElementById('loadScenarioBtn').click());
await new Promise((r) => setTimeout(r, 700));

check('IT play phase after start', await page.evaluate(() => getComputedStyle(document.getElementById('phase-it')).display !== 'none'));
check('IT auto-roll button exists', await page.$('#itAutoRoll') !== null);

// Auto-roll three times -> rounds resolve, log grows, attack path may reveal.
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => {
    const sel = document.getElementById('itTarget');
    const opt = [...sel.options].find((o) => o.value);
    if (opt) sel.value = opt.value;
    document.getElementById('itAutoRoll').click();
  });
  await new Promise((r) => setTimeout(r, 800));
}
const itState = await page.evaluate(() => ({
  log: document.querySelectorAll('#itLog .logItem').length,
  round: document.getElementById('itRoundLine').textContent,
  narrative: document.getElementById('itNarrative').textContent,
}));
check('IT auto-roll advances rounds (log >= 3)', itState.log >= 3, String(itState.log));
check('IT round line updates', /Round [1-9]/.test(itState.round), itState.round);
check('IT narrative from the IM', itState.narrative.length > 20);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\nAdditions E2E: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
