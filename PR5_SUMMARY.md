# PR5 — Model dropdown for "Ollama (remote)" preset

## What changed

Added a model **dropdown** to the DM settings screen for the "Ollama (remote)"
preset, replacing the free-text model input for that preset. A "Custom…" option
reveals the free-text input so any model can still be typed. This is a pure UI
change — the server proxy, the API, and how the model is sent to the server are
untouched.

### Files changed

- **`app/js/providers/registry.js`**
  - Exported `OLLAMA_MODELS` — array of `{ value, label }` for common Ollama
    models: `gemma3:4b` (Gemma 3 4B, default/first), `glm-5.2:cloud` (GLM 5.2),
    `deepseek-v4-flash:cloud` (DeepSeek Flash), `qwen3-coder-next:cloud` (Qwen).

- **`index.html`**
  - Added `<select id="modelSelect" style="display:none"></select>` inside the
    existing `#modelWrap` label, right next to `<input id="model">`. Options are
    built dynamically in settings.js (not hardcoded in HTML).

- **`app/js/settings.js`**
  - Added `'modelSelect'` to the `el` map.
  - Imported `OLLAMA_MODELS`.
  - `renderDynamic()`: when the current preset is `ollama-remote`, shows the
    dropdown and hides the free-text input; for all other presets shows the
    free-text input and hides the dropdown.
  - `populateModelSelect()`: builds options from `OLLAMA_MODELS` plus a
    "Custom…" option with value `""`.
  - `el.modelSelect.onchange`: picking a real model sets `current.model` and
    `el.model.value` (keeps the free-text input in sync so the existing save
    path that reads `el.model.value` works unchanged) and hides the free-text
    input; picking "Custom…" reveals the free-text input.
  - When the preset is `ollama-remote`, pre-selects `current.model` in the
    dropdown if it matches one of `OLLAMA_MODELS`, else selects "Custom…" and
    shows the free-text input.

### Tests added

- **`tests/presets.test.js`** — verifies `OLLAMA_MODELS` is exported, contains
  `gemma3:4b`, `glm-5.2:cloud`, `deepseek-v4-flash:cloud`, at least one qwen
  model, ids are unique, entries have value+label, and the default (first) is
  `gemma3:4b`.
- **`tests/verify-features.mjs`** — after selecting the `ollama-remote` preset:
  dropdown visible, free-text input hidden, dropdown contains the expected
  model options + "Custom…", picking a model updates the hidden free-text input,
  picking "Custom…" reveals the free-text input, and a non-remote preset shows
  the free-text input (not the dropdown).

## Test results

- `node --check` on all changed JS files: **OK** (registry, settings, presets.test, verify-features).
- Unit tests (all pass):
  - `presets.test.js`: **32 passed, 0 failed**
  - `dm-session.test.js`: **28 passed, 0 failed**
  - `dm-integration.test.js`: **6 passed, 0 failed**
  - `extract-json.test.js`: **7 passed, 0 failed**
  - `report.test.js`: **passed** (report generated, fingerprint stable)
- Browser verification (`node tests/verify-features.mjs` against `node server/serve.js`):
  **34 passed, 0 failed, zero page errors.** Server killed afterward.

## Not touched

The server proxy (`server/serve.js`, `app/js/providers/server-proxy.js`), the
API, and how the model is sent to the server were **NOT** changed. This is
purely a settings-screen UI change.

No commit, no push, no PR.
