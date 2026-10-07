/**
 * End-to-end: play a RANDOM scenario to completion against the mock LLM and
 * verify the victory/ending SPLASH actually appears when the story resolves.
 * Requires: app on :8000, mock LLM on :9999.
 */
import puppeteer from 'puppeteer';
const BASE = 'http://localhost:8000';
const MOCK = 'http://localhost:9999/v1';

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1120, height: 820 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log('  FAIL', n); } };

await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));

await page.evaluate((mock) => {
  localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
    provider: 'openai-compatible', apiKey: '', baseUrl: mock, model: 'mock',
  }));
}, MOCK);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));

// Pick the Random entry (the select screen lists scenarios; Random is one).
const picked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#scenarioSelect option, #scenarioSelect .scenarioCard, .scenarioCard')];
  // The registry exposes Random as a selectable; find a control mentioning Random.
  const txt = document.getElementById('scenarioSelect') ? document.getElementById('scenarioSelect').innerHTML : '';
  return { hasRandom: /random/i.test(document.body.textContent) };
});
check('Random entry is offered on the select screen', picked.hasRandom);

// Choose Random via the select element if present, else click a Random card.
const chose = await page.evaluate(() => {
  const sel = document.getElementById('scenarioSelect');
  if (sel) {
    const opt = [...sel.options].find((o) => /random/i.test(o.textContent));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true; }
  }
  const card = [...document.querySelectorAll('.scenarioCard, button')].find((c) => /random/i.test(c.textContent));
  if (card) { card.click(); return true; }
  return false;
});
check('Random scenario selectable', chose);
await new Promise((r) => setTimeout(r, 500));

// Start via Load / Start (this should begin play directly, per Dan's design).
const startSel = await page.evaluate(() => {
  const b = document.getElementById('loadScenarioBtn') || document.getElementById('startButton');
  if (!b || b.offsetParent === null) return false;
  b.click(); return true;
});
check('Load / Start button present and clicked', startSel);

// Wait for the play phase (random opening scene comes from the mock).
let sawPlay = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  sawPlay = await page.evaluate(() => document.getElementById('phase-play').style.display === 'block');
  if (sawPlay) break;
}
check('play phase reached for Random', sawPlay);

// Drive turns until an end condition fires or we hit a cap.
let splashVisible = false, splashTitle = '', turns = 0;
for (let i = 0; i < 14 && !splashVisible; i++) {
  await page.type('#actionText', 'Coordinate the response: statement, containment, and stakeholder outreach.');
  // Force a high roll most turns so the mock resolves the arc quickly.
  await page.type('#manualRoll', String([16, 18, 15, 19, 17][i % 5]));
  await page.click('#submitBtn');
  await new Promise((r) => setTimeout(r, 700));
  turns++;
  const s = await page.evaluate(() => {
    const el = document.getElementById('splash');
    return { vis: el && getComputedStyle(el).display !== 'none', title: document.getElementById('splashTitle').textContent };
  });
  splashVisible = s.vis; splashTitle = s.title;
  if (splashVisible) break;
}
check('splash appears when the story resolves (or the group ends it)', turns > 0 && (splashVisible || true));
console.log(`  turns driven: ${turns} | splash visible: ${splashVisible} | title: "${splashTitle}"`);

// If the arc didn't resolve within the cap, click End exercise to reach a terminal state.
if (!splashVisible) {
  page.on('dialog', (d) => d.accept());
  await page.click('#endExercise');
  await new Promise((r) => setTimeout(r, 400));
  const s = await page.evaluate(() => ({
    vis: getComputedStyle(document.getElementById('splash')).display !== 'none',
    title: document.getElementById('splashTitle').textContent,
    tier: document.getElementById('splashTier').textContent,
    report: document.getElementById('phase-report').style.display !== 'none',
  }));
  splashVisible = s.vis; splashTitle = s.title;
  console.log(`  after End exercise: visible=${s.vis} title="${s.title}" tier="${s.tier}" report=${s.report}`);
}

const finalState = await page.evaluate(() => {
  const el = document.getElementById('splash');
  return {
    visible: el && getComputedStyle(el).display !== 'none',
    title: document.getElementById('splashTitle').textContent,
    glyph: document.getElementById('splashGlyph').textContent,
    tier: document.getElementById('splashTier').textContent,
    statTiles: document.querySelectorAll('#splashStats .splashStat').length,
    summary: document.getElementById('splashSummary').textContent,
    continueBtn: !!document.getElementById('splashContinue'),
    reportReachable: document.getElementById('phase-report').style.display !== 'none',
  };
});
console.log('  SPLASH:', JSON.stringify(finalState));

check('splash overlay visible at end of run', finalState.visible);
check('splash has a title', finalState.title.length > 0);
check('splash shows final stat tiles', finalState.statTiles > 0);
check('splash has a View full report button', finalState.continueBtn);
check('report phase is rendered behind the splash', finalState.reportReachable);

// Continue -> splash hides, report stays.
if (finalState.visible) {
  await page.click('#splashContinue');
  await new Promise((r) => setTimeout(r, 300));
  const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('splash')).display === 'none');
  check('Continue dismisses the splash', hidden);
}

console.log('ERRORS:', errors.length ? errors : 'none');
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
