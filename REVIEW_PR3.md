# REVIEW — PR #3: Fix scenario-select dead end + remove remote-Ollama base URL field

**Reviewer:** GLM 5.2 (automated code review)
**Date:** 2026-08-18
**Branch:** `fix/scenario-select-deadend-and-remote-ollama-url`
**Commit:** `318ab91`
**Target:** `main`

---

## VERDICT: APPROVE

All tests pass, both bugs are correctly fixed, no regressions found.

---

## Bug 1 — Scenario select dead end

**Requirement:** The `#phase-select` screen had only a dropdown + summary with no way to proceed or go back. Add explicit Load/Start + Back buttons and a live summary hint.

**Findings:**

- `index.html` lines 27-29: Added `<button id="loadScenarioBtn">Load / Start</button>` and `<button id="selectBack">Back</button>` inside `#phase-select`. ✅
- `main.js` line 69: `el.loadScenarioBtn.onclick` loads the selected scenario via `selectScenario(idx)` — advances to intro. ✅
- `main.js` line 73-75: `el.selectBack.onclick` returns to `state.selectReturn` (with fallback to `intro` if a scenario is loaded, else `select`). ✅
- `main.js` line 144: `showScenarioSelect()` sets `state.selectReturn` based on current phase — `'report'` if coming from report, `'intro'` if from intro with a loaded scenario, `'select'` as fallback. ✅
- `main.js` lines 90-98: `renderScenarioOptions` wires `onchange` to update the summary and enable the Load button. ✅
- `main.js` lines 101-113: `updateSelectSummary` shows a clear hint naming the selected scenario, with a special message for single-scenario installs. ✅

**Dead-end is fully resolved.** Both forward (Load/Start) and backward (Back) paths work. The Back button correctly returns to the originating phase (intro or report).

---

## Bug 2 — Remote Ollama base URL field

**Requirement:** "NO ollama remote should go directly to ollama" — the remote Ollama preset must not expose a base URL field. Route through the app server's `/api/dm` proxy using the server's `OLLAMA_URL` env var.

**Findings:**

### Preset definition (`registry.js`)
- `ollama-remote` preset: `viaServer: true`, no `baseUrl` property, `model: 'gemma3:4b'`. ✅
- `server-local` preset: `viaServer: true`, `baseUrl: 'http://localhost:11434/v1'` (unchanged, visible). ✅

### Provider routing (`registry.js` `buildProvider`)
- Server-routed (`viaServer: true`) connections may leave `baseUrl` blank — server fills its `OLLAMA_URL` default. ✅
- Direct (browser→provider) connections still require a `baseUrl` (returns `null` if empty). ✅
- `ollama-remote` with empty `baseUrl` builds a `ServerProxyProvider` (not `OpenAICompatibleProvider`). ✅

### Server proxy client (`server-proxy.js`)
- Constructor accepts empty `baseUrl` (no throw). ✅
- `chat()` only includes `base_url` in the POST body when `this.baseUrl` is non-empty (line: `if (this.baseUrl) body.base_url = this.baseUrl;`). ✅
- When `baseUrl` is empty, the server's `/api/dm` handler falls back to `ENV.baseUrl` (`process.env.OLLAMA_URL || 'http://localhost:11434/v1'`). ✅
- Live test: `POST /api/dm` with no `base_url` returns `{"content": "ok"}` — confirms the server correctly uses its env default. ✅

### Settings UI (`settings.js`)
- `hideBaseUrl()` returns `true` only when the selected preset has no `baseUrl` property (i.e. `ollama-remote`). ✅
- `renderDynamic()` hides both `#baseUrl` and `#baseUrlWrap` (the label wrapper) when `hideBaseUrl()` is true. ✅
- When hidden, `current.baseUrl` is cleared to empty string (prevents stale values). ✅
- `server-local` still shows the Base URL field with localhost pre-filled. ✅
- Selecting a preset sets `viaServer` from the preset definition so `buildProvider` routes correctly. ✅

### HTML (`index.html`)
- `#baseUrlWrap` label exists and wraps the Base URL field. Both are hidden/shown together. ✅

**No base URL field is exposed for the remote Ollama preset.** The connection routes through `/api/dm` using the server's `OLLAMA_URL`. Exactly per Dan's requirement.

---

## Server /api/dm handler (`server/api.js`)

- Line 102: `baseUrl: body.base_url || ENV.baseUrl` — correctly falls back to `OLLAMA_URL` env var when client sends no `base_url`. ✅
- Line 50: `ENV.baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434/v1'` — sensible default. ✅
- POST `/api/dm` validates `messages[]` is present, builds provider, calls `.chat()`, returns `{ content }`. ✅
- Error handling: 400 for bad input, 502 for upstream failures. ✅

---

## Regression check — existing providers

Tested all provider paths via `buildProvider()` with representative settings:

| Provider | Type | baseUrl | Notes |
|---|---|---|---|
| OpenAI | OpenAICompatibleProvider | `https://api.openai.com/v1` | Unchanged, direct. ✅ |
| DeepSeek | OpenAICompatibleProvider | `https://api.deepseek.com/v1` | Unchanged, direct. ✅ |
| Anthropic | OpenAICompatibleProvider | `https://api.anthropic.com/v1` | Unchanged, direct. ✅ |
| Server-local | ServerProxyProvider | `http://localhost:11434/v1` | Unchanged, proxy with visible URL. ✅ |
| Ollama remote | ServerProxyProvider | `""` (empty) | New, proxy with no URL. ✅ |
| WebLLM | WebLLMProvider | N/A | Unchanged. ✅ |
| Custom (no preset) | OpenAICompatibleProvider | user-supplied | `viaServer` stays false. ✅ |
| None | null | — | Returns null, "Not configured". ✅ |

No regressions. All existing providers route exactly as before.

---

## Settings persistence

- `defaultSettings()` provides `viaServer: false` default. ✅
- `loadSettings()` merges saved settings over defaults (spread merge), so new fields like `viaServer` and `preset` are present even for older saved settings. ✅
- `findPreset()` first tries `settings.preset` (id match), then falls back to base-URL matching — but only when `settings.baseUrl` is set, so no-URL presets like `ollama-remote` don't accidentally match by URL. ✅

---

## Test results

### `npm test` (all suites)
- `dm-session.test.js`: **28 passed, 0 failed** ✅
- `dm-integration.test.js`: **6 passed, 0 failed** ✅
- `extract-json.test.js`: **7 passed, 0 failed** ✅
- `report.test.js`: **21 passed, 0 failed** ✅ (report formatting, fingerprint, HTML rendering)
- `presets.test.js`: **21 passed, 0 failed** ✅ (preset definitions, routing, labels, empty-URL handling)

**Total: 83 tests, 0 failures.**

### `tests/verify-features.mjs` (headless Chromium)
- **16 passed, 0 failed, 0 page errors** ✅
- Confirms: initial load → intro, Change scenario → select screen visible, dropdown repopulated, Load/Start button exists, Back button exists, summary hint present, Load returns to intro, Back returns to intro, preset dropdown includes `ollama-remote`, remote Ollama HIDES base URL field AND label/wrap, remote Ollama pre-fills `gemma3:4b`, server-local keeps localhost URL visible.

---

## PR3_SUMMARY.md sanity check

- Accurately describes both bugs and their fixes. ✅
- Lists all changed files (7 files, +194/-43 lines). ✅
- Test counts match actual results (28+6+7+21 node tests, 16 headless checks). ✅
- Notes that `REVIEW_PR2.md` / `REVIEW_WEBLLM.md` are prior artifacts, not part of this PR. ✅

---

## Minor observations (non-blocking)

1. **`selectReturn` default**: The initial value is `'select'` (line 28). On first load, `populateScenarios()` auto-advances to intro, so the user never sees the select screen with this default. If they later click "Change scenario" from intro, `showScenarioSelect()` correctly sets it to `'intro'`. No issue in practice.

2. **`loadScenarioBtn` disabled state**: The button starts enabled (no `disabled` attribute in HTML). The `onchange` handler also enables it. There's no code that disables it, so it's always clickable. This is fine — clicking Load with the current selection always works.

3. **Server-proxy `label` property**: The `ServerProxyProvider` constructor sets `this.label` but it's not used by `describeProvider` (which uses `describeSelection` in registry.js instead). No functional impact, just a minor disconnect.

None of these warrant requesting changes.

---

## Conclusion

PR #3 correctly fixes both bugs:
1. The scenario-select screen is no longer a dead end — explicit Load/Start and Back buttons with correct return-to-origin behavior.
2. The remote Ollama preset hides the base URL field and label entirely, routes through the server's `/api/dm` proxy using the server's `OLLAMA_URL` env var, and never exposes a URL to the browser.

All 83 node tests and 16 headless browser tests pass with zero failures and zero page errors. No regressions in any existing provider path. Settings persistence is backward-compatible.

**APPROVE — PR #3 is ready to merge.**