# Pacing sweep + BEAT_STALL_MAX experiment (2026-10-07)

Dan: "I want a set of tests at various pacing, fast, slow, really slow. Test it out
and see if it holds well." then "are you rolling failure and success when testing?"

## Method
`tests/pace-sweep.mjs` plays the CEO crisis at four tempos against the same build:
BLITZ (~5-6 actions/turn), NORMAL (2-3), SLOW (1), REALLY SLOW (1 + dithering).
Rolls span the whole D20 (1,3,5,7,11,12,14,17,20) so the fate table's bad AND good
branches fire. Per turn it records action count, DM narrative length, metrics moved,
beat, fate, whether the ENGINE auto-advanced the arc, and the pace verdict.

## Round 1 (bad: rolls 12-18 only) - FAILED to test failure
Only good rolls. Pearson r=0.314. 2 fate events in 18 turns. Caught by Dan's question.

## Round 2 (BEAT_STALL_MAX=2, full D20) - PASS, shipped
| tempo | turns | avgActs | avgNarr | avgMetrics | end |
|---|---|---|---|---|---|
| BLITZ | 4 | 6.8 | 1327ch | 6.3 | success |
| NORMAL | 4 | 3.8 | 1095ch | 4.8 | success |
| SLOW | 5 | 1.0 | 1057ch | 3.2 | success |
| REALLY SLOW | 6 | 1.5 | 874ch | 3.0 | success |
- Pearson r = 0.522 (action count vs response size) - scales with effort.
- Roll coverage: bad 7 / mid 8 / good 4. Both failure and success exercised.
- Fate fired 17/19 turns. Metrics by band: bad 3.1, mid 3.9, good 6.3 (roll matters).
- Guard (auto-advance) fired 8/19 turns.

## Round 3 (BEAT_STALL_MAX=3 experiment) - WORSE, REVERTED
| tempo | turns | end |
|---|---|---|
| BLITZ | 5 | **NO END** (never reached final beat) |
| NORMAL | 6 | success |
| SLOW | 7 | success |
| REALLY SLOW | 8 | success |
- Pearson r = 0.275 (weak) - scaling collapsed.
- Guard fired only 7/26 turns.
- BLITZ trail: b1,b1,b2,b2,b2 - the DM parked on beats despite heavy group action.
  This is the ORIGINAL "takes too much to move the story" bug returning.

## Conclusion
BEAT_STALL_MAX=2 is load-bearing, not over-aggressive. The guard is what keeps the
DM honest about forward progress; a longer leash lets the DM wander (slow groups got
MORE turns but LESS motion). Keep 2. Reverted the constant; unit tests 189/0.
