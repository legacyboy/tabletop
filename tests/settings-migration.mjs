/**
 * SETTINGS MIGRATION (browser) — boot the DEPLOYED app with a STALE
 * localStorage settings payload (the retired Ollama model id) and assert the
 * app self-heals to the replacement (deepseek-v4.1-flash:cloud), both in the
 * persisted settings and in the visible UI.
 *
 * This closes the gap that the migration was unit-tested but never exercised
 * through the real browser boot path against the shipped bundle.
 *
 * Usage:
 *   LIVE_URL=https://legacyboy.github.io/tabletop node tests/settings-migration.mjs
 */
import puppeteer from 'puppeteer';

const LIVE = (process.env.LIVE_URL || 'https://legacyboy.github.io/tabletop').replace(/\/+$/, '');
const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

console.log(`\n############ SETTINGS MIGRATION (live) — ${LIVE} ############\n`);

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${LIVE}/`, { waitUntil: 'networkidle0' });

// Seed a STALE settings payload: the retired model id, server-routed.
const STALE = {
  provider: 'server-proxy', preset: 'ollama-remote', viaServer: true,
  baseUrl: '', model: 'deepseek-v4-flash:cloud', apiKey: 'stale-key',
};
await page.evaluate((stale) => localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify(stale)), STALE);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));

// 1. The persisted settings must have been migrated on load.
const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('tabletop.dm.settings.v1') || '{}'));
record('stale retired model id migrated', migrated.model === 'deepseek-v4.1-flash:cloud', `model=${migrated.model}`);
record('no retired id remains in settings', JSON.stringify(migrated).indexOf('deepseek-v4-flash:cloud') === -1);

// 2. The settings UI (when opened) must show the new model selected.
try {
  await page.click('#settingsButton');
  await new Promise((r) => setTimeout(r, 600));
  const uiModel = await page.evaluate(() => {
    const m = document.getElementById('model') || document.getElementById('modelSelect');
    return m ? m.value : null;
  });
  record('settings UI shows the migrated model', uiModel === 'deepseek-v4.1-flash:cloud', `uiModel=${uiModel}`);

  // If the model UI is a dropdown, the replacement id must be an option.
  const hasOption = await page.evaluate(() => {
    const sel = document.getElementById('modelSelect') || document.getElementById('model');
    if (!sel || sel.tagName !== 'SELECT') return true; // not a dropdown: skip
    return [...sel.options].some((o) => o.value === 'deepseek-v4.1-flash:cloud');
  });
  record('replacement id is selectable in the model dropdown', hasOption);
} catch (e) {
  record('settings UI shows the migrated model', false, 'could not open settings: ' + e.message);
}

record('no page errors during boot', errors.length === 0, errors.slice(0, 2).join(' / '));

await browser.close();

const pass = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${pass}/${results.length} passed ############`);
for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.n}: ${f.d}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
