# REVIEW_PR4.md — Code Review: PR #4 (feature/company-url-field)

**Reviewer:** GLM 5.2 (automated)
**Date:** 2026-08-18
**Branch:** feature/company-url-field @ 35ecf43
**Target:** main @ 0ab7661
**Files changed:** 7 (registry.js, settings.js, main.js, scenarios.js, index.html, presets.test.js, verify-features.mjs)

---

## Verdict: **APPROVE**

The PR correctly adds a user-entered Company URL field to the Settings (DM) screen, with proper persistence, precedence, gating, and no regressions. All tests pass. No issues found that warrant requesting changes.

---

## Detailed Findings

### 1. Company URL field correctly added and persisted

- **index.html (lines 150-153):** New `<input id="companyUrl" type="text" placeholder="https://example.com">` inside `<label id="companyUrlWrap">`. Placed directly below the `allowCompanyFetch` checkbox. Checkbox label updated from "scenario's company URL" to "the company URL below" — clear and accurate.
- **registry.js (line 72):** `companyUrl: ''` added to `defaultSettings()`. Backward-compatible: `loadSettings()` does `{ ...defaultSettings(), ...JSON.parse(raw) }` spread merge, so old saved settings without `companyUrl` get the empty-string default automatically.
- **settings.js (line 44):** `companyUrl` registered in the `el.*` element ref list. Saved on line 80 (`current.companyUrl = el.companyUrl.value.trim()`). Reflected into the input on line 171 (`el.companyUrl.value = current.companyUrl`) inside the existing `dataset.touched` re-fill block.
- **No regression to other settings fields:** The `companyUrl` field follows the exact same pattern as `apiKey`, `model`, `allowCompanyFetch`, etc. The `companyUrlWrap` label is not in the `el` ref list (not needed — no show/hide logic required for this field, unlike `baseUrlWrap`).

### 2. URL precedence is correct (user URL > scenario URL)

- **main.js `beginSession()` (line 197):** `const companyUrl = (settings.companyUrl || '').trim() || (scenario.intro.company_url || '')` — trims whitespace, falls back to scenario URL when user URL is empty/whitespace. Passes result as `{ companyUrl }` to `fetchCompanyInfo`.
- **scenarios.js `fetchCompanyInfo()` (line 69):** `const userUrl = opts.companyUrl || settings.companyUrl || ''` then `const url = (userUrl || '').trim() || (scenario.intro && scenario.intro.company_url)` — double-checks both opts and settings, then falls back to scenario URL. The redundant settings check (already resolved in beginSession) is harmless and makes `fetchCompanyInfo` safe to call without opts.

**Precedence chain:** user-entered `settings.companyUrl` (trimmed) → `scenario.intro.company_url` → no fetch. Correct.

### 3. allowCompanyFetch still gates the fetch

- **scenarios.js (line 66):** `if (!settings.allowCompanyFetch) return null;` — checked before any network request. No code path bypasses this gate. Correct.

### 4. URL used only for company info fetch (not leaked)

- The company URL is sent only to the target site (via `directFetch` browser `fetch()`) or to the local `/api/company` proxy (via `proxyFetch`). It is never sent to the app's own origin or logged to console. The URL is stored in `localStorage` alongside other DM settings (same `SETTINGS_KEY`), consistent with existing keys/apiKey handling.

### 5. Settings UI renders/saves/loads correctly

- **renderDynamic() (line 171):** `el.companyUrl.value = current.companyUrl` — inside the `!el.baseUrl.dataset.touched` block, same as all other fields. On `tabletop:refreshsettings`, `el.baseUrl.dataset.touched` is deleted (line 115), forcing re-population. Verified by headless test: value persists across save + refresh cycle.

### 6. Edge cases handled

- **Empty companyUrl:** `(userUrl || '').trim()` catches empty string and whitespace-only. Falls back to scenario URL. If both are empty, `if (!url) return null` short-circuits. No fetch attempted.
- **Best-effort (never throws/blocks):** `directFetch` and `proxyFetch` both wrap in try/catch returning null on failure. `beginSession` chains `.catch(() => {})`. The `.then()` callback only updates `state.companyInfo` and `el.companyNote` — no throw path. Play proceeds regardless.
- **Backward compat:** Old localStorage without `companyUrl` key → spread-merged to `''` by `loadSettings()`. No migration needed.

### 7. Test results

| Test suite | Result |
|---|---|
| presets.test.js | 24/24 pass |
| dm-session.test.js | 28/28 pass |
| dm-integration.test.js | 6/6 pass |
| extract-json.test.js | 7/7 pass |
| report.test.js | pass (exit 0) |
| verify-features.mjs (headless) | 20/20 pass, 0 page errors |

New test coverage:
- `presets.test.js`: 3 new checks for `defaultSettings().companyUrl` (exists, defaults to `''`, `allowCompanyFetch` defaults true).
- `verify-features.mjs`: 4 new headless checks (input exists, placeholder correct, checkbox label references field, value persists across save + refresh).

### 8. PR4_SUMMARY.md sanity check

Accurate. Matches the actual diff. Claims verified:
- "20/20 headless, no page errors" — confirmed.
- "preference order: user URL → scenario URL" — confirmed in code.
- "allowCompanyFetch still gates" — confirmed.
- "URL stored only in localStorage, never sent to app origin" — confirmed.

---

## Minor observations (non-blocking, not requesting changes)

1. **Redundant settings lookup in `fetchCompanyInfo`:** `beginSession` resolves `companyUrl` from settings and passes it as opts, then `fetchCompanyInfo` re-reads `settings.companyUrl` via `loadSettings()`. Harmless (same value), but slightly wasteful. Not worth changing.
2. **`companyUrlWrap` not in el ref list:** Intentional — unlike `baseUrlWrap` which needs show/hide, the company URL field is always visible. No action needed.
3. **No URL validation:** The field accepts arbitrary text. A malformed URL would just fail the fetch (caught by try/catch, returns null). Acceptable for a DM-facing settings field — not user-facing input that needs sanitization.

---

**Conclusion:** PR #4 is clean, well-tested, and ready to merge. The fix is minimal and surgical — adds the missing input field, wires it through persistence and fetch logic with correct precedence, and adds appropriate test coverage. No regressions detected.