# Full Test Plan Run — Results (2026-10-06, after linear-arc change)

**Model:** `deepseek-v4.1-flash:cloud`  ·  **Live target:** https://legacyboy.github.io/tabletop
**Runner:** `bash tests/run-full-plan.sh`  ·  **Plan:** `TEST_PLAN_2026-10-05.md` (v4)
**Logs:** `tests/out/FULL_PLAN_LATEST.log` (and timestamped copies)

## Verdict: 21 / 21 suites PASS — 0 failed

| # | Suite | What it proves | Result |
|---|-------|----------------|--------|
| T1 | `npm test` unit | extract-json, dm-session, dm-integration, report, presets, direct-provider | 57/0 |
| T1b | story-win unit assertions | final-beat win, chain win, **linear win with stages open**, quality tiers, no-goal wins | 160/0 |
| T1c | report render | transcript, usage+cost, player column, humanized state, **Left open** | +22/0 |
| T1d | presets / model dropdown | retired-id migration, current dropdown | 57/0 |
| T1e | direct-provider | DeepSeek API request shape (live path) | 29/0 |
| T2 | single-turn truncation | narrative > 400, no mid-paragraph cutoff | PASS |
| T3 | multi-turn session (3) | sustained prose across turns | PASS |
| T4 | 7-turn detailed run | coherence over a full scene arc | PASS |
| T5 | cross-scenario drive | all 5 authored scenarios, one turn each | 5/5 |
| E | expanded regime | openings, roll sweep, random mode, 12-turn, state, fate events, adversarial input | 43/43 |
| G1 | endgame reachability | story win, **linear pacing guard**, all-zero collapse still plays, partial-containment win | 22/22 |
| G2 | two-sided audit trail | both DM↔player sides logged every turn | 16/16 |
| G3s | live-bundle proof (static) | shipped bundle has the expected symbols | 11/11 |
| TrS | turn-truncation sweep | 15 consecutive turns, no truncation | PASS |
| RS | repeatability sweep | stable output over repeats | PASS |
| L3 | concurrency + persistence | serialize/restore, streak survives | 14/14 |
| L4 | settings migration (live) | stale retired id self-heals in persisted + UI | 5/5 |
| R1 | report + HTML export (browser) | end session, export self-contained HTML | 6/6 |
| OBJ | objective panel (browser) | goal + arc shown, current step highlighted, **containment optional**, no numeric-gate leak | 7/7 |
| G3b | live-bundle proof (headless live) | live site boots and matches | 14/14 |
| L3b | concurrency browser | reload + resume, two-tab lock | 17/17 |

## Linear-arc change (Dan's design, 2026-10-06)
Dan, playing live: the story was "taking far too much to move", and "progression should be linear —
if I do containment but miss something it should allow me to finish 3 but leave 2 open."

Confirmed with `tests/pacing-probe.mjs` (real model):
- **Before:** the DM parked the group on beat 1 for all 5 turns (advances=0), won only via full
  chain containment — the beat arc never moved.
- **After:** b1 → b2 → b3 in **4 turns** (advances=2), won by **reaching the final beat** with
  `open=[spread]` — the threat partially contained, exactly the ask.

Mechanics:
- Reaching the **final story beat WINS on its own**, even with attack-chain stages still open.
  Full chain containment is an **alternative** win path, not an added requirement.
- Uncontained stages are reported as `open_stages`; they only make the ending read **costlier**.
- **`BEAT_STALL_MAX` pacing guard**: if the DM keeps the group on one beat while the group makes
  real progress, the **engine advances the arc itself** (never past the final beat). This is the
  safety net so the story always moves. A genuine stall (no action) does not burn the guard.
- Prompt: win section rewritten (arc is the spine, linear, missing a stage allowed); beats section
  says advance every turn or two; pacing target tightened 6-8 → 4-6 turns.
- UI: Objective panel says "reach the final step to win" and that containment is an alternative,
  not required.

## Story-win design compliance (Dan, 2026-10-05 → 2026-10-06)
- **Win = story resolution**, not a score gate. ✅ (T1b, G1)
- **All-zero metrics still complete the story** — collapse is in-story pressure, not a terminal
  loss; a fully-collapsed comeback reads as the costliest win. ✅ (G1)
- **Linear progression** — reach the final beat; the arc advances every turn or two, with an engine
  guard if the DM stalls it. ✅ (G1, pacing-probe)
- **Partial containment allowed** — missing a stage never blocks the win. ✅ (T1b, G1)
- **Win shown as goal, not triggers** — the panel exposes the arc; triggers stay in the DM briefing. ✅ (OBJ)

## Notes
- Both failures in the earlier run were env/transient (runner URL bug on L4; one empty model
  response on T5) — green on retry and on this run.
- The single failure in this run (OBJ) was a stale assertion matching the *old* panel copy; the
  test was updated to the new linear-win copy and now also checks "containment optional". OBJ 7/7.

## Remaining accepted gaps (unchanged)
- Cost table is static/indicative, labelled as such.
- Two-tab lock asserted via the browser suite; no automated *two real OS tabs* driver.
- Cross-browser coverage is Chromium only.
- Direct DeepSeek API path unit-tested (T1e) but not played end-to-end against the live provider.
