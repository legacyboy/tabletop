/**
 * Executive Tabletop D20 — main UI controller.
 *
 * Ties together the scenario loader, the DM provider registry, and the DM
 * session into the playable flow:
 *
 *   1. Scenario select
 *   2. Intro video (optional) + case introduction (intro phase)
 *   3. Free-text action box + D20 roll
 *   4. DM (LLM) adjudicates -> narrative + state update
 *   5. Timer running; end on condition or timeout -> closing report
 *
 * The DM is never allowed to lead: the group always types a free-form action
 * before any roll, and the DM receives that action verbatim.
 */

import { loadRegistry, loadScenario, fetchCompanyInfo, isRandomEntry, randomScenarioShell } from './scenarios.js';
import { buildProvider, loadSettings, describeProvider } from './providers/registry.js';
import { DMSession } from './dm.js';

const $ = (id) => document.getElementById(id);

const state = {
  registry: [],
  scenario: null,
  session: null,
  phase: 'select', // 'select' | 'intro' | 'play' | 'report'
  selectReturn: 'select', // phase the Back button on the select screen returns to
  companyInfo: null,
};

/** Bound DOM references set once after DOM ready. */
const el = {};

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function setPhase(phase) {
  state.phase = phase;
  ['select', 'intro', 'play', 'report', 'settings'].forEach((p) => {
    const section = $(`phase-${p}`);
    if (section) section.style.display = p === phase ? 'block' : 'none';
  });
  // Refresh the settings form each time it becomes visible.
  if (phase === 'settings') window.dispatchEvent(new CustomEvent('tabletop:openeditsettings'));
}

async function init() {
  // Cache DOM refs.
  ['scenarioSelect', 'scenarioTitle', 'scenarioSummary', 'introVideo', 'introNarrative',
   'startButton', 'actionText', 'manualRoll', 'submitBtn', 'outcome',
   'narrative', 'stateList', 'flags', 'timer', 'reportBody', 'exportReport',
   'progress', 'moderatorRead', 'companyNote', 'settingsButton',
   'loadScenarioBtn', 'selectBack', 'endExercise',
  ].forEach((id) => { el[id] = $(id); });

  // Settings navigation.
  $('settingsButton').onclick = () => setPhase('settings');

  // Scenario navigation: "Change scenario" (intro) and "New session / scenario"
  // (report) both return to the scenario-select screen and refresh the list.
  const changeScenario = $('changeScenario');
  if (changeScenario) changeScenario.onclick = () => showScenarioSelect();
  $('newSession').onclick = () => showScenarioSelect();

  // Scenario-select screen: explicit Load/Start + Back affordances so the
  // user is never stuck on a screen with no way forward or back.
  el.loadScenarioBtn.onclick = () => {
    const idx = Number(el.scenarioSelect.value);
    if (state.registry[idx]) selectScenario(idx);
  };
  el.selectBack.onclick = () => {
    const dest = state.selectReturn || (state.scenario ? 'intro' : 'select');
    setPhase(dest);
  };

  // Allow the settings panel's Back button to return to the scenario intro.
  window.addEventListener('tabletop:goback', () => {
    setPhase(state.scenario ? 'intro' : 'select');
  });
  window.addEventListener('tabletop:openeditsettings', () => {
    // Nudge settings.js to reflect latest saved values.
    window.dispatchEvent(new CustomEvent('tabletop:refreshsettings'));
  });

  await populateScenarios();
}

/** Fill the scenario <select> dropdown from the loaded registry. */
function renderScenarioOptions() {
  el.scenarioSelect.innerHTML = state.registry
    .map((s, i) => `<option value="${i}">${s.title}</option>`)
    .join('');
  // Changing the dropdown updates the summary (and keeps the Load button
  // usable) rather than silently auto-advancing. The user explicitly commits
  // with the Load / Start button.
  el.scenarioSelect.onchange = () => {
    updateSelectSummary();
    if (el.loadScenarioBtn) el.loadScenarioBtn.disabled = false;
  };
  updateSelectSummary();
}

/** Show which scenario is highlighted in the dropdown, and hint when there is
 *  only one option (so the screen is never confusing or dead-ended). */
function updateSelectSummary() {
  if (!el.scenarioSummary) return;
  const idx = Number(el.scenarioSelect.value);
  const count = state.registry.length;
  const desc = state.registry[idx];
  if (count === 0) {
    el.scenarioSummary.textContent = 'No scenarios are installed yet.';
    return;
  }
  if (count === 1 && desc) {
    el.scenarioSummary.textContent =
      `Only one scenario is available: ${desc.title}. Press "Load / Start" to continue.`;
    return;
  }
  if (desc) {
    el.scenarioSummary.textContent = `Selected: ${desc.title}. Press "Load / Start" to continue.`;
  }
}

async function populateScenarios() {
  state.registry = await loadRegistry();
  renderScenarioOptions();
  // On first load, jump straight to the (first) scenario's intro.
  await selectScenario(0);
}

/**
 * Return to the scenario-select phase, re-loading the registry so any new or
 * updated scenarios appear. Stops any in-progress session so its timer does
 * not keep counting down while the moderator picks a different scenario.
 */
async function showScenarioSelect() {
  if (state.session) {
    state.session.stopTimer();
    state.session = null;
  }
  // Remember where we came from so the Back button can return there.
  state.selectReturn = state.phase === 'report' ? 'report' : (state.scenario ? 'intro' : 'select');
  state.registry = await loadRegistry();
  renderScenarioOptions();
  // Reflect the currently loaded scenario in the dropdown (if still present).
  if (state.scenario && state.scenario.scenario_id) {
    const idx = state.registry.findIndex((s) => s.id === state.scenario.scenario_id);
    if (idx >= 0) el.scenarioSelect.value = String(idx);
  }
  updateSelectSummary();
  setPhase('select');
}

async function selectScenario(index) {
  const desc = state.registry[index];
  // Random mode: no pre-authored scenario.json — the DM generates the
  // scenario on the fly. Use the generated shell.
  const scenario = isRandomEntry(desc)
    ? randomScenarioShell()
    : await loadScenario(desc.path);
  state.scenario = scenario;
  state.isRandom = isRandomEntry(desc);

  el.scenarioTitle.textContent = scenario.title;

  // Show the case brief (intro.narrative) on the intro screen so participants
  // read the plot/story before starting. The DM is the LLM and everyone is a
  // participant, so this is the one text brief shown to the group.
  el.moderatorRead.textContent = scenario.intro.narrative || '';

  // Intro video (optional).
  const videoSrc = scenario.intro.video;
  if (videoSrc) {
    el.introVideo.src = videoSrc;
    el.introVideo.style.display = 'block';
  } else {
    el.introVideo.removeAttribute('src');
    el.introVideo.style.display = 'none';
  }

  // Fresh-company note.
  el.companyNote.textContent = '';
  state.companyInfo = null;

  // Buttons.
  el.startButton.onclick = () => beginSession();
  el.startButton.disabled = false;

  setPhase('intro');
}

async function beginSession() {
  try {
    const settings = loadSettings();
    const provider = buildProvider(settings);
    if (!provider) {
      el.outcome.textContent = 'No DM configured. Open Settings and choose an in-browser model or paste an API key.';
      return;
    }

    const scenario = state.scenario;

    // Best-effort company enrichment (does not block play). Uses the
    // user-entered company URL from settings when present, else the
    // scenario's intro.company_url. Gated by allowCompanyFetch.
    const companyUrl = (settings.companyUrl || '').trim() || (scenario.intro.company_url || '');
    if (companyUrl) {
      fetchCompanyInfo(scenario, { companyUrl }).then((info) => {
        state.companyInfo = info;
        if (state.session) state.session.companyInfo = info;
        if (info) el.companyNote.textContent = 'Company info fetched: added to DM context.';
      }).catch(() => {});
    }

    state.session = new DMSession(provider, scenario);
    state.session.onTimerTick = renderTimer;
    // Random mode: tell the DM to generate the scenario.
    if (state.isRandom) state.session.random = true;

    // Show the group's case introduction (intro.narrative). There is no
    // human facilitator — the DM is the LLM — so everyone reads the same case
    // brief and there are no moderator-only notes.
    el.moderatorRead.textContent = scenario.intro.narrative || '';

    state.session.start();

    const session = state.session;
    if (session.durationSeconds) {
      el.timer.textContent = formatTime(session.secondsLeft());
    } else {
      el.timer.textContent = 'no time limit';
    }

    renderState();
    setPhase('play');

    // Wire the roll flow (idempotent).
    bindRollFlow(scenario);
  } catch (err) {
    el.outcome.textContent = 'Could not start: ' + err.message;
  }
}

function bindRollFlow(scenario) {
  // Single Submit action: take the group's action text, roll the D20
  // internally, and let the DM adjudicate. This merges the old separate
  // 'D20' card + 'What does the group do?' card into one flow.
  el.submitBtn.onclick = async () => {
    const action = el.actionText.value;
    if (!action.trim()) {
      el.outcome.textContent = 'Type what the group wants to do, then submit.';
      return;
    }
    // Use a manual roll if one was entered (1–20); otherwise auto-roll the D20.
    let roll = 0;
    const manual = el.manualRoll.value.trim();
    if (manual) {
      const n = Number(manual);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        el.outcome.textContent = 'Manual roll must be a whole number from 1 to 20 (or leave blank to auto-roll).';
        return;
      }
      roll = n;
    } else {
      roll = Math.floor(Math.random() * 20) + 1;
    }
    await resolveTurn(action, roll);
  };

  // Ctrl/Cmd+Enter in the textarea also submits the action.
  el.actionText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.submitBtn.click();
    }
  });

  // End the exercise manually: the team decides it's done. This is the
  // intended way a session concludes (Dan: no instant loss on a stat hitting
  // 100 — the game runs until the group decides it's over).
  if (el.endExercise) {
    el.endExercise.onclick = () => {
      const session = state.session;
      if (!session) return;
      if (!confirm('End the exercise now and generate the closing report?')) return;
      finish({ type: 'manual', result: 'ended', ending: 'The group decided to conclude the exercise.' });
    };
  }
}

async function resolveTurn(action, roll) {
  const session = state.session;
  if (!session) return;

  const outcomeButton = el.outcome;
  outcomeButton.textContent = 'The DM is considering...';
  const keepValue = el.actionText.value;
  el.actionText.disabled = true;
  el.manualRoll.disabled = true;
  el.submitBtn.disabled = true;

  try {
    const result = await session.takeTurn(action, roll);

    el.narrative.textContent = result.narrative;
    if (result.event.fate) {
      el.outcome.textContent = `Roll ${roll} — FATE EVENT: ${result.event.fate}`;
      logLine(`Roll ${roll} fired a fate event: ${result.event.fate}`);
    } else {
      el.outcome.textContent = `Roll ${roll} resolved (Turn ${result.event.turn}).`;
    }

    logLine(
      `<b>Turn ${result.event.turn}</b>: ${escapeHtml(action)} — <b>d20=${roll}</b>`
    );

    renderState();

    if (result.endCondition) {
      finish(result.endCondition);
      return;
    }

    // Prepare next turn: clear the box(es), re-enable.
    el.actionText.disabled = false;
    el.actionText.value = '';
    el.manualRoll.disabled = false;
    el.manualRoll.value = '';
    el.actionText.focus();
    el.submitBtn.disabled = false;
  } catch (err) {
    el.actionText.disabled = false;
    el.actionText.value = keepValue;
    el.manualRoll.disabled = false;
    el.submitBtn.disabled = false;
    el.outcome.textContent = 'DM error: ' + err.message;
  }
}

function renderState() {
  const session = state.session;
  if (!session) return;
  // Danger zone: a stat that crosses a threshold in the scenario's
  // end_conditions is flagged visually (red) even though it does NOT end the
  // game — the team sees they're in trouble and must keep managing it.
  const dangerStats = {};
  for (const c of (session.scenario.end_conditions || [])) {
    if (c.type !== 'stat') continue;
    const v = session.state[c.stat];
    if (typeof v !== 'number') continue;
    const inZone = (c.operator === 'lte' && v <= c.value) || (c.operator === 'gte' && v >= c.value);
    if (inZone) dangerStats[c.stat] = c;
  }
  el.stateList.innerHTML = Object.entries(session.state)
    .map(([k, v]) => {
      const danger = dangerStats[k] ? ' danger' : '';
      const note = dangerStats[k]
        ? ` <span class="dangerNote" title="${escapeHtml(dangerStats[k].ending || 'In the danger zone')}">⚠️ danger</span>`
        : '';
      return `<div class="stateItem${danger}"><b>${humanize(k)}</b>: ${v}${note}</div>`;
    })
    .join('');

  const flags = session.history.filter((e) => e.fate).map((e) => e.fate);
  el.flags.textContent = flags.length ? 'Fate events: ' + flags.join(' | ') : 'No fate events yet.';
}

function renderTimer() {
  const session = state.session;
  if (!session) return;
  const left = session.secondsLeft();
  el.timer.textContent = formatTime(left);

  // Auto-finish on timeout.
  if (left <= 0) {
    const tEnd = session.timeoutEnd();
    finish(tEnd);
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function finish(endCondition) {
  const session = state.session;
  session.stopTimer();

  const report = session.buildReport(endCondition);
  renderReport(report);
  setPhase('report');
}

function renderReport(report) {
  el.reportBody.innerHTML = '';

  const add = (label, value) => {
    const row = document.createElement('div');
    row.className = 'stateItem';
    row.innerHTML = `<b>${label}</b>${value !== undefined && value !== null && value !== '' ? ':\n' + escapeHtml(String(value)) : ''}`;
    el.reportBody.appendChild(row);
  };

  add('Report', report.report_title);
  add('Scenario', report.scenario);
  add('Ending', report.ending || 'No end condition recorded');
  add('Turns', report.turns);
  add('Duration (min)', report.duration_minutes ?? '—');
  add('Final state', JSON.stringify(report.final_state, null, 2));

  // BDB-style debrief: which attack-chain stages the group contained and
  // which they missed. Executive-focused (plain-language stage names).
  if (report.attack_chain && report.attack_chain.length) {
    const contained = report.attack_chain.filter((s) => s.contained);
    const missed = report.attack_chain.filter((s) => !s.contained);
    const debrief = [
      `Contained (${contained.length}/${report.attack_chain.length}):`,
      ...contained.map((s) => `  ✅ ${s.name}`),
      missed.length ? `Missed (${missed.length}):` : '',
      ...missed.map((s) => `  ❌ ${s.name}`),
    ].filter(Boolean).join('\n');
    add('Attack chain debrief', debrief);
    add('Final breach state', report.breach_state || '—');
  }

  report.log.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'stateItem';
    div.innerHTML =
      `<b>Turn ${i + 1}</b> (d20=${e.roll})<br>${escapeHtml(e.narrative)}` +
      (e.fate ? `<br><i>Fate: ${escapeHtml(e.fate)}</i>` : '') +
      `<br><small>State after: ${escapeHtml(JSON.stringify(e.state))}</small>`;
    el.reportBody.appendChild(div);
  });

  el.exportReport.onclick = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tabletop-report-${report.scenario_id || 'run'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function logLine(html) {
  const log = $('log');
  if (!log) return;
  log.insertAdjacentHTML('afterbegin', `<div class="logItem">${html}</div>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// Boot.
document.addEventListener('DOMContentLoaded', init);
