/**
 * IT / Backdoors & Breaches mode E2E: boot app -> pick IT version -> start ->
 * run rounds with a manual roll -> verify attack-path reveal, inject feed,
 * round log, and that a win/loss splash appears.
 *
 * Requires: app server on :8000 and mock LLM on :9999.
 */
import puppeteer from 'puppeteer';
const BASE = 'http://localhost:8000';
const MOCK = 'http://localhost:9999/v1';

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log('  FAIL', n); } };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('response', (r) => { if (r.status() >= 500) errors.push('HTTP' + r.status() + ' ' + r.url()); });

await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));

// Point the app at the mock LLM.
await page.evaluate((mock) => {
  localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
    provider: 'openai-compatible', apiKey: '', baseUrl: mock, model: 'mock',
  }));
}, MOCK);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));

// Go to the scenario-select screen (New session button on the landing phase).
await page.evaluate(() => { const b = document.getElementById('newSession') || document.getElementById('startButton'); if (b) b.click(); });
await new Promise((r) => setTimeout(r, 400));

// The mode picker should exist and default to elite.
check('mode picker present', await page.$('input[name="modePick"][value="it"]') !== null);
const eliteVisible = await page.evaluate(() => getComputedStyle(document.getElementById('eliteSetup')).display !== 'none');
check('elite setup visible by default', eliteVisible);

// Pick the IT version -> the IT setup panel shows.
await page.evaluate(() => document.querySelector('input[name="modePick"][value="it"]').click());
await new Promise((r) => setTimeout(r, 250));
const itVisible = await page.evaluate(() => getComputedStyle(document.getElementById('itSetup')).display !== 'none');
const eliteHidden = await page.evaluate(() => getComputedStyle(document.getElementById('eliteSetup')).display === 'none');
check('IT setup visible after pick', itVisible);
check('elite setup hidden after pick', eliteHidden);
check('start button relabelled', (await page.$eval('#loadScenarioBtn', (b) => b.textContent)).includes('IT'));

// Start the IT exercise.
await page.evaluate(() => { document.getElementById('itCompany').value = 'Northwind Health'; });
await page.evaluate(() => document.getElementById('loadScenarioBtn').click());
await new Promise((r) => setTimeout(r, 700));

check('IT play phase visible', await page.evaluate(() => getComputedStyle(document.getElementById('phase-it')).display !== 'none'));
const stageCount = await page.$$eval('#itAttackPath .itStage', (els) => els.length);
check('attack path renders four stages', stageCount === 4);
const hiddenCount = await page.$$eval('#itAttackPath .itStage.hidden', (els) => els.length);
check('all four stages start hidden', hiddenCount === 4);
const procOpts = await page.$$eval('#itProcedure option', (els) => els.length);
check('procedure hand has options', procOpts >= 3);

// Round 1: roll 18 on a targeted stage -> should reveal one.
await page.evaluate(() => {
  document.getElementById('itTarget').value = document.getElementById('itTarget').options[1].value;
  document.getElementById('itRoll').value = '18';
  document.getElementById('itSubmit').click();
});
await new Promise((r) => setTimeout(r, 800));
let revealed = await page.$$eval('#itAttackPath .itStage.revealed', (els) => els.length);
check('a success reveals a stage', revealed === 1);
const outcome1 = await page.$eval('#itOutcome', (e) => e.textContent);
check('outcome reports SUCCESS', /SUCCESS/.test(outcome1));
check('round log has an entry', await page.$$eval('#itLog .logItem', (els) => els.length) === 1);

// Round 2: natural 1 -> inject fires, no reveal.
await page.evaluate(() => { document.getElementById('itRoll').value = '1'; document.getElementById('itSubmit').click(); });
await new Promise((r) => setTimeout(r, 800));
const outcome2 = await page.$eval('#itOutcome', (e) => e.textContent);
check('natural 1 reports FAILURE', /FAILURE/.test(outcome2));
check('natural 1 fires an INJECT', /INJECT/.test(outcome2));
const injectFeed = await page.$eval('#itInjectFeed', (e) => e.textContent);
check('inject feed shows the inject', !/No injects yet/.test(injectFeed));

// Reveal the rest to force a win. Target each remaining hidden stage with a high roll.
for (let i = 0; i < 3; i++) {
  const done = await page.evaluate(() => {
    const sel = document.getElementById('itTarget');
    const opt = [...sel.options].find((o) => o.value);
    if (!opt) return true;
    sel.value = opt.value;
    document.getElementById('itRoll').value = '19';
    document.getElementById('itSubmit').click();
    return false;
  });
  if (done) break;
  await new Promise((r) => setTimeout(r, 800));
}
await new Promise((r) => setTimeout(r, 700));
const splashVisible = await page.evaluate(() => getComputedStyle(document.getElementById('splash')).display !== 'none');
check('win splash appears after uncovering all four', splashVisible);
const splashTitle = await page.$eval('#splashTitle', (e) => e.textContent);
check('splash says Victory', /Victory/.test(splashTitle));

check('no page errors during IT run', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\nIT E2E: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
