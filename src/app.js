/**
 * Executive Tabletop D20 - Application Logic
 *
 * Thin UI layer that binds the playable app (Play / Editor / Help tabs) to
 * the Engine. It is kept deliberately separation-of-concerns: no scenario
 * logic lives here, only DOM wiring and scenario file loading.
 *
 * Scenarios are stored as standalone JSON files under /scenarios and listed
 * in /scenarios/registry.json. On startup the app fetches the registry and
 * loads the first scenario. This keeps scenario data fully decoupled from
 * the application code.
 */
(function () {
  'use strict';

  /** Path to the scenario registry (list of { id, title, path }). */
  const REGISTRY_PATH = 'scenarios/registry.json';

  const $ = (id) => document.getElementById(id);

  let scenarios = [];   // available scenario descriptors from the registry
  let scenario = null;  // the active scenario object
  let run = null;       // the active run
  let selectedOptionId = null;

  /** Turn `member_confidence` into "Member Confidence" for display. */
  function humanize(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  /** The decision point the run is currently on (may be null = complete). */
  function currentPoint() {
    return scenario.decision_points.find((d) => d.id === run.currentDecisionId);
  }

  /** Prepend a line to the run log. */
  function logLine(html) {
    $('log').insertAdjacentHTML(
      'afterbegin',
      `<div class="logItem"><small>${new Date().toLocaleTimeString()}</small><br>${html}</div>`
    );
  }

  /** Render the full play view from the current run. */
  function render() {
    const point = currentPoint();

    $('title').textContent = scenario.title;
    $('summary').textContent = scenario.summary;
    $('media').src = scenario.media || '';
    $('media').style.display = scenario.media ? '' : 'none';

    $('state').innerHTML = Object.entries(run.state)
      .map(([key, value]) => `<div class="stateItem"><b>${humanize(key)}</b>: ${value}</div>`)
      .join('');

    $('flags').textContent = run.flags.length
      ? 'Flags: ' + run.flags.join(', ')
      : 'No flags yet';

    $('narrative').textContent = run.narrative;

    if (!point) {
      $('prompt').textContent = 'Exercise complete. Capture hotwash notes.';
      $('options').innerHTML = '';
      $('roll').disabled = true;
      $('useManual').disabled = true;
      return;
    }

    $('prompt').textContent = point.prompt_seed;

    $('options').innerHTML = point.options
      .map((option) => {
        const modText = option.roll_modifier >= 0 ? '+' : '';
        const stateDeltas = Object.entries(option.modifiers || {})
          .map(([key, value]) => `${humanize(key)} ${value > 0 ? '+' : ''}${value}`)
          .join('; ');
        return (
          `<div class="option" data-id="${option.id}">` +
          `<b>${option.label}</b><br>` +
          `<small>Roll ${modText}${option.roll_modifier || 0}; ${stateDeltas}</small>` +
          `</div>`
        );
      })
      .join('');

    $('roll').disabled = true;
    $('useManual').disabled = true;
    selectedOptionId = null;

    // Wire up option selection.
    document.querySelectorAll('.option').forEach((el) => {
      el.onclick = () => {
        document.querySelectorAll('.option').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        selectedOptionId = el.dataset.id;
        $('roll').disabled = false;
        $('useManual').disabled = false;
        $('outcome').textContent = 'Selected. Roll when ready.';
      };
    });
  }

  /** Build the narrative line that follows an event. */
  function narrate(event, nextDecision) {
    const tail = nextDecision
      ? 'Next pressure point: ' + nextDecision.prompt_seed
      : 'Move to hotwash.';
    return `${event.tierLabel}: ${event.outcome_text} ${tail}`;
  }

  /** Roll the D20 (digital or manual value) for the selected option. */
  function doRoll(rawRoll) {
    if (!selectedOptionId) return;

    const resolved = Engine.resolve(run, scenario, selectedOptionId, rawRoll);
    run = resolved.run;
    run.narrative = narrate(resolved.event, resolved.nextDecision);

    $('die').textContent = resolved.event.rawRoll;
    $('outcome').textContent =
      `${resolved.event.tierLabel}\n` +
      `Raw ${resolved.event.rawRoll} ${resolved.event.modifier >= 0 ? '+' : ''}${resolved.event.modifier} = ${resolved.event.effectiveRoll}\n` +
      `${resolved.event.outcome_text}`;

    logLine(
      `Turn ${resolved.event.turn}: ${resolved.event.option_label} | ${resolved.event.tierLabel}`
    );
    render();
  }

  /** Start a fresh run for the given scenario. */
  function startRun(scenarioObject) {
    scenario = scenarioObject;
    run = Engine.create(scenario);
    populateScenarioSelector();
    render();
  }

  /** Fill the scenario <select> from the loaded registry. */
  function populateScenarioSelector() {
    const select = $('scenarioSelect');
    select.innerHTML = scenarios
      .map((s) => `<option value="${s.path}">${s.title}</option>`)
      .join('');
    select.value = scenario.media ? '' : ''; // reset handled by caller
    select.value = scenarios.find((s) => s.title === scenario.title)?.path || '';
  }

  /** Load the registry, then load the first scenario by default. */
  function bootstrap() {
    fetch(REGISTRY_PATH)
      .then((r) => r.json())
      .then((registry) => {
        scenarios = registry;
        if (registry.length === 0) {
          throw new Error('Scenario registry is empty.');
        }
        return loadScenario(registry[0].path);
      })
      .then((firstScenario) => startRun(firstScenario))
      .catch((err) => {
        $('outcome').textContent = 'Failed to load scenarios: ' + err.message;
      });

    // Scenario selector -> load the chosen scenario.
    $('scenarioSelect').onchange = (e) => {
      loadScenario(e.target.value).then((s) => startRun(s));
    };
  }

  /** Fetch and validate a scenario JSON file, returning the scenario object. */
  function loadScenario(path) {
    return fetch(path)
      .then((r) => r.json())
      .then((data) => {
        const check = Engine.validate(data);
        if (!check.valid) {
          throw new Error(`${path}: ${check.errors.join('; ')}`);
        }
        return data;
      });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  $('roll').onclick = () => doRoll();
  $('useManual').onclick = () => {
    const value = parseInt($('manual').value, 10);
    if (value >= 1 && value <= 20) doRoll(value);
    else $('outcome').textContent = 'Manual roll must be 1-20.';
  };

  $('export').onclick = () => {
    const payload = {
      scenario: scenario.title,
      state: run.state,
      flags: run.flags,
      notes: $('notes').value,
      log: run.log
    };
    download(JSON.stringify(payload, null, 2), 'tabletop-run-log.json');
  };

  // --- Scenario editor ---

  function readEditorJson() {
    try {
      return JSON.parse($('editorJson').value);
    } catch (err) {
      $('validation').textContent = 'INVALID JSON\n' + err.message;
      return null;
    }
  }

  $('loadCurrent').onclick = () => {
    $('editorJson').value = JSON.stringify(scenario, null, 2);
  };

  $('loadTemplate').onclick = () => {
    loadScenario('scenarios/templates/blank-scenario-template.json').then((tpl) => {
      $('editorJson').value = JSON.stringify(tpl, null, 2);
    });
  };

  $('validate').onclick = () => {
    const data = readEditorJson();
    if (!data) return;
    const check = Engine.validate(data);
    $('validation').textContent =
      (check.valid ? 'VALID' : 'INVALID') +
      '\nErrors:\n' +
      (check.errors.join('\n') || 'None') +
      '\nWarnings:\n' +
      (check.warnings.join('\n') || 'None');
  };

  $('apply').onclick = () => {
    const data = readEditorJson();
    if (!data) return;
    const check = Engine.validate(data);
    if (!check.valid) {
      $('validation').textContent = 'Cannot apply: fix errors first.\n' + check.errors.join('\n');
      return;
    }
    startRun(data);
    switchTab('play');
  };

  $('downloadScenario').onclick = () => {
    const data = readEditorJson();
    if (!data) return;
    download(JSON.stringify(data, null, 2), (data.scenario_id || 'scenario') + '.json');
  };

  // --- Tabs ---

  function switchTab(tabId) {
    document.querySelectorAll('nav button, .tab').forEach((el) => el.classList.remove('active'));
    document.querySelector(`nav button[data-tab="${tabId}"]`).classList.add('active');
    $(tabId).classList.add('active');
  }

  document.querySelectorAll('nav button').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  // --- Help text (loaded from the docs markdown file) ---

  fetch('docs/HOW_TO_BUILD_A_SCENARIO.md')
    .then((r) => r.text())
    .then((text) => {
      const escaped = text.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      $('helpText').innerHTML = '<pre>' + escaped + '</pre>';
    })
    .catch(() => {
      $('helpText').innerHTML = '<p>Open docs/HOW_TO_BUILD_A_SCENARIO.md in the bundle.</p>';
    });

  // --- Utilities ---

  function download(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  bootstrap();
})();
