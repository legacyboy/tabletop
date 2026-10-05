# TEST RESULTS — report polish + resource usage (2026-10-05, v3)

**Model:** `deepseek-v4.1-flash:cloud` (local Ollama) · **Live:** legacyboy.github.io/tabletop

## What changed

**Report polish**
- Header no longer duplicates the scenario title (deduped title vs scenario).
- `State after` in the audit table renders as a readable metric list
  (`Budget: 70 · Public Trust: 70 · ...`) instead of a raw JSON blob.
- Generated/date fields are humanized (`Oct 5, 2026, 3:01 p.m.`).
- In-app closing report now shows **resource usage + per-player attribution**,
  matching the exported report (previously it was a thinner view).
- Log entries show the player and label the opening scene.

**Export**
- New **Export report (HTML)** button → a self-contained, printable HTML file.
  Works on static hosting (no server needed).

**Cost (completes the L2 accounting)**
- Token counts → an **indicative** USD figure from a public price table (per
  model, fallback rate). Surfaced in report Part 3 and the in-app report.
- Real run: `9,482 tokens → $0.0009` on DeepSeek Flash 4.1 (`estimated:false`,
  model identified from the usage report).

## Results

| Suite | Result |
|---|---|
| Unit (`npm test`) | **246 / 0** (incl. +22 report assertions) |
| Report/export (browser, R1) | **6 / 6** |
| Playability + audit (real model) | **16 / 16** |
| Expanded / endgame / live-bundle / concurrency / migration | unchanged (green) |

## New assertions
`report.test.js` now covers the Part 1b transcript, Part 3 usage + cost, the
Player column, humanized state, and graceful no-player sessions.
`report-export.mjs` (R1) ends a session in a real browser and asserts the in-app
report fields + a working HTML download.

## Remaining gaps (reviewed v3, accepted)
- Cross-browser: automated browser tests run on **Chromium only** (only engine
  installed). Manual spot-check on Safari/Firefox before release.
- Two-tab: the active-tab lock is implemented and unit-guarded, but there is no
  automated *two real tabs* test yet.
- Cost table is a static best-effort list; figure is labelled *indicative*.
- A full session against `api.deepseek.com` (the live direct-API path) is Dan's
  manual acceptance run, not automated.
