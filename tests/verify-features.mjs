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

// --- Feature 0 (v3): text-first intro + hidden goal ---
// The intro narrative is the group's OPENING SCENE (not "Intro for the
// moderator"), and the goal is never shown to players.
const introHeading = await page.evaluate(() => {
  const h2s = Array.from(document.querySelectorAll('#phase-intro h2')).map((h) => h.textContent.trim());
  return h2s.join(' | ');
});
check('intro heading reads "Opening scene"', /Opening scene/i.test(introHeading));
check('intro heading no longer says "Intro for the moderator"', !/Intro for the moderator/i.test(introHeading));
const facilitatorLabel = await page.evaluate(() => {
  const h3s = Array.from(document.querySelectorAll('#phase-intro h3')).map((h) => h.textContent.trim());
  return h3s.join(' | ');
});
check('facilitator notes still labeled moderator-only', /players should not see this/i.test(facilitatorLabel));
// The goal must NOT appear anywhere in the DOM (players never see it).
const goalLeak = await page.evaluate(() => {
  const body = document.body.innerText;
  return /win_conditions|Crisis resolved|restore trust/i.test(body);
});
check('goal is NOT visible to players (no win_conditions/ending text in DOM)', !goalLeak);

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
check('remote ollama pre-fills model deepseek-v4-flash:cloud', remoteState.model === 'deepseek-v4-flash:cloud');

// Server (local) preset keeps its localhost base URL AND shows the field.
await page.select('#preset', 'server-local');
await new Promise((r) => setTimeout(r, 200));
const localState = await page.evaluate(() => ({
  baseUrl: document.getElementById('baseUrl').value,
  baseUrlDisplay: document.getElementById('baseUrl').style.display,
}));
check('server-local still pre-fills localhost baseUrl', localState.baseUrl === 'http://localhost:11434/v1');
check('server-local still SHOWS the Base URL field', localState.baseUrlDisplay !== 'none');

// --- Feature 2b: model dropdown for the "Ollama (remote)" preset ---
// Re-select the remote preset and verify the dropdown replaces the free-text
// model input, is populated from OLLAMA_MODELS, and stays in sync with the
// hidden free-text input (which is what saveSettings reads).
await page.select('#preset', 'ollama-remote');
await new Promise((r) => setTimeout(r, 200));
const dropdownState = await page.evaluate(() => ({
  selectDisplay: document.getElementById('modelSelect').style.display,
  modelDisplay: document.getElementById('model').style.display,
  options: Array.from(document.getElementById('modelSelect').options).map((o) => o.value),
  selected: document.getElementById('modelSelect').value,
  modelValue: document.getElementById('model').value,
}));
check('remote ollama SHOWS the model dropdown', dropdownState.selectDisplay !== 'none');
check('remote ollama HIDES the free-text model input', dropdownState.modelDisplay === 'none');
check('dropdown does NOT include gemma3:4b', !dropdownState.options.includes('gemma3:4b'));
check('dropdown includes glm-5.2:cloud', dropdownState.options.includes('glm-5.2:cloud'));
check('dropdown includes deepseek-v4-flash:cloud', dropdownState.options.includes('deepseek-v4-flash:cloud'));
check('dropdown includes qwen3.5:397b-cloud', dropdownState.options.includes('qwen3.5:397b-cloud'));
check('dropdown includes a Custom… option (value "")', dropdownState.options.includes(''));
check('dropdown pre-selects the current model deepseek-v4-flash:cloud', dropdownState.selected === 'deepseek-v4-flash:cloud');
check('free-text model input stays in sync with dropdown (deepseek-v4-flash:cloud)', dropdownState.modelValue === 'deepseek-v4-flash:cloud');

// Picking a real model updates the hidden free-text input value.
await page.select('#modelSelect', 'glm-5.2:cloud');
await new Promise((r) => setTimeout(r, 200));
const picked = await page.evaluate(() => ({
  modelValue: document.getElementById('model').value,
  modelDisplay: document.getElementById('model').style.display,
}));
check('picking a dropdown model updates the free-text input', picked.modelValue === 'glm-5.2:cloud');
check('free-text input stays hidden after picking a model', picked.modelDisplay === 'none');

// Picking "Custom…" (value "") reveals the free-text input.
await page.select('#modelSelect', '');
await new Promise((r) => setTimeout(r, 200));
const custom = await page.evaluate(() => document.getElementById('model').style.display);
check('picking Custom… reveals the free-text model input', custom !== 'none');

// A non-remote preset (server-local) shows the free-text input, not the dropdown.
await page.select('#preset', 'server-local');
await new Promise((r) => setTimeout(r, 200));
const nonRemote = await page.evaluate(() => ({
  selectDisplay: document.getElementById('modelSelect').style.display,
  modelDisplay: document.getElementById('model').style.display,
}));
check('non-remote preset HIDES the model dropdown', nonRemote.selectDisplay === 'none');
check('non-remote preset SHOWS the free-text model input', nonRemote.modelDisplay !== 'none');

// --- Feature 3: company URL field in settings ---
const companyField = await page.evaluate(() => ({
  hasInput: !!document.getElementById('companyUrl'),
  placeholder: (document.getElementById('companyUrl') || {}).placeholder || '',
  checkLabel: (document.getElementById('allowCompanyFetch') || {}).parentElement.textContent || '',
}));
check('settings has a companyUrl input', companyField.hasInput);
check('companyUrl input placeholder suggests example.com', companyField.placeholder === 'https://example.com');
check('company fetch checkbox label references the URL field', /company URL below/i.test(companyField.checkLabel));

// The companyUrl field persists across a save + reopen of settings.
await page.evaluate(() => {
  document.getElementById('companyUrl').value = 'https://example.org/acme';
  document.getElementById('allowCompanyFetch').checked = true;
  document.getElementById('saveSettings').click();
});
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => window.dispatchEvent(new CustomEvent('tabletop:refreshsettings')));
await new Promise((r) => setTimeout(r, 300));
const persisted = await page.evaluate(() => document.getElementById('companyUrl').value);
check('companyUrl persists across settings refresh', persisted === 'https://example.org/acme');

// --- Feature 4: session-only API key ("Don't remember my key") ---
// The rememberKey checkbox must exist and be checked by default.
const rkDefault = await page.evaluate(() => ({
  exists: !!document.getElementById('rememberKey'),
  checked: document.getElementById('rememberKey') ? document.getElementById('rememberKey').checked : null,
}));
check('settings has a rememberKey checkbox', rkDefault.exists);
check('rememberKey is checked by default', rkDefault.checked === true);

// Uncheck it, enter a key, and save. The key must NOT be written to
// localStorage, but the rest of the settings (provider/model/URL) must persist.
await page.evaluate(() => {
  document.getElementById('rememberKey').checked = false;
  document.getElementById('apiKey').value = 'sk-session-only-secret';
  document.getElementById('saveSettings').click();
});
await new Promise((r) => setTimeout(r, 300));
const afterSave = await page.evaluate(() => {
  const raw = localStorage.getItem('tabletop.dm.settings.v1');
  const parsed = raw ? JSON.parse(raw) : null;
  return {
    raw,
    storedKey: parsed ? parsed.apiKey : '(no settings)',
    rememberKey: parsed ? parsed.rememberKey : null,
  };
});
check('saving with rememberKey unchecked does NOT persist the key', afterSave.storedKey === '');
check('saved settings record rememberKey=false', afterSave.rememberKey === false);

// The key must still be usable for the current session: reloading settings
// (as buildProvider does) should surface the in-memory key.
const sessionKey = await page.evaluate(() => {
  // Re-import the registry module fresh to read the in-memory key path.
  return import('./app/js/providers/registry.js').then((m) => {
    const s = m.loadSettings();
    return s.apiKey;
  });
});
check('session-only key is still available in memory for the current session', sessionKey === 'sk-session-only-secret');

// Re-checking rememberKey and saving persists the key normally.
await page.evaluate(() => {
  document.getElementById('rememberKey').checked = true;
  document.getElementById('apiKey').value = 'sk-persisted-secret';
  document.getElementById('saveSettings').click();
});
await new Promise((r) => setTimeout(r, 300));
const persistedKey = await page.evaluate(() => {
  const raw = localStorage.getItem('tabletop.dm.settings.v1');
  return raw ? JSON.parse(raw).apiKey : null;
});
check('re-checking rememberKey persists the key to localStorage', persistedKey === 'sk-persisted-secret');

// --- Feature 5 (PR8): random scenario entry in the selector ---
// Return to the scenario select screen and verify the "Random scenario"
// option is present alongside the authored scenario. We're in the settings
// phase, so go back to the intro first, then "Change scenario".
await page.click('#settingsBack');
await new Promise((r) => setTimeout(r, 400));
await page.click('#changeScenario');
await new Promise((r) => setTimeout(r, 400));
const selectVisible2 = await page.evaluate(() => document.getElementById('phase-select').style.display === 'block');
check('select phase visible after Change scenario', selectVisible2);
const selectOptions = await page.evaluate(() =>
  Array.from(document.getElementById('scenarioSelect').options).map((o) => o.textContent.trim())
);
check('scenario selector includes the Random scenario option', selectOptions.some((t) => /random/i.test(t)));
check('scenario selector still includes the authored scenario', selectOptions.some((t) => /Bramble Badger/i.test(t)));

// Selecting the random scenario loads the generated shell (no pre-authored file).
const randomIdx = await page.evaluate(() =>
  Array.from(document.getElementById('scenarioSelect').options).findIndex((o) => /random/i.test(o.textContent))
);
await page.select('#scenarioSelect', String(randomIdx));
await new Promise((r) => setTimeout(r, 200));
await page.click('#loadScenarioBtn');
await new Promise((r) => setTimeout(r, 400));
const randomIntro = await page.evaluate(() => ({
  title: document.getElementById('scenarioTitle').textContent,
  introVisible: document.getElementById('phase-intro').style.display === 'block',
}));
check('random scenario loads into the intro phase', randomIntro.introVisible);
check('random scenario title shown', /Random/i.test(randomIntro.title));

// --- Feature 6 (PR8): kill chain does NOT leak to players ---
// The hidden attack-chain stage names/symptoms must NOT appear in the DOM
// before the group has revealed them. The goal/win_conditions must also stay
// hidden. (The play phase is not entered without a DM, but the intro DOM must
// not contain the hidden chain.)
const chainLeak = await page.evaluate(() => {
  const body = document.body.innerText;
  return /How they got in|How it spread|What they took|win_conditions|attacker_progress.*lte/i.test(body);
});
check('hidden attack chain does NOT leak to players in the intro', !chainLeak);

// --- Feature 7 (PR8): play-phase UI elements exist ---
// The play phase has a breach-state display, an attack-chain panel, and a
// "play a defender capability" (roll modifier) button.
const playUI = await page.evaluate(() => ({
  breach: !!document.getElementById('breachState'),
  chain: !!document.getElementById('attackChain'),
  capBtn: !!document.getElementById('playCapability'),
  mod: !!document.getElementById('rollModifier'),
  endBtn: !!document.getElementById('endExercise'),
}));
check('play phase has a breach-state element', playUI.breach);
check('play phase has an attack-chain panel', playUI.chain);
check('play phase has a defender-capability (roll modifier) button', playUI.capBtn);
check('play phase has a roll-modifier indicator', playUI.mod);
check('play phase has an end-exercise (manual conclude) button', playUI.endBtn);

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
