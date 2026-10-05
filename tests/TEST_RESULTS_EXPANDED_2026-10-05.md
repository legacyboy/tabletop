# EXPANDED TEST REGIME — RESULTS (2026-10-05, run 2)

**DM under test:** `deepseek-v4.1-flash:cloud` ONLY (via local Ollama).
**Commit:** `6689a62` (live on legacyboy.github.io/tabletop).

## New / expanded harnesses (added this run)
- `tests/expanded-regime.mjs` — E1..E5 battery (openings, roll sweep, random mode,
  full 12-turn session + report, state integrity).
- `tests/turn-truncation-sweep.mjs` — 15 consecutive turns in ONE session
  (growing context = where truncation actually bites).
- `tests/repeatability-sweep.mjs` — N runs/scenario, quantifies soft vs hard
  non-clean endings.

Run them:
```bash
cd projects/tabletop
DM_MODEL=deepseek-v4.1-flash:cloud node tests/expanded-regime.mjs
DM_MODEL=deepseek-v4.1-flash:cloud node tests/turn-truncation-sweep.mjs 15
DM_MODEL=deepseek-v4.1-flash:cloud N=4 node tests/repeatability-sweep.mjs
```

## Results

| Harness | Coverage | Result |
|---|---|---|
| **expanded-regime** | E1-E5, ~28 assertions | **28/28 PASS** (2nd run; 27/28 first — see note) |
| **turn-truncation-sweep** | 15 consecutive turns, growing context | **15/15 clean** |
| **repeatability-sweep** | 20 opening scenes (5 scenarios x 4) | **100% clean** |
| **T1 unit suite** (previous) | 223 tests | 223/0 |

### expanded-regime detail
- **E1** Opening scene, all 5 scenarios — PASS (1,336–1,665 chars, all clean)
- **E2** Multi-turn across roll extremes (roll 20/1/10/5/18) — 5/5 PASS
- **E3** Random-mode generated scenario — openings + turn PASS
- **E4** Full 12-turn session + report build — 12/12 turns clean, report builds
- **E5** State integrity — all 7 metrics stayed within [0,100] across 6 turns

### turn-truncation-sweep (the key test)
15 consecutive turns, one session, context growing each turn, rolls 1-20 spread:
- clean: 15, soft-fail: 0, **hard (mid-word) truncation: 0**, json leak: 0, fallback: 0
- narrative length min/avg/max: **867 / 1078 / 1261** chars

## Note on the single soft-fail
Run 1 of expanded-regime had one failure: `E1 whistleblower — does NOT end cleanly`.
- Re-ran E1 in isolation: **clean**.
- Repeatability sweep: **0 soft / 0 hard in 20 runs**.
- Full re-run of expanded-regime: **28/28**.
=> It was a **transient model output** (one narrative ended without terminal
punctuation), NOT a code defect and NOT a truncation. The fix holds.

## Verdict
With `deepseek-v4.1-flash:cloud` as DM: **no truncation anywhere** — across
openings, 15-turn sessions, all 5 scenarios, random mode, roll extremes, and
report generation. State stays in range. The earlier truncation bug is fixed.
