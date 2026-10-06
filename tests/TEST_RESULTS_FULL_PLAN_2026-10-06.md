# Full Test Plan Run — Results (2026-10-06)

**Model:** `deepseek-v4.1-flash:cloud`  ·  **Live target:** https://legacyboy.github.io/tabletop
**Runner:** `bash tests/run-full-plan.sh`  ·  **Plan:** `TEST_PLAN_2026-10-05.md` (v4)
**Log:** `tests/out/FULL_PLAN_LATEST.log`

## Verdict: 21 / 21 suites PASS — 0 failed

| # | Suite | What it proves | Result |
|---|-------|----------------|--------|
| T1 | `npm test` unit | extract-json, dm-session, dm-integration, report, presets, direct-provider | 57/0 |
| T1b | story-win unit assertions | final-beat win, chain-containment win, low-metric win, quality tiers, no-goal wins, advisory note | 156/0 |
| T1c | report render | transcript, usage+cost, player column, humanized state | +22/0 |
| T1d | presets / model dropdown | retired-id migration, current dropdown | 57/0 |
| T1e | direct-provider | DeepSeek API request shape (live path) | 29/0 |
| T2 | single-turn truncation | narrative > 400, no mid-paragraph cutoff | PASS |
| T3 | multi-turn session (3) | sustained prose across turns | PASS |
| T4 | 7-turn detailed run | coherence over a full scene arc | PASS |
| T5 | cross-scenario drive | all 5 authored scenarios, one turn each | 5/5 |
| E | expanded regime | openings, roll sweep, random mode, 12-turn, state, fate events, adversarial input | 43/43 |
| G1 | endgame reachability | story win, timeout, **all-zero collapse still plays**, comeback win | 17/17 |
| G2 | two-sided audit trail | both DM↔player sides logged every turn | 16/16 |
| G3s | live-bundle proof (static) | shipped bundle has the expected symbols | 11/11 |
| TrS | turn-truncation sweep | 15 consecutive turns, no truncation | PASS |
| RS | repeatability sweep | stable output over repeats | PASS |
| L3 | concurrency + persistence | serialize/restore, streak survives | 14/14 |
| L4 | settings migration (live) | stale retired id self-heals in persisted + UI | 5/5 |
| R1 | report + HTML export (browser) | end session, export self-contained HTML | 6/6 |
| OBJ | objective panel (browser) | goal + arc shown, current step highlighted, no numeric-gate leak | 6/6 |
| G3b | live-bundle proof (headless live) | live site boots and matches | 14/14 |
| L3b | concurrency browser | reload + resume, two-tab lock | 17/17 |

## Story-win design compliance (Dan, 2026-10-05)
- **Win = story resolution** (final beat reached OR attack chain fully contained). Numeric metrics are advisory only and never gate. ✅ (T1b, G1)
- **All-zero metrics still complete the story**: the narrative collapse is flagged as in-story pressure, NOT a terminal loss; the session keeps playing to resolution. A fully-collapsed comeback reads as the *costliest* win. ✅ (G1 17/17, incl. a real-model run at trust=0/reg=0 that kept playing)
- **Win condition shown as goal, not triggers**: the Objective panel exposes the goal + arc; the mechanical win triggers and collapse thresholds stay in the DM's private briefing. ✅ (OBJ 6/6)

## Notes from the first pass (both resolved, not code bugs)
- **L4 1/4** on run 1 — runner passed `LIVE_URL=.../index.html`, and the test appends `/` → `.../index.html/` (page never booted). Fixed the runner to use the base URL; **5/5 on retry and on the clean run.**
- **T5 4/5** on run 1 — `whistleblower turn 1: no narrative`, a transient empty model response (same flake class seen before). **5/5 on retry and on the clean run.**

## Remaining accepted gaps (unchanged)
- Cost table is static/indicative (per-model fallback rate), labelled as such.
- Two-tab lock is asserted via the browser suite; no automated *two real OS tabs* driver.
- Cross-browser coverage is Chromium only.
- Direct DeepSeek API path is unit-tested (T1e) but not played end-to-end against the live provider.
