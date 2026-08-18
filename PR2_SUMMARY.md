# PR2 Summary — Scenario change + remote Ollama preset

## What changed

### Feature 1 — Load and change the scenario (was: selectable only at page load)

Previously the scenario dropdown (`#scenarioSelect`) was populated once by
`populateScenarios()` at boot and never revisited; `#newSession` only called
`setPhase('intro')`, so there was no way to swap scenarios after starting.

Changes (`app/js/main.js`, `index.html`):

- Added a **"Change scenario"** button to the intro screen's Setup card
  (`#changeScenario`) that returns to the scenario-select phase.
- Wired **"New session / scenario"** (`#newSession`, report screen) to the same
  path, so the report screen now goes back to scenario selection instead of
  re-entering the same scenario's intro.
- Both controls call a new `showScenarioSelect()`, which:
  - stops any in-progress session timer,
  - **re-loads `scenarios/registry.json`** so new/updated scenarios appear,
  - re-populates the `#scenarioSelect` dropdown for N scenarios,
  - pre-selects the currently loaded scenario (if still present),
  - shows the `#phase-select` screen.
- Extracted dropdown rendering into `renderScenarioOptions()` and kept the
  original boot behaviour (auto-select the first scenario's intro) intact.

Selecting a scenario still loads it, shows its intro, and enables
**Start the session** — unchanged.

### Feature 2 — "Ollama (remote)" preset (direct browser path)

Previously the OpenAI-compatible presets were OpenAI / DeepSeek / Anthropic /
Server-local; there was no preset for a remote Ollama reachable over the
network.

Changes (`app/js/providers/registry.js`, `app/js/settings.js`, `index.html`):

- Added a **"Ollama (remote)"** preset (`id: 'ollama-remote'`) with default
  model `gemma3:4b` and an editable Base URL (`http://<host>:11434/v1`, defaults
  to `http://localhost:11434/v1`). It has **no `viaServer` flag**, so it routes
  through `OpenAICompatibleProvider` (direct from the browser to the remote
  Ollama's OpenAI-compatible `/v1/chat/completions`), with an optional API key.
- The **"Server (local Ollama)"** preset keeps `viaServer: true` and still routes
  through the `ServerProxyProvider` (`/api/dm`) — the two paths remain distinct.
- The preset appears in the settings dropdown (`#preset`), and selecting it
  pre-fills Base URL + model via the existing preset handler.
- Added a stored `preset` id to settings (with a `''`/Custom default) and a
  `findPreset()` helper so `describeProvider()` labels "Ollama (remote)" vs
  "Server (local Ollama)" correctly even though both share a default base URL.
  Older saved settings (no `preset` field) fall back to base-URL matching.

## Tests

- Added `tests/presets.test.js` (wired into `npm test`): verifies preset list,
  uniqueness, `ollama-remote` vs `server-local` routing (`OpenAICompatibleProvider`
  vs `ServerProxyProvider`), and correct labels/details.
- Added `tests/verify-features.mjs`: deterministic headless-browser check that
  "Change scenario" returns to the re-populated select screen, re-selecting
  reloads the intro, and the settings UI offers/uses the remote Ollama preset.

`npm test` passes (all suites green). `node --check` passes on every edited
`.js` file. The pre-existing `tests/e2e-browser.mjs` flake (fate-11 loop clicks
`#useManual` when it is briefly not clickable) was reproduced on the base
commit and is unrelated to these changes.
