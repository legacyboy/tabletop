# Code Review: PR #2 — Scenario Change + Remote Ollama Preset

**Reviewer:** GLM 5.2 (automated)
**Date:** 2026-08-18
**Branch:** `feature/scenario-change-and-remote-ollama` → `main`
**Repo:** github.com/legacyboy/tabletop

## Verdict: APPROVE

PR #2 is clean, well-structured, and correctly implements both requested features. All tests pass (28 + 6 + 7 + 16 = 57 assertions across 4 suites), the headless browser verification (9 assertions) passes with zero page errors, and `node --check` passes on every edited file. No regressions detected.

---

## Feature 1 — Scenario Change

### What it does
Adds a "Change scenario" button (`#changeScenario`) to the intro screen and rewires "New session / scenario" (`#newSession`) on the report screen to both call `showScenarioSelect()`, which:
1. Stops any in-progress session timer (`state.session.stopTimer()`)
2. Nulls out `state.session`
3. Re-loads `scenarios/registry.json` via `loadRegistry()`
4. Re-populates the `#scenarioSelect` dropdown for N scenarios
5. Pre-selects the currently loaded scenario (matched by `registry.id === scenario.scenario_id`)
6. Switches to `#phase-select`

### Verification
- **Timer stop:** `stopTimer()` is idempotent (guards on `this.timerHandle`). When called from the report phase, `finish()` already stopped it; the second call is a no-op. No double-clear risk. ✓
- **Registry reload:** `loadRegistry()` is async and awaited. `renderScenarioOptions()` reads from `state.registry` (not a local), so the dropdown reflects the fresh fetch. ✓
- **Pre-select logic:** `state.registry.findIndex((s) => s.id === state.scenario.scenario_id)` — registry entries have `id`, scenario JSON has `scenario_id`. Both are `"bramble_badger_deepfake"` in the current registry. Correct field match. ✓
- **State cleanup:** `selectScenario()` (called when user picks from dropdown) resets `companyNote` text and `state.companyInfo` to null. No company info leaks across scenario changes. ✓
- **Old session state:** `state.session` is nulled, `state.scenario` persists (used only for pre-select highlight). When a new scenario is selected, `selectScenario()` replaces `state.scenario` entirely. No stale state. ✓
- **`newSession` wiring moved:** Previously wired inside `renderReport()` on every render; now wired once in `init()`. Cleaner, no functional change. The old `setPhase('intro')` is replaced by `showScenarioSelect()` — intended behavior change. ✓
- **`changeScenario` guard:** `if (changeScenario)` is defensive (button always exists in HTML). Harmless. ✓

### Refactor quality
`renderScenarioOptions()` extracted from `populateScenarios()` is a clean DRY extraction. Both `populateScenarios()` (boot) and `showScenarioSelect()` (change) use it. No duplication. ✓

## Feature 2 — "Ollama (remote)" Preset

### What it does
Adds a 5th preset (`id: 'ollama-remote'`) to `PRESETS` with `baseUrl: 'http://localhost:11434/v1'`, `model: 'gemma3:4b'`, no `viaServer` flag. Routes through `OpenAICompatibleProvider` (direct browser → remote Ollama `/v1/chat/completions`). The base URL is editable so the user points it at their remote host.

### Routing verification
- `ollama-remote` preset → `provider: 'openai-compatible'` + no `viaServer` → `buildProvider()` returns `OpenAICompatibleProvider`. ✓
- `server-local` preset → `provider: 'server-proxy'` → `buildProvider()` returns `ServerProxyProvider`. ✓
- The two presets share a default `baseUrl` (`http://localhost:11434/v1`) but are disambiguated by the stored `preset` id field (checked first in `findPreset()`), falling back to base-URL matching for legacy settings. ✓

### Labeling verification
- `describeProvider({ provider: 'openai-compatible', preset: 'ollama-remote', ... })` → `findPreset()` matches by id → label `"Ollama (remote)"`. Detail does NOT include "(via server)". ✓
- `describeProvider({ provider: 'server-proxy', preset: 'server-local', ... })` → label `"Server (local Ollama)"`. Detail includes "(via server)". ✓
- Tests explicitly assert both labels. ✓

### Settings persistence
- `defaultSettings()` now includes `preset: ''`. `loadSettings()` merges defaults with saved settings (`{ ...defaultSettings(), ...JSON.parse(raw) }`), so older saved settings without `preset` get `''` from defaults. `findPreset()` falls through to base-URL matching. Backward compatible. ✓
- `el.preset.onchange` now sets `current.preset = el.preset.value` before copying `baseUrl`/`model`. The preset id is persisted in the next `saveSettings()` call. ✓
- `renderDynamic()` sets `el.preset.value = current.preset || ''` to reflect the saved preset in the dropdown. ✓

### UI wiring
- `<option value="ollama-remote">Ollama (remote)</option>` added to `#preset` select in `index.html`. ✓
- The preset dropdown is shown for both `openai-compatible` and `server-proxy` providers (existing behavior, unchanged). ✓
- Selecting the preset pre-fills `baseUrl` and `model` via the existing `el.preset.onchange` handler. ✓
- Headless test confirms: preset visible for `openai-compatible`, includes `ollama-remote`, pre-fills `baseUrl='http://localhost:11434/v1'` and `model='gemma3:4b'`. ✓

### OpenAICompatibleProvider
No changes to `openai-compatible.js`. It already handles:
- Optional `apiKey` (only adds `Authorization` header if non-empty) — works for Ollama which doesn't require a key. ✓
- POST to `${baseUrl}/chat/completions` — Ollama's OpenAI-compatible endpoint. ✓
- Error surfacing for 404 (unknown model) and other non-OK responses. ✓
- `ping()` for the settings "Test connection" button. ✓

## Regression check

- **Existing providers (openai/deepseek/anthropic/server-local):** No changes to `openai-compatible.js`, `server-proxy.js`, or `webllm.js`. `registry.js` only adds a new preset and `findPreset()` — the old `describeSelection` path that used `PRESETS.find((p) => p.baseUrl === settings.baseUrl)` is replaced by `findPreset()` which is a superset (id-first, base-URL fallback). No regression. ✓
- **Settings save/load:** `saveSettings()` unchanged. `loadSettings()` unchanged. `defaultSettings()` gains `preset: ''` — additive, backward compatible. ✓
- **Server code:** No changes to `server/`. ✓
- **Test suite:** All pre-existing tests pass (dm-session: 28, dm-integration: 6, extract-json: 7, report: 5 assertions). New `presets.test.js` adds 16 assertions. ✓
- **Headless browser:** `verify-features.mjs` — 9/9 pass, 0 page errors. ✓

## Minor observations (non-blocking)

1. **Pre-existing: `server-local` preset + `openai-compatible` provider.** If a user selects provider "API key" then picks the "Server (local Ollama)" preset, `viaServer` is not copied from the preset into settings (only `baseUrl` and `model` are). So routing goes through `OpenAICompatibleProvider` (direct), but the label says "Server (local Ollama)". This is a pre-existing UX quirk, not introduced by PR #2. The intended path for server-local is `provider: 'server-proxy'`, which routes correctly.

2. **`findPreset()` fallback ambiguity.** If a user has old saved settings with `baseUrl: 'http://localhost:11434/v1'` and no `preset` id, `findPreset()` falls back to base-URL matching and returns the first match (`server-local`, which appears before `ollama-remote` in `PRESETS`). This could mislabel a remote-Ollama user's old settings as "Server (local Ollama)". However, this only affects the display label, not routing (routing is determined by `provider` and `viaServer` fields). The user can fix it by re-selecting the preset from the dropdown, which stores the `preset` id. Acceptable for a migration path.

3. **`PR2_SUMMARY.md`** is accurate and matches the code. No discrepancies found. ✓

## Test results

```
npm test:
  dm-session.test.js:    28 passed, 0 failed
  dm-integration.test.js: 6 passed, 0 failed
  extract-json.test.js:   7 passed, 0 failed
  report.test.js:         5 checks (implicit pass)
  presets.test.js:       16 passed, 0 failed
  Total:                 57 passed, 0 failed

verify-features.mjs:     9 passed, 0 failed, 0 page errors
node --check (all .js):  all OK
```

## Conclusion

Both features are correctly implemented with clean, minimal diffs. The scenario change flow properly stops timers, reloads the registry, pre-selects the current scenario, and avoids state leaks. The remote Ollama preset routes through the right provider with correct labeling and backward-compatible settings persistence. No regressions.

**APPROVE.**