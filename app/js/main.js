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

import { loadRegistry, loadScenario, isRandomEntry, randomScenarioShell, applyCast, castBrief } from './scenarios.js';
import { buildProvider, loadSettings, describeProvider } from './providers/registry.js';
import { DMSession } from './dm.js';
import { BnbSession } from './bnb-session.js';

const $ = (id) => document.getElementById(id);

const state = {
  registry: [],
  scenario: null,
  session: null,
  phase: 'select', // 'select' | 'intro' | 'play' | 'report'
  selectReturn: 'select', // phase the Back button on the select screen returns to
  cast: null,
  castLabels: {},
  tabId: null, // unique per browser tab, for two-tab detection
  readOnly: false, // true when another tab owns the live session
  arcHidden: false, // true = story arc is fuzzed in the Objective panel (Dan, 2026-10-06)
};

/** Bound DOM references set once after DOM ready. */
const el = {};

// ---- Session persistence (refresh/resume + two-tab safety) --------------
// The live DM session is snapshotted to localStorage after each turn so a
// browser refresh (or accidental close) can resume without losing the game.
// A second tab is detected via the storage event and offered read-only resume
// rather than silently driving the same session from two places.
const SESSION_KEY = 'tabletop.dm.session.v1';
const TAB_KEY = 'tabletop.dm.activetab.v1';

function saveSessionSnapshot() {
  const s = state.session;
  if (!s || s.ended) return;
  if (state.readOnly) return; // another tab owns the live session
  try {
    const snap = s.serialize();
    snap.__savedAt = Date.now();
    snap.__tabId = state.tabId;
    localStorage.setItem(SESSION_KEY, JSON.stringify(snap));
  } catch { /* quota / private mode: persistence is best-effort */ }
}

function clearSessionSnapshot() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

function loadSessionSnapshot() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.scenario_id) return null;
    return snap;
  } catch { return null; }
}

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function setPhase(phase) {
  state.phase = phase;
  ['select', 'intro', 'play', 'it', 'report', 'settings'].forEach((p) => {
    const section = $(`phase-${p}`);
    if (section) section.style.display = p === phase ? 'block' : 'none';
  });
  // Refresh the settings form each time it becomes visible.
  if (phase === 'settings') window.dispatchEvent(new CustomEvent('tabletop:openeditsettings'));
}

async function init() {
  // Cache DOM refs.
  ['scenarioSelect', 'scenarioTitle', 'scenarioSummary', 'introVideo', 'introNarrative',
   'startButton', 'actionText', 'manualRoll', 'playerName', 'submitBtn', 'outcome',
   'narrative', 'stateList', 'flags', 'objectivePanel', 'arcToggle', 'timer', 'reportBody', 'exportReport',
   'storyRecap', 'autoRollBtn',
   'progress', 'moderatorRead', 'castFields', 'castFieldsIntro', 'selectCastWrap', 'castNote', 'settingsButton',
   'loadScenarioBtn', 'selectBack', 'endExercise',
   'askDMText', 'askDMBtn', 'askDMStatus', 'askDMAnswers',
   'eliteSetup', 'itSetup', 'itCompany', 'itRounds', 'modeSelect', 'orgVarsWrap', 'orgVarFields',
   'itProcedure', 'itRerollHand', 'itTarget', 'itNote', 'itRoll', 'itSubmit', 'itAutoRoll',
   'itOutcome', 'itNarrative', 'itEnd', 'itTimer', 'itRoundLine',
   'itAttackPath', 'itInjectFeed', 'itLog',
  ].forEach((id) => { el[id] = $(id); });

  // Restore the arc's shown/hidden state (per tab). Lets a facilitator hide the
  // arc before handing the screen to the group and have it stick across reloads.
  try { state.arcHidden = sessionStorage.getItem('tabletop.dm.arcHidden.v1') === '1'; } catch {}

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
    const mode = currentMode();
    if (mode === 'it') { startItSession(); return; }
    const idx = Number(el.scenarioSelect.value);
    if (state.registry[idx]) selectScenario(idx);
  };
  el.selectBack.onclick = () => {
    const dest = state.selectReturn || (state.scenario ? 'intro' : 'select');
    setPhase(dest);
  };

  // Version picker (Executive vs IT). Dan, 2026-10-08.
  bindModePicker();

  // Allow the settings panel's Back button to return to the scenario intro.
  window.addEventListener('tabletop:goback', () => {
    setPhase(state.scenario ? 'intro' : 'select');
  });
  window.addEventListener('tabletop:openeditsettings', () => {
    // Nudge settings.js to reflect latest saved values.
    window.dispatchEvent(new CustomEvent('tabletop:refreshsettings'));
  });

  // ---- Two-tab safety + resume -----------------------------------------
  // Give this tab an id and publish it as the active tab.
  state.tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try { localStorage.setItem(TAB_KEY, state.tabId); } catch { /* ignore */ }

  // If another tab takes over the active-tab key, this tab is now a follower:
  // it stops writing snapshots so the two tabs cannot fight over the session.
  window.addEventListener('storage', (e) => {
    if (e.key === TAB_KEY && e.newValue && e.newValue !== state.tabId) {
      state.readOnly = true;
      if (el.outcome && state.phase === 'play') {
        el.outcome.textContent = 'Another tab is now playing this session. This tab is read-only.';
      }
    }
    // Another tab finished/ended the session: drop our stale snapshot view.
    if (e.key === SESSION_KEY && !e.newValue && state.phase === 'play' && state.readOnly) {
      el.outcome.textContent = 'The session ended in another tab.';
    }
  });

  await populateScenarios();

  // Offer to resume an interrupted session (saved snapshot with turns).
  const snap = loadSessionSnapshot();
  if (snap && snap.scenario_id && (snap.turn || 0) > 0 && !snap.ended) {
    const when = snap.__savedAt ? new Date(snap.__savedAt).toLocaleString() : 'earlier';
    const ok = confirm(`Resume your interrupted session (${snap.scenario_id}, turn ${snap.turn}, saved ${when})?\n\nCancel to start fresh.`);
    if (ok) {
      const resumed = await resumeSession(snap);
      if (!resumed) clearSessionSnapshot();
    } else {
      clearSessionSnapshot();
    }
  }
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
 *  only one option (so the screen is never confusing or dead-ended). Also
 *  renders that scenario's pre-start cast form right here, so the moderator
 *  fills the names BEFORE pressing Load / Start. */
function updateSelectSummary() {
  if (!el.scenarioSummary) return;
  const idx = Number(el.scenarioSelect.value);
  const count = state.registry.length;
  const desc = state.registry[idx];
  if (count === 0) {
    el.scenarioSummary.textContent = 'No scenarios are installed yet.';
    hideSelectCast();
    return;
  }
  if (count === 1 && desc) {
    el.scenarioSummary.textContent =
      `Only one scenario is available: ${desc.title}. Press "Load / Start" to continue.`;
  } else if (desc) {
    el.scenarioSummary.textContent = `Selected: ${desc.title}. Press "Load / Start" to continue.`;
  }
  renderSelectCast(desc);
}

/** Render the cast form on the select screen for the highlighted scenario.
 *  The registry only carries id/title/path, so fetch the scenario JSON to read
 *  its `cast` array. Results are cached; failures just hide the panel. */
const _castCache = new Map();
async function renderSelectCast(desc) {
  if (!el.selectCastWrap || !el.castFields) return;
  state.selectCastIndex = desc ? state.registry.indexOf(desc) : -1;
  if (!desc || desc.random || !desc.path) {
    hideSelectCast();
    return;
  }
  let scenario = _castCache.get(desc.path);
  if (!scenario) {
    try {
      scenario = await loadScenario(desc.path);
      _castCache.set(desc.path, scenario);
    } catch {
      hideSelectCast();
      return;
    }
  }
  // Guard against a race: only paint if this scenario is still selected.
  if (state.selectCastIndex !== state.registry.indexOf(desc)) return;
  const fields = Array.isArray(scenario.cast) ? scenario.cast : [];
  if (!fields.length) {
    hideSelectCast();
    return;
  }
  el.selectCastWrap.style.display = 'block';
  renderCastFields(scenario, el.castFields);
}

function hideSelectCast() {
  if (el.selectCastWrap) el.selectCastWrap.style.display = 'none';
  if (el.castFields) el.castFields.innerHTML = '';
}

async function populateScenarios() {
  state.registry = await loadRegistry();
  renderScenarioOptions();
  // Do NOT auto-load a scenario (or its intro video) on page load — Dan wants
  // the scenario-select screen shown first, with nothing loaded until the
  // user explicitly picks a scenario and presses "Load / Start".
  state.selectReturn = null;
  setPhase('select');
}

/**
 * Return to the scenario-select phase, re-loading the registry so any new or
 * updated scenarios appear. Stops any in-progress session so its timer does
 * not keep counting down while the moderator picks a different scenario.
 */
async function showScenarioSelect() {
  if (state.session) {
    if (typeof state.session.stopTimer === 'function') state.session.stopTimer();
    if (itTimerHandle) { clearInterval(itTimerHandle); itTimerHandle = null; }
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

/**
 * Render the pre-scenario cast form on the intro screen. Fields come from the
 * scenario's optional `cast` array (each { key, label, placeholder }); if the
 * scenario declares none, nothing is shown. Values are remembered per scenario
 * in localStorage so a moderator only types them once.
 */
function renderCastFields(scenario, hostEl) {
  const host = hostEl || el.castFields;
  if (!host) return;
  host.innerHTML = '';

  const fields = Array.isArray(scenario.cast) ? scenario.cast : [];
  if (!fields.length) {
    state.cast = {};
    state.castLabels = {};
    return;
  }

  state.cast = loadCast(scenario.scenario_id);
  const orgVars = loadOrgVars();
  state.castLabels = {};

  for (const f of fields) {
    if (!f || !f.key) continue;
    state.castLabels[f.key] = f.label || f.key;
    // Pre-fill from the shared Organization & People section when the scenario
    // field has no explicit per-scenario value yet (Dan 2026-10-08).
    if (!String(state.cast[f.key] || '').trim() && String(orgVars[f.key] || '').trim()) {
      state.cast[f.key] = orgVars[f.key];
    }
    const wrap = document.createElement('label');
    wrap.className = 'cast-field';
    wrap.textContent = f.label || f.key;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'cast_' + f.key;
    input.placeholder = f.placeholder || '';
    input.value = state.cast[f.key] || '';
    input.oninput = () => {
      state.cast[f.key] = input.value.trim();
      saveCast(scenario.scenario_id, state.cast);
      refreshIntroBrief();
    };
    wrap.appendChild(input);
    host.appendChild(wrap);
  }
}

/** Re-render the intro case brief with current cast values filled in. */
function refreshIntroBrief() {
  if (!state.scenario) return;
  const filled = applyCast(state.scenario, state.cast || {}).intro || {};
  el.moderatorRead.textContent = filled.narrative || '';
}

function castStorageKey(id) {
  return 'tabletop.dm.cast.v1.' + (id || 'default');
}

function loadCast(id) {
  try {
    return JSON.parse(localStorage.getItem(castStorageKey(id)) || '{}') || {};
  } catch {
    return {};
  }
}

function saveCast(id, cast) {
  try {
    localStorage.setItem(castStorageKey(id), JSON.stringify(cast || {}));
  } catch {}
}

async function selectScenario(index) {
  const desc = state.registry[index];
  // Random mode: no pre-authored scenario.json — the DM generates the
  // scenario on the fly. Use the generated shell.
  const rawScenario = isRandomEntry(desc)
    ? randomScenarioShell()
    : await loadScenario(desc.path);
  state.isRandom = isRandomEntry(desc);

  // The cast the moderator filled in on the select screen (kept in state.cast
  // by renderCastFields). Apply it now so tokens are filled for this session.
  const cast = state.cast || {};
  const scenario = applyCast(rawScenario, cast);
  state.scenario = scenario;

  el.scenarioTitle.textContent = scenario.title;
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

  // Dan: "Load / Start" should START the session directly — no extra screen in
  // between. Go straight into play. (The intro phase is only used as a fallback
  // when no DM is configured, so the moderator can set one up.)
  el.castNote.textContent = '';
  el.startButton.onclick = () => beginSession();
  el.startButton.disabled = false;
  await beginSession();
}

async function resumeSession(snap) {
  try {
    const settings = loadSettings();
    const provider = buildProvider(settings);
    if (!provider) {
      el.outcome.textContent = 'No DM configured to resume. Open Settings first.';
      return false;
    }
    const desc = state.registry.find((s) => s.id === snap.scenario_id);
    if (!desc) return false;
    const scenario = await loadScenario(desc.path);
    state.scenario = scenario;
    state.isRandom = isRandomEntry(desc);

    state.session = DMSession.restore(provider, scenario, snap);
    state.session.onTimerTick = renderTimer;
    state.session.start();

    el.moderatorRead.textContent = scenario.intro.narrative || '';
    el.scenarioTitle.textContent = scenario.title;
    if (state.session.durationSeconds) {
      el.timer.textContent = formatTime(state.session.secondsLeft());
    } else {
      el.timer.textContent = 'no time limit';
    }

    // Re-build the run log from the restored history so the player sees where
    // they left off.
    (state.session.history || []).forEach((e) => {
      if (!e || e.turn === 0 || e.action === '(opening scene)') {
        if (e && e.narrative) el.narrative.textContent = e.narrative;
        return;
      }
      logLine(`<b>Turn ${e.turn}</b>: <b>${escapeHtml(e.action)}</b> — <b>d20=${e.roll}</b><br>${escapeHtml(e.narrative)}`);
    });

    renderState();
    setPhase('play');
    bindRollFlow(scenario);
    el.outcome.textContent = 'Session resumed. What does the group do?';
    return true;
  } catch (err) {
    el.outcome.textContent = 'Could not resume: ' + err.message;
    return false;
  }
}

async function beginSession() {
  try {
    const settings = loadSettings();
    const provider = buildProvider(settings);
    if (!provider) {
      // No DM configured: fall back to the intro screen so the moderator can
      // open Settings, then press Start. (Normal path starts straight from
      // the select screen.)
      el.outcome.textContent = 'No DM configured. Open Settings and choose an in-browser model or paste an API key.';
      setPhase('intro');
      return;
    }

    const baseScenario = state.scenario;

    // Apply the moderator's pre-scenario cast: fill {{placeholders}} and hand
    // the names to the DM as context. Non-destructive: builds a new scenario.
    const cast = state.cast || {};
    const scenario = applyCast(baseScenario, cast);
    state.scenario = scenario;

    state.session = new DMSession(provider, scenario);
    state.session.onTimerTick = renderTimer;
    state.session.castInfo = castBrief(cast, state.castLabels || {});
    if (state.session.castInfo) {
      el.castNote.textContent = 'Cast applied to this session.';
    }
    // Random mode: tell the DM to generate the scenario.
    if (state.isRandom) state.session.random = true;
    // A brand-new session supersedes any saved (resumable) snapshot.
    clearSessionSnapshot();

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

    // Open with the DM narrating the opening scene (what's happening) before
    // the group acts. Dan: loading a scenario (esp. Random) must start the
    // story off — it must say what is happening, not a blank start.
    el.narrative.textContent = 'The DM is setting the opening scene...';
    session.openScene()
      .then((opening) => {
        el.narrative.textContent = opening;
        el.outcome.textContent = 'Opening scene set. What does the group do?';
      })
      .catch((err) => {
        el.narrative.textContent = 'The DM could not set the opening scene: ' + err.message;
      });
  } catch (err) {
    el.outcome.textContent = 'Could not start: ' + err.message;
  }
}

// ---------------------------------------------------------------------------
// MODE PICKER + IT / BACKDOORS & BREACHES FLOW (Dan, 2026-10-08)
// ---------------------------------------------------------------------------

/** Which version is selected on the scenario screen: 'elite' (default) or 'it'. */
function currentMode() {
  if (el.modeSelect) return el.modeSelect.value || 'elite';
  const checked = document.querySelector('input[name="modePick"]:checked');
  return checked ? checked.value : 'elite';
}

/** Toggle the setup panels when the version dropdown changes. */
function syncModeUi() {
  const it = currentMode() === 'it';
  if (el.eliteSetup) el.eliteSetup.style.display = it ? 'none' : 'block';
  if (el.itSetup) el.itSetup.style.display = it ? 'block' : 'none';
  if (el.loadScenarioBtn) el.loadScenarioBtn.textContent = it ? 'Start IT exercise' : 'Load / Start';
}

function bindModePicker() {
  if (el.modeSelect) el.modeSelect.addEventListener('change', syncModeUi);
  syncModeUi();
  renderOrgVars();
}

// ---------------------------------------------------------------------------
// ORGANIZATION & PEOPLE — set once, reused across every scenario (Dan 2026-10-08)
// ---------------------------------------------------------------------------
// The cast keys scenarios share (org_name, ceo_name, ...) live in ONE place so
// a moderator types them once. Each scenario's own cast fields pre-fill from
// these values (and can still be overridden per scenario).
const ORG_VARS = [
  { key: 'org_name', label: 'Organization name', placeholder: 'e.g. Northgate Credit Union' },
  { key: 'ceo_name', label: 'President / CEO', placeholder: 'e.g. Dana Whitfield' },
  { key: 'cio_name', label: 'CIO / security lead', placeholder: 'e.g. Jeff Park' },
  { key: 'cfo_name', label: 'CFO', placeholder: 'optional' },
  { key: 'clo_name', label: 'Chief Lending Officer', placeholder: 'optional' },
  { key: 'cro_name', label: 'Chief Risk Officer', placeholder: 'optional' },
  { key: 'cpo_name', label: 'Chief People Officer (HR)', placeholder: 'optional' },
  { key: 'comms_lead', label: 'Comms / PR lead', placeholder: 'optional' },
  { key: 'board_chair', label: 'Board chair', placeholder: 'optional' },
  { key: 'manager_name', label: 'Named senior manager', placeholder: 'optional' },
  { key: 'ai_lead_name', label: 'AI engineering lead', placeholder: 'optional' },
];

function orgVarsStorageKey() { return 'tabletop.dm.orgvars.v1'; }

function loadOrgVars() {
  try { return JSON.parse(localStorage.getItem(orgVarsStorageKey()) || '{}') || {}; }
  catch { return {}; }
}

function saveOrgVars(vars) {
  try { localStorage.setItem(orgVarsStorageKey(), JSON.stringify(vars || {})); } catch {}
}

/** Render the shared Organization & People inputs (values persist globally). */
function renderOrgVars() {
  if (!el.orgVarFields) return;
  const vars = loadOrgVars();
  el.orgVarFields.innerHTML = '';
  for (const f of ORG_VARS) {
    const wrap = document.createElement('label');
    wrap.className = 'cast-field';
    wrap.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'orgvar_' + f.key;
    input.placeholder = f.placeholder || '';
    input.value = vars[f.key] || '';
    input.oninput = () => {
      const v = loadOrgVars();
      v[f.key] = input.value.trim();
      saveOrgVars(v);
      // Keep any already-rendered scenario cast fields in sync where they had
      // not been explicitly overridden for this scenario.
      syncCastFromOrgVars(f.key, input.value.trim());
      refreshIntroBrief();
    };
    wrap.appendChild(input);
    el.orgVarFields.appendChild(wrap);
  }
}

/** Push a shared value into the current scenario's cast field if untouched. */
function syncCastFromOrgVars(key, value) {
  // Update the visible select-screen cast inputs directly (they exist even
  // before a scenario object is loaded into state.scenario).
  const input = document.getElementById('cast_' + key);
  if (input && document.activeElement !== input) {
    input.value = value;
    if (state.cast) state.cast[key] = value;
  }
  const scenario = state.scenario;
  if (!scenario || !state.cast) return;
  const field = (scenario.cast || []).find((c) => c && c.key === key);
  if (!field) return;
  state.cast[key] = value;
  saveCast(scenario.scenario_id, state.cast);
}

/** Build a fresh IT session and enter the IT play phase. */
async function startItSession() {
  const settings = loadSettings();
  const provider = buildProvider(settings);
  if (!provider) {
    alert('No DM configured. Open Settings and choose an in-browser model or paste an API key.');
    return;
  }
  const rounds = Math.max(4, Math.min(20, Number(el.itRounds && el.itRounds.value) || 10));
  const orgVars = loadOrgVars();
  const session = new BnbSession(provider, {
    targetCompany: (el.itCompany && el.itCompany.value.trim()) || orgVars.org_name || '',
    maxRounds: rounds,
  });
  session.start();
  state.session = session;
  state.mode = 'it';
  state.readOnly = false;
  bindItFlow();
  renderItState();
  setPhase('it');
  if (el.itNarrative) el.itNarrative.textContent = 'The Incident Master is drawing the attack path and setting the scene...';
  if (el.itOutcome) el.itOutcome.textContent = 'Choose a procedure and roll, or leave the roll blank to auto-roll.';
  if (el.itLog) el.itLog.innerHTML = '';
  startItTimer();
}

function renderItState() {
  const s = state.session;
  if (!s || !s.attackPath) return;
  // Attack path: four stage rows, revealed cards named, hidden ones masked.
  if (el.itAttackPath) {
    el.itAttackPath.innerHTML = s.attackPath.map((c) => {
      const revealed = c.revealed;
      const cls = revealed ? 'itStage revealed' : 'itStage hidden';
      const body = revealed
        ? `<b>${escapeHtml(c.name)}</b><div class="small muted">${escapeHtml(c.symptom)}</div>`
        : '<i class="muted">— not yet uncovered —</i>';
      return `<div class="${cls}"><div class="itCat">${escapeHtml(c.category_name)}</div>${body}</div>`;
    }).join('');
  }
  // Procedure hand -> dropdown.
  if (el.itProcedure) {
    el.itProcedure.innerHTML = s.procedureHand
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${escapeHtml(p.skill)}</option>`)
      .join('');
  }
  // Target stage -> dropdown of still-hidden categories.
  if (el.itTarget) {
    const hidden = s.hiddenCategories();
    el.itTarget.innerHTML = '<option value="">(no specific stage)</option>'
      + hidden.map((h) => `<option value="${h.id}">${escapeHtml(h.name)} — ${escapeHtml(h.prompt)}</option>`).join('');
  }
  // Inject feed.
  if (el.itInjectFeed) {
    el.itInjectFeed.innerHTML = s.injectLog.length
      ? s.injectLog.slice().reverse().map((i) => `<div class="itInject"><b>Round ${i.round}:</b> ${escapeHtml(i.text)}</div>`).join('')
      : 'No injects yet.';
  }
  // Round line.
  if (el.itRoundLine) {
    el.itRoundLine.textContent = `Round ${s.round} of ${s.maxRounds} — ${s.uncontainedCount()} of 4 stages still hidden.`;
  }
}

function bindItFlow() {
  if (el.itRerollHand) {
    el.itRerollHand.onclick = () => { state.session.refillHand(); renderItState(); };
  }
  // AUTO-ROLL — one click: roll the d20 and run the selected procedure, no
  // dice needed (Dan, 2026-10-08). Mirrors the executive auto-roll button.
  if (el.itAutoRoll) {
    el.itAutoRoll.onclick = () => {
      if (state.readOnly) { if (el.itOutcome) el.itOutcome.textContent = 'This tab is read-only.'; return; }
      el.itRoll.value = String(Math.floor(Math.random() * 20) + 1);
      el.itSubmit.click();
    };
  }
  if (el.itSubmit) {
    el.itSubmit.onclick = async () => {
      if (state.readOnly) { if (el.itOutcome) el.itOutcome.textContent = 'This tab is read-only.'; return; }
      const s = state.session;
      if (!s) return;
      const procId = el.itProcedure ? el.itProcedure.value : null;
      const target = el.itTarget ? (el.itTarget.value || null) : null;
      const note = el.itNote ? el.itNote.value : '';
      let roll;
      const manual = el.itRoll && el.itRoll.value.trim();
      if (manual) {
        const n = Number(manual);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
          if (el.itOutcome) el.itOutcome.textContent = 'Roll must be a whole number 1–20 (or blank to auto-roll).';
          return;
        }
        roll = n;
      } else {
        roll = Math.floor(Math.random() * 20) + 1;
      }
      el.itSubmit.disabled = true;
      if (el.itOutcome) el.itOutcome.textContent = 'The Incident Master is resolving the round...';
      try {
        const res = await s.resolveRound(procId, roll, target, note);
        if (el.itNarrative) el.itNarrative.textContent = res.narrative;
        if (el.itOutcome) {
          let msg = `Round ${res.round} — roll ${res.roll} — ${res.success ? 'SUCCESS' : 'FAILURE'}`;
          if (res.revealed) msg += ` — uncovered: ${res.revealed.category_name}`;
          if (res.inject) msg += ` — INJECT: ${res.inject.text}`;
          el.itOutcome.textContent = msg;
        }
        if (el.itLog) {
          el.itLog.insertAdjacentHTML('afterbegin',
            `<div class="logItem"><b>Round ${res.round}</b> — roll ${res.roll} (${res.success ? 'success' : 'failure'})`
            + `${res.revealed ? ` — <b>uncovered ${escapeHtml(res.revealed.category_name)}: ${escapeHtml(res.revealed.name)}</b>` : ''}`
            + `${res.inject ? ` — <b>INJECT:</b> ${escapeHtml(res.inject.text)}` : ''}`
            + `<br>${escapeHtml(res.narrative)}</div>`);
        }
        renderItState();
        if (el.itNote) el.itNote.value = '';
        if (el.itRoll) el.itRoll.value = '';
        if (res.endCondition) { finishIt(res.endCondition); return; }
        s.refillHand();
        renderItState();
      } catch (err) {
        if (el.itOutcome) el.itOutcome.textContent = 'Incident Master error: ' + err.message;
      } finally {
        el.itSubmit.disabled = false;
      }
    };
  }
  if (el.itEnd) {
    el.itEnd.onclick = () => {
      if (!confirm('Conclude the IT exercise now?')) return;
      const s = state.session;
      const open = s.uncontainedCount();
      finishIt({
        type: 'manual', result: open === 0 ? 'success' : 'ended',
        ending: open === 0
          ? 'All attack-path stages were uncovered. The exercise concludes.'
          : `The group concluded with ${open} stage${open === 1 ? '' : 's'} still hidden.`,
        attack_path: s.attackPath.map((c) => ({ category: c.category_name, name: c.name, symptom: c.symptom, revealed: c.revealed })),
      });
    };
  }
}

let itTimerHandle = null;
function startItTimer() {
  if (itTimerHandle) clearInterval(itTimerHandle);
  const tick = () => {
    const s = state.session;
    if (!s || !el.itTimer) return;
    const secs = s.secondsLeft();
    if (secs == null) { el.itTimer.textContent = '—'; return; }
    el.itTimer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (secs <= 0) {
      clearInterval(itTimerHandle); itTimerHandle = null;
      finishIt({ type: 'timeout', result: 'ended', ending: 'Time ran out on the scheduled IT exercise.', attack_path: s.attackPath.map((c) => ({ category: c.category_name, name: c.name, revealed: c.revealed })) });
    }
  };
  tick();
  itTimerHandle = setInterval(tick, 1000);
}

function finishIt(endCondition) {
  if (itTimerHandle) { clearInterval(itTimerHandle); itTimerHandle = null; }
  const isWin = endCondition.result === 'success';
  const isLoss = endCondition.result === 'loss';
  const splash = $('splash');
  if (!splash) return;
  splash.style.display = 'flex';
  splash.classList.toggle('ended', !isWin && !isLoss);
  splash.classList.toggle('loss', isLoss);
  $('splashGlyph').textContent = isWin ? '🏆' : isLoss ? '⛔' : '🏁';
  $('splashTitle').textContent = isWin ? 'Victory' : isLoss ? 'Defeat' : 'Session ended';
  $('splashSub').textContent = 'IT / Incident Response — complete';
  $('splashTier').style.display = 'none';
  $('splashSummary').textContent = endCondition.ending || '';
  const statsEl = $('splashStats');
  if (statsEl) {
    statsEl.innerHTML = (endCondition.attack_path || []).map((c) =>
      `<div class="splashStat ${c.revealed === false ? 'red' : 'green'}"><div class="v">${c.revealed === false ? '✗' : '✓'}</div><div class="k">${escapeHtml(c.category)}</div></div>`).join('');
  }
  const cont = $('splashContinue');
  if (cont) cont.onclick = () => { splash.style.display = 'none'; setPhase('it'); };
  const nw = $('splashNew');
  if (nw) nw.onclick = () => { splash.style.display = 'none'; state.session = null; showScenarioSelect(); };
}

function bindRollFlow(scenario) {
  // Single Submit action: take the group's action text, roll the D20
  // internally, and let the DM adjudicate. This merges the old separate
  // 'D20' card + 'What does the group do?' card into one flow.
  el.submitBtn.onclick = async () => {
    if (state.readOnly) {
      el.outcome.textContent = 'This tab is read-only — another tab is playing this session.';
      return;
    }
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

  // AUTO-ROLL — one click: roll a d20 for the group and submit the current
  // action, no dice needed (Dan, 2026-10-08). Uses the same path as Submit so
  // manual-roll overrides and validation still apply.
  if (el.autoRollBtn) {
    el.autoRollBtn.onclick = () => {
      if (state.readOnly) {
        el.outcome.textContent = 'This tab is read-only — another tab is playing this session.';
        return;
      }
      if (!el.actionText.value.trim()) {
        el.outcome.textContent = 'Type what the group wants to do first, then auto-roll.';
        return;
      }
      el.manualRoll.value = String(Math.floor(Math.random() * 20) + 1);
      el.submitBtn.click();
    };
  }

  // Ctrl/Cmd+Enter in the textarea also submits the action.
  el.actionText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.submitBtn.click();
    }
  });

  // ASK THE DM — out-of-band clarification. Does NOT burn a turn, roll a die,
  // or change any state (Dan, 2026-10-08). The DM answers as the moderator.
  if (el.askDMBtn) {
    el.askDMBtn.onclick = async () => {
      if (state.readOnly) {
        if (el.askDMStatus) el.askDMStatus.textContent = 'This tab is read-only.';
        return;
      }
      const session = state.session;
      if (!session) return;
      const q = el.askDMText.value.trim();
      if (!q) { if (el.askDMStatus) el.askDMStatus.textContent = 'Type a question first.'; return; }
      el.askDMBtn.disabled = true;
      if (el.askDMStatus) el.askDMStatus.textContent = 'The DM is considering...';
      try {
        const { answer } = await session.askDM(q);
        appendAskAnswer(q, answer);
        el.askDMText.value = '';
        if (el.askDMStatus) el.askDMStatus.textContent = '';
        saveSessionSnapshot();
      } catch (err) {
        if (el.askDMStatus) el.askDMStatus.textContent = 'DM error: ' + err.message;
      } finally {
        el.askDMBtn.disabled = false;
      }
    };
    if (el.askDMText) {
      el.askDMText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.askDMBtn.click(); }
      });
    }
  }

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

  // Toggle the story arc between shown and fuzzed. Persisted for the tab so a
  // facilitator can hide it before handing the screen to the group.
  if (el.arcToggle) {
    el.arcToggle.onclick = () => {
      state.arcHidden = !state.arcHidden;
      try { sessionStorage.setItem('tabletop.dm.arcHidden.v1', state.arcHidden ? '1' : '0'); } catch {}
      renderObjective();
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
    const player = (el.playerName && el.playerName.value.trim()) || null;
    const result = await session.takeTurn(action, roll, player);

    el.narrative.textContent = result.narrative;
    if (result.event.fate) {
      el.outcome.textContent = `Roll ${roll} — FATE EVENT: ${result.event.fate}`;
      logLine(`Roll ${roll} fired a fate event: ${result.event.fate}`);
    } else {
      el.outcome.textContent = `Roll ${roll} resolved (Turn ${result.event.turn}).`;
    }

    logLine(
      `<b>Turn ${result.event.turn}</b>: <b>${escapeHtml(action)}</b> — <b>d20=${roll}</b><br>${escapeHtml(result.narrative)}`
    );

    renderState();
    saveSessionSnapshot();

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

/**
 * Render the OBJECTIVE panel: the story goal the group is playing toward.
 *
 * Dan's design (2026-10-05): the win is a STORY win, not a score gate. So the
 * panel deliberately shows the narrative objective + the arc of steps, NOT a
 * checklist of numeric thresholds. The metrics stay as ambient texture in the
 * State list; the "win" reads as "resolve the story", not "reach 60/55/80".
 */
function renderObjective() {
  if (!el.objectivePanel) return;
  const session = state.session;
  if (!session || !session.scenario) { el.objectivePanel.style.display = 'none'; if (el.arcToggle) el.arcToggle.style.display = 'none'; return; }
  const scenario = session.scenario;
  const goal = scenario.goal || {};
  const beats = session.beats || [];
  const idx = session.currentBeatIndex || 0;

  const desc = goal.description
    ? `<div class="objDesc">${escapeHtml(goal.description)}</div>`
    : '';

  // The arc: show the steps, marking the ones already handled as done and the
  // current step as active. This is the player-facing "win condition": work
  // through the arc LINEARLY to the end. Containing the threat is an
  // alternative resolution, not an extra requirement.
  //
  // Dan's ask (2026-10-06): the group may want to try the exercise cold, without
  // the arc spelled out. So the toggle below FUZZES the arc (steps blurred, the
  // active marker withheld) rather than deleting it: the objective stays visible,
  // the shape of the panel is unchanged, and nobody can accidentally read ahead.
  let arc = '';
  if (beats.length) {
    const fuzzed = !!state.arcHidden;
    const items = beats.map((b, i) => {
      // When fuzzed, do NOT reveal which step is active/done — every step reads
      // the same so the group can't infer their position from the highlight.
      const cls = fuzzed ? 'todo' : (i < idx ? 'done' : i === idx ? 'active' : 'todo');
      const mark = fuzzed ? '·' : (i < idx ? '✓' : i === idx ? '▸' : '·');
      const label = fuzzed
        ? `<span class="arcFuzz" aria-label="hidden step">${escapeHtml(fuzzText(b.name || b.id))}</span>`
        : escapeHtml(b.name || b.id);
      return `<li class="arcStep ${cls} ${fuzzed ? 'fuzzed' : ''}" aria-hidden="${fuzzed ? 'true' : 'false'}"><span class="arcMark">${mark}</span> ${label}</li>`;
    }).join('');
    arc =
      `<div class="objLabel">The story arc — reach the final step to win</div>` +
      `<ol class="arcList">${items}</ol>`;
  }

  const hint = state.arcHidden
    ? `<div class="objHint">Arc hidden — run the exercise cold and find your own way through. Reveal it any time with the button below.</div>`
    : `<div class="objHint">Win by working the arc to its end — the steps go in order, one after another. Containing the whole threat is an alternative way to close it out, but you do NOT need to contain everything: missing a stage just makes the ending read as costlier. The metrics are texture; they never gate the win.</div>`;

  // Collapse pressure banner: the situation is critical but the story is STILL
  // playable — make that explicit so nobody reads a red metric as "game over".
  const collapseBanner = (session.collapsed || (session.isCollapsed && session.isCollapsed()))
    ? `<div class="objCollapse">⚠️ The situation has turned critical. The story is still yours to resolve — push through the arc or contain the threat. A comeback here is the costliest, best kind of win.</div>`
    : '';

  el.objectivePanel.style.display = '';
  el.objectivePanel.classList.toggle('arcHidden', !!state.arcHidden);
  el.objectivePanel.innerHTML =
    `<div class="objTitle">Objective</div>` + desc + arc + collapseBanner + hint;

  syncArcToggle();
}

// Fuzz a beat label: keep the character count and word breaks so the layout is
// identical, but replace the letters (per-word, stable per string) with block
// characters. Deterministic so re-renders don't visually shimmer.
function fuzzText(s) {
  const str = String(s || '');
  return str.replace(/[^\s]/g, (ch, i) => FUZZ_CHARS[(str.charCodeAt(i) + ch.charCodeAt(0)) % FUZZ_CHARS.length]);
}
const FUZZ_CHARS = ['░', '▒', '▓', '█'];

// Show/hide the arc toggle and keep its label + aria state in sync.
function syncArcToggle() {
  if (!el.arcToggle) return;
  const hasBeats = !!(state.session && state.session.beats && state.session.beats.length);
  el.arcToggle.style.display = hasBeats ? '' : 'none';
  el.arcToggle.textContent = state.arcHidden ? 'Reveal story arc' : 'Hide story arc';
  el.arcToggle.setAttribute('aria-pressed', state.arcHidden ? 'true' : 'false');
}

function renderState() {
  const session = state.session;
  if (!session) return;
  // Collapse pressure: a stat inside the failure zone is flagged visually (red)
  // so the team sees the situation has turned critical — but the collapse is NOT
  // a game over (Dan's design, 2026-10-05). Even at 0 the story is still
  // playable to its resolution; the pressure only makes the win costlier.
  const dangerStats = {};
  for (const c of (session.scenario.end_conditions || [])) {
    if (c.type !== 'stat' || (c.result && c.result !== 'loss')) continue;
    // Loss conditions may be single-stat ({stat, operator, value}) or
    // multi-stat ({stats: [...]} — e.g. trust AND regulator both low).
    const constraints = Array.isArray(c.stats) && c.stats.length ? c.stats : [c];
    for (const z of constraints) {
      const v = session.state[z.stat];
      if (typeof v !== 'number') continue;
      const inZone = (z.operator === 'lte' && v <= z.value) || (z.operator === 'gte' && v >= z.value);
      if (inZone && !dangerStats[z.stat]) dangerStats[z.stat] = c;
    }
  }

  const s = session.state;
  const parts = [];

  // ---- Budget: money spent (a 0-100 balance is meaningless on its own).
  // Show the DM's spend estimate in dollars: this turn + running total. ----
  const spent = session.budgetSpend || 0;
  const lastSpent = session.lastBudgetSpend || 0;
  parts.push(
    `<div class="stateItem budgetCard">` +
      `<div class="budgetLine"><b>Budget spent</b></div>` +
      `<div class="budgetSpend">` +
        (lastSpent > 0 ? `This turn: <b>$${lastSpent}</b> · ` : `This turn: <b>$0</b> · `) +
        `Total: <b>$${spent}</b>` +
      `</div>` +
    `</div>`
  );

  // ---- Traffic-light metrics (higher = better): a colored dot + label only.
  // No numeric score and no 'Green/Yellow/Red' word — the light speaks. ----
  const lightStats = ['public_trust', 'regulator_confidence', 'containment', 'eradication', 'recovery'];
  for (const k of lightStats) {
    const v = s[k];
    if (typeof v !== 'number') continue;
    const light = dangerStats[k] ? 'red' : trafficLight(v);
    parts.push(
      `<div class="stateItem stateLight">` +
        `<span class="lightDot ${light}"></span>` +
        `<b>${humanize(k)}</b>` +
      `</div>`
    );
  }

  // ---- Anything else the scenario tracks that we don't have a widget for:
  // show as a plain number (keeps custom metrics visible). ----
  const rendered = new Set(['budget', ...lightStats, 'security_posture']);
  const extras = Object.keys(s).filter((k) => !rendered.has(k) && typeof s[k] === 'number');
  for (const k of extras) {
    const v = s[k];
    const danger = dangerStats[k] ? ' danger' : '';
    const note = dangerStats[k]
      ? ` <span class="dangerNote" title="${escapeHtml(dangerStats[k].ending || 'The situation has turned critical')}">⚠️ critical</span>` : '';
    parts.push(`<div class="stateItem${danger}"><b>${humanize(k)}</b>: ${v}${note}</div>`);
  }

  el.stateList.innerHTML = parts.join('');

  renderObjective();
  renderStoryRecap();

  const flags = session.history.filter((e) => e.fate).map((e) => e.fate);
  el.flags.textContent = flags.length ? 'Fate events: ' + flags.join(' | ') : 'No fate events yet.';
}

/**
 * "Story as we know it" — a player-facing recap kept in step with the engine.
 *
 * Dan's ask (2026-10-08): the moderator is tracking the story internally, but
 * the players should see it too. This renders, in plain language, only what the
 * table has actually established:
 *   - the current step of the arc (and which steps are already done),
 *   - the attack-chain stages the group has REVEALED (hidden stages stay masked),
 *   - the latest turn's narrative as a one-line "where we are now",
 *   - any events/fate twists that have fired (the visible turns in the road).
 * Nothing here is invented and no hidden information is leaked: it is a mirror
 * of engine state, not a summary the model produced.
 */
function renderStoryRecap() {
  if (!el.storyRecap) return;
  const session = state.session;
  if (!session || !session.scenario) { el.storyRecap.innerHTML = '<p class="small muted">No session loaded.</p>'; return; }
  const scenario = session.scenario;
  const beats = session.beats || [];
  const idx = session.currentBeatIndex || 0;
  const out = [];

  // 1. Where are we in the story?
  if (beats.length) {
    const cur = beats[idx] || {};
    const done = beats.slice(0, idx).map((b) => escapeHtml(b.name || b.id));
    const remaining = beats.slice(idx + 1).map((b) => escapeHtml(b.name || b.id));
    out.push(
      `<div class="recapBlock">` +
        `<div class="recapLabel">Right now</div>` +
        `<div class="recapNow">${escapeHtml(cur.name || cur.id || 'In progress')}</div>` +
        (cur.narrative ? `<div class="small muted">${escapeHtml(cur.narrative)}</div>` : '') +
      `</div>`
    );
    if (done.length) {
      out.push(`<div class="recapBlock"><div class="recapLabel">Behind you</div><ul class="recapList done">${done.map((d) => `<li>${d}</li>`).join('')}</ul></div>`);
    }
    if (remaining.length) {
      // Ahead is shown by NAME (the arc is already visible in the Objective
      // panel) but marked as not-yet-done so nobody mistakes it for fact.
      out.push(`<div class="recapBlock"><div class="recapLabel">Still ahead</div><ul class="recapList todo">${remaining.map((d) => `<li>${d}</li>`).join('')}</ul></div>`);
    }
  }

  // 2. What do we know about the threat? Only REVEALED chain stages are named.
  const chain = session.attackChain || [];
  if (chain.length) {
    const known = chain.filter((c) => c.revealed);
    const hiddenCount = chain.length - known.length;
    let chainHtml;
    if (known.length) {
      chainHtml = `<ul class="recapList known">${known.map((c) =>
        `<li>${escapeHtml(c.name)}${c.contained ? ' <span class="tagContained">contained</span>' : ''}` +
        (c.symptom ? `<div class="small muted">${escapeHtml(c.symptom)}</div>` : '') + `</li>`).join('')}</ul>`;
    } else {
      chainHtml = '<div class="small muted">The threat is still unidentified.</div>';
    }
    if (hiddenCount > 0) {
      chainHtml += `<div class="small muted" style="margin-top:4px">${hiddenCount} stage${hiddenCount === 1 ? '' : 's'} of the attack path still unknown.</div>`;
    }
    out.push(`<div class="recapBlock"><div class="recapLabel">The threat — what we know</div>${chainHtml}</div>`);
  }

  // 3. Where we are now: the most recent narrated turn (the DM's own words).
  const turns = (session.history || []).filter((e) => e && e.turn > 0 && e.narrative);
  const last = turns[turns.length - 1];
  if (last) {
    out.push(
      `<div class="recapBlock"><div class="recapLabel">Where we left off</div>` +
        `<div class="small">${escapeHtml(last.narrative)}</div>` +
      `</div>`
    );
  }

  // 4. Turns in the road: fate events and fired conditional events, in order.
  const twists = [];
  for (const e of (session.history || [])) {
    if (!e || e.turn <= 0) continue;
    if (e.fate) twists.push(`Turn ${e.turn}: ${e.fate}`);
    for (const evId of (e.events || [])) {
      const def = (scenario.events || []).find((x) => x.id === evId);
      if (def && def.text) twists.push(`Turn ${e.turn}: ${def.text}`);
    }
  }
  if (twists.length) {
    out.push(`<div class="recapBlock"><div class="recapLabel">Twists so far</div><ul class="recapList twists">${twists.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`);
  }

  el.storyRecap.innerHTML = out.join('') || '<div class="small muted">The story has not started yet.</div>';
}

/** Traffic-light for a higher-is-better metric on 0-100. */
function trafficLight(v) {
  if (v >= 60) return 'green';
  if (v >= 30) return 'yellow';
  return 'red';
}

function renderTimer() {
  const session = state.session;
  if (!session) return;
  const left = session.secondsLeft();
  // Soft pace guide, never a hard cutoff: the session ends on win, narrative
  // loss, or the group choosing to wrap up — NOT when the timer hits zero.
  // Dan: "the scenarios should be completable in 60 minutes, not forced."
  if (left > 0) {
    el.timer.textContent = formatTime(left);
  } else {
    el.timer.textContent = '—';
    if (!window.__timeUpNoticed) {
      window.__timeUpNoticed = true;
      el.narrative.textContent += '\n\n⏱️ Recommended wrap-up: 60 minutes have passed. If your team isn\u2019t done, that\u2019s fine — keep going until you resolve the story, or click \u201cEnd exercise\u201d to close it out now.';
    }
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
  // Session is over: drop the resumable snapshot so a refresh doesn't offer to
  // resume a finished game.
  clearSessionSnapshot();

  // Dan (2026-10-07): end with a splash. A story WIN gets a proper victory
  // splash; every other terminal outcome (ended / loss / timeout) gets a
  // quieter "session ended" splash so no run just dumps the group onto a
  // utilitarian report page. The full report is one click away.
  showSplash(endCondition, report);
}

/**
 * Show the terminal splash overlay. Victory (success) gets the celebratory
 * treatment; ended/loss/timeout get the muted "session ended" treatment.
 * Dan's design (2026-10-05): a stat collapse is NOT a loss, so the only
 * non-success terminal states are the group ending it, or the clock running out.
 */
function showSplash(endCondition, report) {
  const splash = $('splash');
  if (!splash) return;
  const result = (endCondition && endCondition.result) || 'ended';
  const isWin = result === 'success';
  const isLoss = result === 'loss';

  splash.classList.toggle('ended', !isWin && !isLoss);
  splash.classList.toggle('loss', isLoss);

  $('splashGlyph').textContent = isWin ? '🏆' : isLoss ? '⛔' : '🏁';
  $('splashTitle').textContent = isWin ? 'Victory' : isLoss ? 'Defeat' : 'Session ended';

  const scenarioName = (state.scenario && state.scenario.title) || report.scenario || '';
  $('splashSub').textContent = scenarioName ? `${scenarioName} — complete` : 'Complete';

  // Win quality tier (decisive / solid / costly) or the reason it ended.
  const tier = (endCondition && endCondition.win_quality) || null;
  const tierEl = $('splashTier');
  if (isWin && tier) {
    tierEl.textContent = tier === 'decisive' ? 'Decisive win'
      : tier === 'solid' ? 'Solid win' : 'Hard-won win';
    tierEl.style.display = '';
  } else if (!isWin) {
    const reason = (endCondition && endCondition.type) === 'timeout' ? 'Time expired'
      : isLoss ? 'The collapse' : 'Concluded by the group';
    tierEl.textContent = reason;
    tierEl.style.display = '';
  } else {
    tierEl.style.display = 'none';
  }

  $('splashSummary').textContent = report.win_summary || report.ending || '';

  // Final state at a glance: show the metric values with traffic-light colour.
  const statsEl = $('splashStats');
  statsEl.innerHTML = '';
  const labels = { public_trust: 'Trust', regulator_confidence: 'Regulator', containment: 'Containment', eradication: 'Eradication', recovery: 'Recovery', security_posture: 'Security' };
  const finalState = report.final_state || {};
  for (const [k, v] of Object.entries(finalState)) {
    if (typeof v !== 'number') continue;
    const d = document.createElement('div');
    d.className = 'splashStat ' + trafficLight(v);
    d.innerHTML = `<div class="v">${v}</div><div class="k">${escapeHtml(labels[k] || k)}</div>`;
    statsEl.appendChild(d);
  }

  $('splashContinue').onclick = () => { splash.style.display = 'none'; };
  $('splashNew').onclick = () => { splash.style.display = 'none'; showScenarioSelect(); };

  splash.style.display = 'flex';
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
  add('Scenario', report.scenario && !report.report_title.includes(report.scenario) ? report.scenario : (report.scenario_id || undefined));
  add('Result', report.result === 'success'
    ? (report.success_kind === 'story' ? 'Success — the story resolves' : 'Success — goal achieved')
    : report.result === 'loss' ? 'Loss — the collapse' : report.result || undefined);
  if (report.win_summary) add('How it reads', report.win_summary);
  if (Array.isArray(report.open_stages) && report.open_stages.length)
    add('Left open', `This resolution went through with ${report.open_stages.length} attack-chain stage(s) never contained: ${report.open_stages.join(', ')}.`);
  if (report.collapsed) add('Critical state', 'The situation collapsed into crisis during the run (not a loss — the story was still resolved).');
  add('Ending', report.ending || 'No end condition recorded');
  add('Turns', report.turns);
  add('Duration (min)', report.duration_minutes ?? '—');
  add('Generated', report.generated_at ? new Date(report.generated_at).toLocaleString() : undefined);
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

  // Resource usage: token accounting + per-player attribution (matches the
  // exported report's Part 3).
  if (report.token_usage) {
    const t = report.token_usage;
    add('Resource usage',
      `Model calls: ${t.model_calls}\n` +
      `Prompt tokens: ${t.prompt_tokens}\n` +
      `Completion tokens: ${t.completion_tokens}\n` +
      `Total tokens: ${t.total_tokens}${t.estimated ? ' (partly estimated)' : ''}` +
      (t.model ? `\nModel: ${t.model}` : '') +
      (t.cost_usd !== undefined ? `\nIndicative cost: $${Number(t.cost_usd).toFixed(4)}` : ''));
  }
  if (report.actions_by_player && Object.keys(report.actions_by_player).length) {
    add('Actions by player', Object.entries(report.actions_by_player).map(([p, n]) => `${p}: ${n}`).join(', '));
  }

  report.log.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'stateItem';
    const who = e.player ? ` · ${escapeHtml(e.player)}` : '';
    const isOpening = e.turn === 0 || e.action === '(opening scene)';
    const title = isOpening ? 'Opening scene' : `Turn ${i + 1}`;
    div.innerHTML =
      `<b>${title}</b> (d20=${e.roll === null || e.roll === undefined ? '—' : e.roll}${who})<br>` +
      (!isOpening && e.action ? `<b>${escapeHtml(e.action)}</b><br>` : '') +
      `${escapeHtml(e.narrative)}` +
      (e.fate ? `<br><i>Fate: ${escapeHtml(e.fate)}</i>` : '') +
      `<br><small>State after: ${escapeHtml(Object.entries(e.state || {}).map(([k, v]) => `${humanize(k)} ${v}`).join(' · '))}</small>`;
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

  // Export a self-contained HTML report (the rendered DOM as it appears on
  // screen). Works on static hosting (no server needed) so a facilitator can
  // save or email a printable report.
  const exportHtmlBtn = $('exportReportHtml');
  if (exportHtmlBtn) {
    exportHtmlBtn.onclick = () => {
      const scen = report.scenario && !report.report_title.includes(report.scenario) ? ` — ${report.scenario}` : '';
      const title = `${report.report_title}${scen}`;
      const body = el.reportBody ? el.reportBody.innerHTML : '';
      const html =
        '<!doctype html><html><head><meta charset="utf-8">' +
        `<title>${escapeHtml(title)}</title>` +
        '<style>body{font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a;line-height:1.5;margin:0;padding:24px;background:#f5f6f8}' +
        '.stateItem{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:10px 0}' +
        'small{color:#666}</style></head><body>' +
        `<h1 style="color:#1f3a5f">${escapeHtml(title)}</h1>` +
        body +
        `<p style="color:#888;font-size:12px;margin-top:24px">Generated ${escapeHtml(new Date().toLocaleString())}</p>` +
        '</body></html>';
      const blob = new Blob([html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tabletop-report-${report.scenario_id || 'run'}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }
}

function logLine(html) {
  const log = $('log');
  if (!log) return;
  log.insertAdjacentHTML('afterbegin', `<div class="logItem">${html}</div>`);
}

// Render an out-of-band DM answer into the Ask panel (NOT the run log — this is
// a clarification, not a played turn) and keep the most recent at the bottom so
// the conversation reads top-to-bottom.
function appendAskAnswer(question, answer) {
  const host = el.askDMAnswers || $('askDMAnswers');
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'askDMItem';
  div.innerHTML = `<div class="askDMQ">You: ${escapeHtml(question)}</div>`
    + `<div class="askDMA">DM: ${escapeHtml(answer)}</div>`;
  host.appendChild(div);
  host.scrollTop = host.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// Boot.
document.addEventListener('DOMContentLoaded', init);
