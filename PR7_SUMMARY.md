# PR7 Summary — Scenario Schema v3 (text-first intro, conditional events, hidden goal)

Branch: `main` @800bf3e (clean). No commit/push/PR made — changes only.

## What changed

### 1. `app/js/dm.js` — conditional event engine
- Added `this.events` (from `scenario.events`), `this.firedEvents` (a `Set`), and `this.stallCount`.
- New `_evaluateEvents(action)` runs each turn before the DM adjudicates. It evaluates every event's trigger:
  - `stall` — fires after N consecutive turns with no meaningful action (action text empty or < 3 chars). Counter resets on a meaningful action.
  - `stat` — fires when a stat crosses a threshold (`gte`/`lte`).
  - `turn` — fires on a specific turn number.
- Each event fires **at most once** (tracked in `firedEvents`). When it fires: its `state_delta` is applied and its `text` is injected into the DM's user-turn context so the DM weaves it into the narrative.
- `buildSystemPrompt` now lists the pre-compiled events so the DM knows to weave fired events into the story. `dm_brief.pressure_points` still works as a backward-compatible fallback.
- `serialize()` now persists `firedEvents` (array) and `stallCount`; `restore()` rebuilds them so a restored session never re-fires an event.
- History events now record `events: [fired event ids]` for the audit log.

### 2. `app/js/scenarios.js`
- `validateScenario` now accepts `version` 2, 3, or 4 (was 2 or 3).

### 3. `scenarios/bramble-badger-deepfake/scenario.json`
- Bumped `version` 3 → 4.
- Added top-level `events` array (5 events) converting the old `pressure_points` into conditional triggers:
  - `e1` stall(2) — confused "holding" screenshot
  - `e2` stall(3) — second spoof video / "cheese audit"
  - `e3` stat risk ≥ 60 — fraud spike report
  - `e4` stat regulator_confidence ≤ 40 — regulator calls
  - `e5` turn 6 — influencer amplifies
- Kept `dm_brief.pressure_points` intact (backward-compat fallback) and all other fields.

### 4. `scenarios/templates/blank-scenario-template.json`
- Bumped `version` 3 → 4, added the `events` array with stall + stat examples. Kept valid JSON (comments live in the docs, not the file).

### 5. `docs/SCENARIO_SCHEMA_v2.md` → `docs/SCENARIO_SCHEMA_v3.md`
- Rewrote as v3: documents the text-first intro (opening scene), the conditional `events` array (stall/stat/turn triggers, once-per-session), and the hidden goal. Removed the v2 doc.

### 6. `wiki/Scenario-Schema-v2.md` → `wiki/Scenario-Schema-v3.md`
- Same v3 rewrite for the wiki. Removed the v2 wiki page.

### 7. `wiki/How-to-Build-a-Scenario.md`
- Updated to v3: text-first opening scene, conditional events section, hidden goal section, updated 60-minute structure.

### 8. `index.html` + `app/js/main.js`
- Intro heading changed from **"Intro for the moderator"** → **"Opening scene"** (the narrative is the group's opening scene). Facilitator notes keep the moderator-only label.
- `main.js` comment updated; the goal is **not** rendered anywhere in the UI (it lives only in the engine's `_checkEnd()`).

### 9. `tests/dm-session.test.js`
- Added event-firing coverage: stall fires after N stalled turns, stall counter resets on a meaningful action, stat trigger fires on threshold cross, fired events don't re-fire, serialize/restore persists fired ids (no re-fire after restore), turn trigger fires on its turn.

### 10. `tests/verify-features.mjs`
- Added headless checks: intro heading reads "Opening scene", no longer "Intro for the moderator", facilitator notes still labeled moderator-only, and the goal is NOT visible to players (no `win_conditions`/ending text in the DOM).

## Test results
- `node --check` on all changed JS: **OK** (dm.js, main.js, scenarios.js, dm-session.test.js).
- `node tests/presets.test.js`: **33 passed, 0 failed**
- `node tests/dm-session.test.js`: **41 passed, 0 failed** (incl. new event tests)
- `node tests/dm-integration.test.js`: **6 passed, 0 failed**
- `node tests/extract-json.test.js`: **7 passed, 0 failed**
- `node tests/report.test.js`: **passed** (report title, 2 turns, fingerprint, HTML parts)
- `node tests/verify-features.mjs` (server on :8000): **44 passed, 0 failed, zero page errors** — includes the new "Opening scene" heading check and the hidden-goal check.

## Goal hidden from players — confirmed
The `goal` object (description, `win_conditions`, `ending`) is used only by the engine (`dm.js` `_checkEnd()`) to detect a successful end. It is never referenced in `main.js` or `index.html`, and the headless check confirmed no `win_conditions`/ending text appears in the rendered DOM. Players never see the goal.

## Notes
- A server was already running on :8000 (pid 2242116) before this task; verify-features ran against it successfully. My own backgrounded server attempt exited on EADDRINUSE. I did not kill the pre-existing server (it wasn't started by me and may be in use).
