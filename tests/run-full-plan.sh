#!/usr/bin/env bash
# Full test-plan runner (TEST_PLAN_2026-10-05.md, v4).
# Executes every suite: fast layers, live regimes, gap-closers, browser tests.
# Writes a consolidated report to tests/out/FULL_PLAN_<ts>.log and prints a summary.
set -u
cd "$(dirname "$0")/.." || exit 1
OUT="tests/out/FULL_PLAN_$(date +%Y%m%dT%H%M%S).log"
mkdir -p tests/out
MODEL="${DM_MODEL:-deepseek-v4.1-flash:cloud}"
LIVE_URL="${LIVE_URL:-https://legacyboy.github.io/tabletop}"; LIVE_URL="${LIVE_URL%/index.html}"
export DM_MODEL="$MODEL"

pass=0; fail=0
declare -a RESULTS

run() {
  local id="$1"; shift
  local desc="$1"; shift
  echo "" | tee -a "$OUT"
  echo "==================================================================" | tee -a "$OUT"
  echo "### $id — $desc" | tee -a "$OUT"
  echo "\$ $*" | tee -a "$OUT"
  echo "------------------------------------------------------------------" | tee -a "$OUT"
  local t0; t0=$(date +%s)
  # Run, capture both stdout and exit code.
  "$@" >>"$OUT" 2>&1
  local rc=$?
  local t1; t1=$(date +%s)
  local dur=$((t1 - t0))
  # Extract a SUMMARY line if present, else fall back to exit code.
  local summary; summary=$(grep -E "SUMMARY:|passed, [0-9]+ failed|passed, 0 failed" "$OUT" | tail -1)
  if [ $rc -eq 0 ]; then
    pass=$((pass+1)); RESULTS+=("PASS  [$id] $desc  (${dur}s)  ${summary:-ok}")
  else
    fail=$((fail+1)); RESULTS+=("FAIL  [$id] $desc  (${dur}s, exit=$rc)  ${summary:-}")
  fi
  echo "$id exit=$rc (${dur}s) :: ${summary:-}" | tee -a "$OUT"
}

echo "FULL TEST PLAN RUN — $(date)" | tee -a "$OUT"
echo "model=$MODEL  live=$LIVE_URL" | tee -a "$OUT"

# ---------- Fast layer (no model) ----------
run T1 "Unit tests (extract-json, dm-session, dm-integration, report, presets, direct-provider)" \
  npm test
run T1b "Story-win focused unit assertions (already inside T1; explicit rerun)" \
  node tests/dm-session.test.js
run T1c "Report render assertions" \
  node tests/report.test.js
run T1d "Preset/model-dropdown assertions" \
  node tests/presets.test.js
run T1e "Direct-provider (DeepSeek API shape) tests" \
  node tests/direct-provider.test.js

# ---------- Live layer (real model) ----------
run T2 "Single-turn truncation check" \
  node tests/truncation-check.mjs
run T3 "Multi-turn session (3 turns)" \
  node tests/live-deepfake-multi.mjs 3
run T4 "7-turn detailed run" \
  node tests/live-deepfake-7.mjs
run T5 "Cross-scenario drive (5 authored scenarios)" \
  node tests/live-ollama-drive.mjs

# ---------- Expanded regime ----------
run E "Expanded regime (openings, roll sweep, random, 12-turn, state, fate, adversarial)" \
  node tests/expanded-regime.mjs

# ---------- Gap-closing suites ----------
run G1 "Endgame reachability (story win / timeout / all-zero collapse)" \
  node tests/endgame-drive.mjs
run G2 "Two-sided audit trail + playability" \
  node tests/playability-audit.mjs 4
run G3s "Live-bundle proof (static)" \
  node tests/live-browser-budget.mjs
run TrS "Turn-truncation sweep (15 consecutive turns)" \
  node tests/turn-truncation-sweep.mjs
run RS "Repeatability sweep" \
  node tests/repeatability-sweep.mjs

# ---------- Audit-trail limitations (L1–L4) ----------
run L3 "Concurrency + persistence (serialize/restore)" \
  node tests/concurrency-persistence.mjs
run L4 "Settings migration (stale payload)" \
  env LIVE_URL="$LIVE_URL" node tests/settings-migration.mjs

# ---------- Browser tests (need local static server on :8000) ----------
run R1 "Report + HTML export (browser)" \
  node tests/report-export.mjs
run OBJ "Objective panel (browser)" \
  node tests/objective-panel.mjs
run G3b "Live-bundle proof (headless live site)" \
  node tests/live-browser-budget.mjs --browser
run L3b "Concurrency browser reload+resume" \
  node tests/concurrency-persistence.mjs --browser

echo "" | tee -a "$OUT"
echo "==================================================================" | tee -a "$OUT"
echo "FULL PLAN SUMMARY: $pass passed, $fail failed" | tee -a "$OUT"
for r in "${RESULTS[@]}"; do echo "  $r" | tee -a "$OUT"; done
echo "" | tee -a "$OUT"
echo "log: $OUT"
exit $fail
