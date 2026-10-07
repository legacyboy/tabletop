/**
 * CAST CHECK — verifies the pre-scenario cast feature end-to-end in a browser.
 * New flow (Dan): the cast boxes appear on the SCENARIO SELECT screen as soon
 * as a scenario is highlighted, BEFORE "Load / Start". Load / Start goes
 * straight into the session (no intermediate intro screen).
 * Served by server/serve.js. Usage: node tests/cast-check.mjs [baseUrl]
 */
import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://localhost:8000';
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? pass++ : fail++; };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle0' });

const selectScenario = async (re) => {
  await page.evaluate((rx) => {
    const sel = document.getElementById('scenarioSelect');
    const idx = [...sel.options].findIndex((o) => new RegExp(rx, 'i').test(o.textContent));
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, re.source);
  await new Promise((r) => setTimeout(r, 500));
};

// 1. Settings no longer offers the company fetch.
const settings = await page.evaluate(() => ({
  hasUrl: !!document.getElementById('companyUrl'),
  hasFetch: !!document.getElementById('allowCompanyFetch'),
}));
check('settings has no companyUrl field', !settings.hasUrl);
check('settings has no allowCompanyFetch checkbox', !settings.hasFetch);

// 2. Selecting a scenario shows its cast form ON the select screen.
await selectScenario(/deepfake/i);
const onSelect = await page.evaluate(() => ({
  wrapVisible: document.getElementById('selectCastWrap').style.display !== 'none',
  count: document.querySelectorAll('#castFields input').length,
  hasCeo: !!document.getElementById('cast_ceo_name'),
  hasOrg: !!document.getElementById('cast_org_name'),
  phase: document.getElementById('phase-select').style.display,
}));
check('cast panel visible on the select screen', onSelect.wrapVisible);
check('cast form renders inputs on select screen', onSelect.count >= 4);
check('cast form includes ceo_name', onSelect.hasCeo);
check('cast form includes org_name', onSelect.hasOrg);
check('still on select screen (Load/Start not yet pressed)', onSelect.phase !== 'none');

// 3. Switching to Random hides the cast panel.
await selectScenario(/random/i);
const randomState = await page.evaluate(() => ({
  wrapVisible: document.getElementById('selectCastWrap').style.display !== 'none',
  count: document.querySelectorAll('#castFields input').length,
}));
check('random scenario hides the cast panel', !randomState.wrapVisible && randomState.count === 0);

// 4. Back to a scenario, type values, then Load / Start goes STRAIGHT to play.
await selectScenario(/deepfake/i);
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

// Configure a mock provider so beginSession does not bail out, then Load/Start.
await page.evaluate(() => {
  localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
    provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:59999/v1', model: 'mock',
  }));
});
await page.evaluate(() => document.getElementById('loadScenarioBtn').click());
await new Promise((r) => setTimeout(r, 800));
const afterLoad = await page.evaluate(() => ({
  play: document.getElementById('phase-play').style.display,
  intro: document.getElementById('phase-intro').style.display,
  title: document.getElementById('scenarioTitle').textContent,
}));
check('Load / Start went straight to the play screen', afterLoad.play !== 'none');
check('Load / Start did NOT show the intro screen', afterLoad.intro === 'none');

// 5. Every authored scenario offers cast fields on the select screen.
const SCENARIOS = ['rogue ai', 'whistleblower', 'executive scandal', 'toxic', 'deepfake'];
for (const name of SCENARIOS) {
  await page.evaluate(() => {
    // Return to the select screen via a reload (session may be mid-flight).
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await selectScenario(new RegExp(name, 'i'));
  const info = await page.evaluate(() => ({
    fields: document.querySelectorAll('#castFields input').length,
    hasOrg: !!document.getElementById('cast_org_name'),
  }));
  check(`${name}: has cast fields on select`, info.fields >= 4 && info.hasOrg);
}

await browser.close();
console.log(`\ncast-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
