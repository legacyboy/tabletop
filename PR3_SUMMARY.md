# PR #3 — Fix scenario-select dead end + remove remote-Ollama base URL field

**Branch:** `fix/scenario-select-deadend-and-remote-ollama-url`
**Commit:** `318ab91`
**PR:** https://github.com/legacyboy/tabletop/pull/3 (target `main`)
**Status:** Open — pushed, CI/verification passed locally.

---

## What was fixed

### BUG 1 — "Change scenario" screen was a dead end
The `#phase-select` screen had only a dropdown + summary and no way forward or back ("does nothing").

**Fix (main.js + index.html):**
- Added explicit **Load / Start** and **Back** buttons to `#phase-select`.
- `Load / Start` loads the selected scenario and goes to intro.
- `Back` returns to wherever the user came from (intro, or report if they came from a finished session), tracked via a new `state.selectReturn`.
- Added a live summary line (`updateSelectSummary`) that names the selected scenario and, when only one is installed, says clearly: *"Only one scenario is available: <title>. Press Load/Start to continue."* — so a single-scenario install is never confusing.

### BUG 2 — 'Ollama (remote)' exposed a confusing Base URL field
Dan: no remote Ollama should force a URL; it should "just go to Ollama."

The previous uncommitted approach still showed an (empty + placeholder) Base URL field. That did **not** satisfy the "NO base URL field" requirement, so it was reworked.

**Design:** A browser on the public internet cannot reach a private remote Ollama directly, so the cleanest correct route is through the app server's `/api/dm` proxy — exactly like the Server (local Ollama) preset. The server reaches the (possibly remote) Ollama using its own `OLLAMA_URL` env default.

Changes:
- `app/js/providers/registry.js`
  - `ollama-remote` preset → `viaServer: true`, **no `baseUrl`**, model `gemma3:4b`.
  - `buildProvider`: server-routed (`viaServer`) connections may leave the base URL blank (server fills its `OLLAMA_URL`); direct browser→provider still requires a URL.
  - `describeSelection`/`findPreset`: handle a no-URL server preset cleanly (no bogus "no url" text).
- `app/js/providers/server-proxy.js`
  - No longer throws when base URL is empty; only sends `base_url` to `/api/dm` when one is actually set (server falls back to its own default).
- `app/js/settings.js`
  - Hides the Base URL field **and its label/wrap** when the selected preset carries no base URL (i.e. for `Ollama (remote)`). Server-local keeps its visible localhost field.
  - Selecting a preset now sets `viaServer` from the preset so `buildProvider` routes correctly.
- `index.html` — scenario-select buttons (above).

## Verification
- `node --check` on all edited `.js` files: pass.
- `npm test` (all suites): **28 + 6 + 7 + 21 passed, 0 failed, exit 0**.
- `tests/verify-features.mjs` (headless chromium via global puppeteer): **16 passed, 0 page errors**.
  - Confirms: Load/Start button returns to intro, Back button returns to intro, **remote-Ollama hides Base URL field AND label**, server-local still shows localhost.

## Files changed
- `app/js/main.js`
- `app/js/providers/registry.js`
- `app/js/providers/server-proxy.js` (new to this diff — required by the remote-Ollama design)
- `app/js/settings.js`
- `index.html`
- `tests/presets.test.js`
- `tests/verify-features.mjs`

## Notes
- Branch was pushed; PR #3 targets `main`. Nothing was pushed to `main`.
- Untracked `REVIEW_PR2.md` / `REVIEW_WEBLLM.md` are prior review artifacts and were intentionally left out of the commit.
- To run the headless verify yourself: start `node server/serve.js`, then
  `NODE_PATH=$(npm root -g) node tests/verify-features.mjs`.
