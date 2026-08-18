import puppeteer from 'puppeteer';

/**
 * Deterministic browser check for the two feature additions:
 *
 *   1. Scenario change: "Change scenario" returns to the #phase-select screen
 *      (re-populated from the registry), and re-selecting a scenario reloads
 *      its intro.
 *   2. Remote Ollama preset: the settings UI offers "Ollama (remote)" and
 *      HIDES the Base URL field (the connection routes via the server proxy,
 *      so no URL is needed in the browser); server-local keeps its localhost
 *      URL field.
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

// The select screen must not be a dead end: it needs explicit Load + Back.
const hasLoadBtn = await page.evaluate(() => !!document.getElementById('loadScenarioBtn'));
check('select screen has a "Load / Start" button', hasLoadBtn);
const hasBackBtn = await page.evaluate(() => !!document.getElementById('selectBack'));
check('select screen has a "Back" button', hasBackBtn);
const hasHint = await page.evaluate(() => (document.getElementById('scenarioSummary').textContent || '').length > 0);
check('select screen summary hints at the single available scenario', hasHint);

// Load the (single) scenario via the explicit button -> intro again.
await page.click('#loadScenarioBtn');
await new Promise((r) => setTimeout(r, 400));
const introAgain = await page.evaluate(() => document.getElementById('phase-intro').style.display === 'block');
check('Load button returns to intro', introAgain);

// The Back button must also escape the select screen back to the intro.
await page.click('#changeScenario');
await new Promise((r) => setTimeout(r, 400));
await page.click('#selectBack');
await new Promise((r) => setTimeout(r, 400));
const backToIntro = await page.evaluate(() => document.getElementById('phase-intro').style.display === 'block');
check('Back button returns to intro', backToIntro);

// --- Feature 2: remote Ollama preset in settings ---
await page.click('#settingsButton');
await new Promise((r) => setTimeout(r, 300));
await page.select('#providerSelect', 'openai-compatible');
await new Promise((r) => setTimeout(r, 200));
const presetVisible = await page.evaluate(() => document.getElementById('preset').style.display !== 'none');
check('preset dropdown visible for openai-compatible provider', presetVisible);
const presetOptions = await page.evaluate(() => Array.from(document.getElementById('preset').options).map((o) => o.value));
check('preset dropdown includes ollama-remote', presetOptions.includes('ollama-remote'));

// Selecting "Ollama (remote)" must NOT expose a base URL field at all — the
// connection routes through the server proxy (viaServer), so no URL is needed.
await page.select('#preset', 'ollama-remote');
await new Promise((r) => setTimeout(r, 200));
const remoteState = await page.evaluate(() => ({
  baseUrlDisplay: document.getElementById('baseUrl').style.display,
  baseUrlWrapDisplay: document.getElementById('baseUrlWrap').style.display,
  model: document.getElementById('model').value,
}));
check('remote ollama HIDES the Base URL field', remoteState.baseUrlDisplay === 'none');
check('remote ollama HIDES the Base URL label/wrap', remoteState.baseUrlWrapDisplay === 'none');
check('remote ollama pre-fills model gemma3:4b', remoteState.model === 'gemma3:4b');

// Server (local) preset keeps its localhost base URL AND shows the field.
await page.select('#preset', 'server-local');
await new Promise((r) => setTimeout(r, 200));
const localState = await page.evaluate(() => ({
  baseUrl: document.getElementById('baseUrl').value,
  baseUrlDisplay: document.getElementById('baseUrl').style.display,
}));
check('server-local still pre-fills localhost baseUrl', localState.baseUrl === 'http://localhost:11434/v1');
check('server-local still SHOWS the Base URL field', localState.baseUrlDisplay !== 'none');

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
