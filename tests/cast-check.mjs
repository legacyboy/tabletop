/**
 * CAST CHECK — verifies the pre-scenario cast feature end-to-end in a browser:
 *   - the company-fetch UI is gone from settings
 *   - the Deepfake scenario declares cast fields that render on the intro screen
 *   - typing a value fills the case brief's {{tokens}}
 *   - a remembered value is restored on a later visit
 * Served by server/serve.js. Usage: node tests/cast-check.mjs [baseUrl]
 */
import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://localhost:8000';
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? pass++ : fail++; };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle0' });

// 1. Settings no longer offers the company fetch.
const settings = await page.evaluate(() => ({
  hasUrl: !!document.getElementById('companyUrl'),
  hasFetch: !!document.getElementById('allowCompanyFetch'),
}));
check('settings has no companyUrl field', !settings.hasUrl);
check('settings has no allowCompanyFetch checkbox', !settings.hasFetch);

// 2. Pick the Deepfake CEO scenario and load it.
await page.evaluate(() => {
  const sel = document.getElementById('scenarioSelect');
  const idx = [...sel.options].findIndex((o) => /deepfake/i.test(o.textContent));
  sel.value = String(idx);
  document.getElementById('loadScenarioBtn').click();
});
await new Promise((r) => setTimeout(r, 800));

// 3. Cast inputs render on the intro screen.
const cast = await page.evaluate(() => ({
  count: document.querySelectorAll('#castFields input').length,
  hasCeo: !!document.getElementById('cast_ceo_name'),
  hasOrg: !!document.getElementById('cast_org_name'),
}));
check('cast form renders inputs', cast.count >= 3);
check('cast form includes ceo_name', cast.hasCeo);
check('cast form includes org_name', cast.hasOrg);

// 4. Typing fills the case brief tokens.
await page.evaluate(() => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('cast_org_name', 'Northgate Credit Union');
  set('cast_ceo_name', 'Dana Whitfield');
});
await new Promise((r) => setTimeout(r, 200));
const brief = await page.evaluate(() => document.getElementById('moderatorRead').textContent);
check('case brief filled the org name', brief.includes('Northgate Credit Union'));
check('case brief filled the CEO name', brief.includes('Dana Whitfield'));
check('case brief has no leftover tokens', !brief.includes('{{'));

// 5. Reload and confirm the cast is remembered.
await page.reload({ waitUntil: 'networkidle0' });
await page.evaluate(() => {
  const sel = document.getElementById('scenarioSelect');
  const idx = [...sel.options].findIndex((o) => /deepfake/i.test(o.textContent));
  sel.value = String(idx);
  document.getElementById('loadScenarioBtn').click();
});
await new Promise((r) => setTimeout(r, 800));
const remembered = await page.evaluate(() => (document.getElementById('cast_ceo_name') || {}).value || '');
check('cast value is remembered across reloads', remembered === 'Dana Whitfield');

await browser.close();
console.log(`\ncast-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
