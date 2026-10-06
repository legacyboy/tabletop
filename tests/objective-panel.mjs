/**
 * Browser test: the OBJECTIVE panel (story win, not a score gate).
 *
 * Loads the app in a real browser, starts a session against the local mock LLM,
 * and asserts:
 *   - the Objective panel is visible in the PLAY phase
 *   - it shows the story goal description
 *   - it lists the beat arc and highlights the CURRENT step (not a metric list)
 *   - it states the win is narrative (metrics are texture, not a gate)
 *   - it does NOT print a numeric target checklist (no "60", "55", "≥ 80" gate)
 *
 * Usage: node tests/objective-panel.mjs
 *   (expects the app on http://localhost:8000 and the mock LLM on :9999)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = 'http://localhost:8000/index.html';
const MOCK_PORT = 9999;

const results = [];
const record = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };

// ---- Mock LLM: always a clean, structured DM reply. ----
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = {
      narrative: 'The team moves deliberately. ' + 'The crisis shifts. '.repeat(3),
      state_delta: { public_trust: 2 },
      progress: true,
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

const { default: puppeteer } = await import('puppeteer');
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(APP, { waitUntil: 'networkidle0' });

  // Force the app to use the local mock provider and skip the intro friction.
  await page.evaluate((mockUrl) => {
    localStorage.setItem('tabletop.dm.settings.v1', JSON.stringify({
      provider: 'openai-compatible', baseUrl: mockUrl, apiKey: 'x', rememberKey: true,
      model: 'mock-dm', allowCompanyFetch: false, autoRoll: true,
    }));
  }, `http://localhost:${MOCK_PORT}/v1`);

  await page.reload({ waitUntil: 'networkidle0' });

  // Load the first (non-random) scenario + start.
  await page.waitForSelector('#scenarioSelect .option, #scenarioSelect option', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => {
    const sel = document.getElementById('scenarioSelect');
    if (sel && sel.tagName === 'SELECT' && sel.options.length > 1) sel.selectedIndex = 1;
    const btn = document.getElementById('loadScenarioBtn') || document.getElementById('startButton');
    if (btn) btn.click();
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('phase-play');
    return p && p.style.display !== 'none';
  }, { timeout: 20000 }).catch(() => {});

  // Start if there's a start button still visible.
  await page.evaluate(() => { const b = document.getElementById('startButton'); if (b && b.offsetParent) b.click(); });
  await page.waitForFunction(() => {
    const p = document.getElementById('phase-play');
    return p && p.style.display !== 'none';
  }, { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  const probe = await page.evaluate(() => {
    const panel = document.getElementById('objectivePanel');
    const visible = !!(panel && panel.style.display !== 'none' && panel.innerHTML.trim());
    const txt = panel ? panel.innerText : '';
    const hasArc = !!document.querySelector('#objectivePanel .arcList .arcStep');
    const activeStep = !!document.querySelector('#objectivePanel .arcStep.active');
    const claimsNarrative = /work\w* the arc to its end|reach the final step to win|resolv\w* the STORY/i.test(txt);
    // Dan's design (2026-10-06): the panel must make clear containment is an
    // ALTERNATIVE and not required — missing a stage must not read as a failure.
    const saysContainmentOptional = /do NOT need to contain|alternative way|missing a stage/i.test(txt);
    // Guard: the panel must NOT present a numeric-threshold checklist.
    const leaksNumericGate = /≥\s*\d|\b(60|55|80|70)\b.*\b(win|target|achieve)\b/i.test(txt);
    return { visible, txt, hasArc, activeStep, claimsNarrative, saysContainmentOptional, leaksNumericGate };
  });

  record('Objective panel is visible in the PLAY phase', probe.visible);
  record('Objective panel lists the story arc (beats)', probe.hasArc);
  record('Objective panel highlights the CURRENT step', probe.activeStep);
  record('Objective panel states the win is narrative', probe.claimsNarrative, probe.txt.slice(0, 60).replace(/\n/g, ' '));
  record('Objective panel says containment is an alternative, not required', probe.saysContainmentOptional);
  record('Objective panel does NOT leak a numeric win-gate checklist', !probe.leaksNumericGate);

  // Take one turn and confirm the panel still renders (the arc marks keep the
  // current step highlighted as play proceeds).
  await page.evaluate(() => { const t = document.getElementById('actionText'); if (t) t.value = 'We issue a clear, factual public statement.'; });
  await page.evaluate(() => { const b = document.getElementById('submitBtn'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await page.evaluate(() => {
    const panel = document.getElementById('objectivePanel');
    return { visible: !!(panel && panel.style.display !== 'none'), steps: document.querySelectorAll('#objectivePanel .arcStep').length };
  });
  record('Objective panel persists through a played turn', after.visible && after.steps > 0, `${after.steps} steps`);

  // ---- Story-arc hide/fuzz toggle (Dan, 2026-10-06) ---------------------
  // The group may want to attempt the exercise cold. The toggle must fuzz the
  // arc steps (not just delete them), keep the objective visible, and be
  // reversible. While hidden, no step may reveal which one is current.
  const toggleVisible = await page.evaluate(() => {
    const b = document.getElementById('arcToggle');
    return !!b && b.offsetParent !== null;
  });
  record('Story-arc hide toggle is offered in the PLAY phase', toggleVisible);

  await page.evaluate(() => { const b = document.getElementById('arcToggle'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 300));
  const hidden = await page.evaluate(() => {
    const panel = document.getElementById('objectivePanel');
    const steps = [...document.querySelectorAll('#objectivePanel .arcStep')];
    const fuzzed = steps.filter((s) => s.classList.contains('fuzzed')).length;
    const activeWhileHidden = document.querySelectorAll('#objectivePanel .arcStep.active').length;
    const label = document.getElementById('arcToggle').textContent.trim();
    return {
      panelVisible: panel.style.display !== 'none',
      steps: steps.length,
      fuzzed,
      activeWhileHidden,
      label,
      readsHidden: /hidden|reveal/i.test(label),
      objectiveStillThere: /objective/i.test(panel.innerText),
    };
  });
  record('Hiding the arc keeps the Objective panel visible', hidden.panelVisible && hidden.objectiveStillThere);
  record('Hiding the arc fuzzes every step (keeps shape, hides text)', hidden.steps > 0 && hidden.fuzzed === hidden.steps, `${hidden.fuzzed}/${hidden.steps} fuzzed`);
  record('Hiding the arc withholds the CURRENT step highlight (no position leak)', hidden.activeWhileHidden === 0);
  record('Toggle label flips to a reveal affordance', hidden.readsHidden, hidden.label);

  await page.evaluate(() => { const b = document.getElementById('arcToggle'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 300));
  const revealed = await page.evaluate(() => ({
    fuzzed: document.querySelectorAll('#objectivePanel .arcStep.fuzzed').length,
    active: document.querySelectorAll('#objectivePanel .arcStep.active').length,
    label: document.getElementById('arcToggle').textContent.trim(),
  }));
  record('Revealing the arc restores the normal steps + active marker', revealed.fuzzed === 0 && revealed.active === 1, revealed.label);
} finally {
  await browser.close();
  mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n############ SUMMARY: ${passed}/${results.length} passed ############`);
process.exit(passed === results.length ? 0 : 1);
