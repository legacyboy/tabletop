# PR #4: Company URL field for DM context fetch

## Problem
The Settings (DM) screen had an "Allow the DM to fetch public info about the
scenario's company URL" checkbox (`allowCompanyFetch`), but no field to enter a
company URL. The URL only came from the scenario file's `intro.company_url`,
which is EMPTY for the Bramble Badger scenario — so the checkbox did nothing.

## Feature
Added a "Company URL (for DM context)" text input to the Settings (DM) screen.
When set, the user-entered URL is used (preferred over the scenario's
`intro.company_url`) when the DM fetches public company info. The
`allowCompanyFetch` checkbox still gates the fetch.

## Changes
- **index.html** — Added `<input id="companyUrl" type="text" placeholder="https://example.com" />`
  below the `allowCompanyFetch` checkbox, labeled "Company URL (for DM context)".
  Updated the checkbox label to reference "the company URL below" so it's clear
  the field feeds the fetch.
- **app/js/providers/registry.js** — Added `companyUrl: ''` to `defaultSettings()`
  so it persists with the rest of the settings (spread-merged in `loadSettings`).
- **app/js/settings.js** — Added `companyUrl` to the field refs (`el.*`), saved it
  in the `saveSettings` handler (`current.companyUrl = el.companyUrl.value.trim()`),
  and reflected it into the input on render.
- **app/js/main.js** — In `beginSession()`, compute the fetch URL as
  `settings.companyUrl` (preferred) else `scenario.intro.company_url`, and pass it
  into `fetchCompanyInfo(scenario, { companyUrl })`.
- **app/js/scenarios.js** — `fetchCompanyInfo(scenario, opts = {})` now prefers
  `opts.companyUrl || settings.companyUrl` over `scenario.intro.company_url`,
  still gated by `settings.allowCompanyFetch`. Falls back to scenario URL when no
  user URL is set.
- **tests/presets.test.js** — Added checks that `defaultSettings()` includes
  `companyUrl` (defaulting to `''`) and `allowCompanyFetch` defaults true.
- **tests/verify-features.mjs** — Added headless browser checks: the `companyUrl`
  input exists, has the `https://example.com` placeholder, the checkbox label
  references the field, and the value persists across a save + settings refresh.

## Verification
- `node --check` on all four edited `.js` files: OK.
- Unit tests (`node tests/*.test.js`): all pass
  - presets.test.js 24/24
  - dm-session.test.js 28/28
  - dm-integration.test.js 6/6
  - extract-json.test.js 7/7
  - report.test.js exit 0
- Headless `node tests/verify-features.mjs` (server on :8000): 20/20 pass,
  **no page errors**.

## Branch / PR
- Branch: `feature/company-url-field` (off `main` @ `0ab7661`)
- Commit: `35ecf43`
- Not pushed to `main`.

## Notes
- Preference order for the fetched URL: user-entered `companyUrl` (settings) →
  scenario `intro.company_url`. `allowCompanyFetch` must still be enabled.
- The URL is stored only in browser localStorage (same as other DM settings),
  never sent to this app's origin — only to the target company URL (via direct
  fetch or the existing `/api/company` proxy).
