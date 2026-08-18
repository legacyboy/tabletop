import puppeteer from 'puppeteer';

/**
 * Deterministic browser check for the two feature additions:
 *
 *   1. Scenario change: "Change scenario" returns to the #phase-select screen
 *      (re-populated from the registry), and re-selecting a scenario reloads
 *      its intro.
 *   2. Remote Ollama preset: the settings UI offers "Ollama (remote)" for the
 *      openai-compatible provider and pre-fills baseUrl + model.
 *
 * Requires the app server on :8000 (node server/serve.js). No mock LLM needed.
 */

const BASE = 'http://localhost:8000';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log('  PASS', n); } else { failed++; console.log('  FAIL', n); } };

await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 700));

// --- Feature 1: scenario select / change ---
const introVisible = await page.evaluate(() => document.getElementById('phase-intro').style.display === 'block');
check('initial load shows intro (auto-selected scenario)', introVisible);

const hasChangeBtn = await page.evaluate(() => !!document.getElementById('changeScenario'));
check('"Change scenario" button exists in intro', hasChangeBtn);

// Click "Change scenario" -> should reveal the select phase.
await page.click('#changeScenario');
await new Promise((r) => setTimeout(r, 400));
const selectVisible = await page.evaluate(() => document.getElementById('phase-select').style.display === 'block');
check('select phase visible after "Change scenario"', selectVisible);
const optionCount = await page.evaluate(() => document.getElementById('scenarioSelect').options.length);
check('scenario dropdown repopulated (>= 1 option)', optionCount >= 1);

// Re-select scenario 0 -> intro again.
await page.select('#scenarioSelect', '0');
await new Promise((r) => setTimeout(r, 400));
const introAgain = await page.evaluate(() => document.getElementById('phase-intro').style.display === 'block');
check('selecting a scenario returns to intro', introAgain);

// --- Feature 2: remote Ollama preset in settings ---
await page.click('#settingsButton');
await new Promise((r) => setTimeout(r, 300));
await page.select('#providerSelect', 'openai-compatible');
await new Promise((r) => setTimeout(r, 200));
const presetVisible = await page.evaluate(() => document.getElementById('preset').style.display !== 'none');
check('preset dropdown visible for openai-compatible provider', presetVisible);
const presetOptions = await page.evaluate(() => Array.from(document.getElementById('preset').options).map((o) => o.value));
check('preset dropdown includes ollama-remote', presetOptions.includes('ollama-remote'));

await page.select('#preset', 'ollama-remote');
await new Promise((r) => setTimeout(r, 200));
const prefill = await page.evaluate(() => ({
  baseUrl: document.getElementById('baseUrl').value,
  model: document.getElementById('model').value,
}));
check('remote ollama pre-fills baseUrl', prefill.baseUrl === 'http://localhost:11434/v1');
check('remote ollama pre-fills model gemma3:4b', prefill.model === 'gemma3:4b');

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
