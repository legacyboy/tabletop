# PR #7 Review — Scenario Schema v3: Conditional Events, Text-First Intro, Hidden Goal

**Reviewer:** Steve (subagent)
**Date:** 2026-08-18
**Branch:** feature/scenario-v3-events (commit 9b21ab3)
**Base:** main

---

## Verdict: APPROVED

No bugs or regressions found. All tests pass. The event system is correctly implemented with proper once-only firing, persistence across save/restore, and correct trigger evaluation. The goal is confirmed hidden from players. Backward compatibility with v2 scenarios is maintained.

---

## Summary of Changes

- **Event system** added to `dm.js`: conditional events with stall/stat/turn triggers, each firing at most once per session, with `state_delta` application and DM context weaving.
- **Intro heading** changed from "Intro for the moderator" to "Opening scene" in `index.html`.
- **Goal hidden** from players: `goal`/`win_conditions`/`ending` exist only in the engine (`dm.js`) and the DM's private system prompt. No player-facing UI renders them.
- **Scenario JSON**: Bramble Badger updated to version 4 with 5 events. Blank template updated to version 4 with 2 example events.
- **Validator** (`scenarios.js`): now accepts version 2, 3, or 4.
- **Docs**: `SCENARIO_SCHEMA_v2.md` deleted, `SCENARIO_SCHEMA_v3.md` added (both in `docs/` and `wiki/`). `How-to-Build-a-Scenario.md` updated to reference v3, events, and hidden goal.
- **Tests**: `dm-session.test.js` adds 11 new test cases covering stall/stat/turn triggers, once-only firing, stall counter reset, serialize/restore persistence, and state_delta application. `verify-features.mjs` adds 5 checks for intro heading, facilitator notes label, and goal invisibility.

---

## Detailed Audit

### 1. Event System (`dm.js`)

**Once-only firing (`firedEvents` Set):** Correct. Each event is checked against `this.firedEvents.has(ev.id)` at the top of the loop, and added to the set immediately when it fires. No path allows a double-fire.

**Stall trigger:** Correct. `isStall = !action || action.trim().length < 3`. The stall counter increments on stall, resets to 0 on meaningful action. The `takeTurn` guard rejects truly empty strings, so the `!action` branch in `_evaluateEvents` is technically unreachable but harmless as a defensive check. The stall trigger fires when `this.stallCount >= t.turns`.

**Stat trigger:** Correct. Checks `this.state[t.stat]` against the threshold using `gte` or `lte`. Only fires if the stat value is a number. The stat is evaluated on the current state (after fate delta, before DM delta), which is the right point — the event fires based on the state entering this turn.

**Turn trigger:** Correct. Uses `this.turn + 1 === t.turn` where `this.turn` is the count of completed turns (0-indexed before increment). So turn trigger 3 fires on the third `takeTurn` call. Consistent with the 1-indexed turn numbers shown in history.

**State_delta application:** Correct. Each fired event's `state_delta` is applied via `_applyDelta`, which caps individual changes at ±10 and clamps to [0,100]. Multiple events firing on the same turn stack correctly (applied sequentially).

**DM context weaving:** Correct. Fired event texts are injected into `buildUserTurn` as `A pre-compiled event fires this turn: "..."`. The system prompt also lists all events upfront so the DM knows they exist.

**Persistence (serialize/restore):** Correct. `serialize()` includes `firedEvents: Array.from(this.firedEvents)` and `stallCount`. `restore()` reconstructs `firedEvents = new Set(snapshot.firedEvents || [])` and `stallCount = snapshot.stallCount || 0`. A restored session does not re-fire previously fired events. Old snapshots without these fields default to empty Set / 0, which is correct backward-compat behavior.

**Backward compat (`pressure_points`):** Correct. `dm_brief.pressure_points` is still included in the system prompt as a fallback. New scenarios should use the top-level `events` array, but old scenarios with only `pressure_points` still work.

**System prompt disclosure:** All events (including unfired ones) are listed in the system prompt. This is by design — the DM knows the event catalog upfront but only acts on events when the engine signals they've fired. Not a bug.

### 2. Goal Hidden from Players

**`main.js`:** No reference to `goal`, `win_conditions`, or `ending` in any player-facing rendering. The only "Ending" reference is in the report phase (`add('Ending', report.ending ...)`) which is the post-session debrief report, not player-visible during play. Correct.

**`index.html`:** No reference to `goal`, `win_conditions`, or `ending`. The heading change from "Intro for the moderator" to "Opening scene" is clean. Correct.

**`dm.js`:** `goal` and `win_conditions` are used only in `_checkEnd()` to detect a successful end condition. The goal text is included in the DM's system prompt (private briefing). Never rendered to players. Correct.

**`verify-features.mjs`:** Confirms via DOM inspection that `win_conditions`, `Crisis resolved`, and `restore trust` do not appear in `document.body.innerText` during the intro phase. All 5 goal-leak checks pass.

### 3. Scenario JSON Validity

**Bramble Badger (`scenario.json`):** Valid JSON. Version 4. 5 events with valid triggers:
- e1: stall/turns:2, delta keys match opening_state
- e2: stall/turns:3, delta keys match opening_state
- e3: stat/risk gte 60, delta keys match opening_state
- e4: stat/regulator_confidence lte 40, delta keys match opening_state
- e5: turn/turn:6, delta keys match opening_state

All `state_delta` keys are subsets of `opening_state` keys. No orphaned keys.

**Blank template:** Valid JSON. Version 4. 2 events with valid triggers. All delta keys match opening_state.

### 4. Validator Change

`scenarios.js` now accepts version 2, 3, or 4. This is backward compatible — existing v2 and v3 scenarios still validate. No regression.

### 5. Test Results

| Test Suite | Result |
|---|---|
| `node --check` (dm.js, main.js, scenarios.js) | All pass |
| `tests/presets.test.js` | 33 passed, 0 failed |
| `tests/dm-session.test.js` | 41 passed, 0 failed |
| `tests/dm-integration.test.js` | 6 passed, 0 failed |
| `tests/extract-json.test.js` | 7 passed, 0 failed |
| `tests/report.test.js` | Pass (exit 0) |
| `tests/verify-features.mjs` | 44 passed, 0 failed (against running server on :8000) |

Total: 131+ tests, 0 failures.

### 6. Regressions

No regressions detected. All existing tests continue to pass. The validator change is additive (accepts v4 in addition to v2/v3). The `pressure_points` fallback is preserved. The intro heading change is cosmetic. The event system is additive — scenarios without an `events` array work identically to before (empty array default).

---

## Issues Found

None.

---

## Notes (non-blocking observations)

1. **Stall threshold heuristic:** The stall detection uses `action.trim().length < 3` as the "no meaningful action" heuristic. This catches 'x', 'ok', 'uh' etc. but would not catch 'um' (2 chars) vs 'hmm' (3 chars, not a stall). In practice this is fine for a tabletop facilitator tool — the threshold is intentionally lenient and the DM can still adjudicate meaningfully on short actions.

2. **All events disclosed to DM upfront:** The system prompt lists all events (including their text) to the DM before any have fired. This is intentional (the DM knows the scenario's event catalog) but means a DM model could theoretically reference an event before it fires. The instructions say "when one fires, weave its text" which mitigates this. Not a bug.

3. **Multiple events on same turn:** If multiple events fire on the same turn (e.g., a stall event and a stat event), their texts are concatenated in the user turn message. The DM is told to weave them all in. This is correct behavior and the state_deltas stack properly.

4. **Event deltas subject to ±10 cap:** The `_applyDelta` method caps each metric change at ±10 per call. Event state_deltas in the Bramble Badger scenario are all within this cap (max single change is -6). If a scenario author wrote a delta of -15, it would be capped to -10. This is consistent with the existing per-turn cap on DM-proposed changes and keeps the game arc believable. Documented behavior.

---

## Conclusion

PR #7 is well-structured, thoroughly tested, and correctly implements the v3 schema changes. The event system is sound with no double-fire paths, proper persistence, and correct trigger evaluation. The goal is confirmed hidden from players. Backward compatibility is maintained. All 131+ tests pass.

**APPROVED.**