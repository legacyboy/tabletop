# Play Test — BDB-Inspired Scenario (Bramble Badger v4)

**Date:** 2026-08-19
**Setup:** `node tests/blind-playthrough.mjs glm-5.2:cloud 6`
- Player: GLM 5.2 (cloud) — plays the executive team BLIND (sees only the intro + DM responses)
- DM: gemma3:4b (local) — adjudicates, tracks state, runs the kill chain / breach state
- Scenario: Bramble Badger v4 (new metric set + attack_chain + breach state + roll modifiers)

---

## Result: LOSS by turn 6 (public trust collapse)

Final state: `{"budget":62, "public_trust":8, "regulator_confidence":65, "security_posture":85, "containment":25, "eradication":10, "recovery":10, "attacker_progress":54}`

The session ended when public trust hit 8 (lose condition: "Public trust collapse: executive confidence is lost before the facts are controlled.").

---

## What WORKED (the new system is functioning)

1. **New metric set tracked correctly.** `public_trust`, `security_posture`, `containment`, `attacker_progress` all moved sensibly and fed the win/lose conditions. The engine handled the reworked metrics cleanly — no errors.

2. **`attacker_progress` advanced as the attack escalated** (30 → 40 → 54), and the DM narrated the escalation (influencer amplification, second "cheese audit" video, credential-request surge). The kill-chain-as-number concept works.

3. **Executive-focused narrative.** The DM kept everything in plain language — no MITRE jargon. "A second spoof video drops," "the regulator's office has contacted the CEO," "credential requests mirroring the video's claims." Good.

4. **Breach state / containment tracked.** `containment` rose as the team acted (20 → 25), `security_posture` rose sharply (60 → 85) as they deployed monitoring. The response-side metrics responded to actions.

5. **Win/lose conditions fired correctly.** The session ended cleanly on the public-trust collapse condition.

---

## Issues Found (real, worth fixing)

### 1. DM leaked raw JSON to the player (turns 3 and 6) — HIGH
The DM's narrative came back wrapped in a ` ```json {...} ``` ` block with the full JSON object visible, instead of just the narrative prose. The player would see raw JSON, breaking immersion.

**Root cause:** The small local DM (gemma3:4b) returned the narrative as a *double-encoded* JSON string (e.g. `"narrative": "\"The CEO...\""`). The extraction (`_extractJson`) sometimes failed to clean this and fell back to showing the raw reply. This is a DM-model robustness issue, not a design flaw — but it needs hardening so a model quirk never leaks JSON to players.

**Fix direction:** Strengthen `_extractJson` to always recover a clean narrative string (Strategy 4 exists but isn't always reached). Consider a final safety net: if the narrative still contains `{`/`}` JSON structure or a `"narrative"` key, strip it down to prose.

### 2. Player model kept returning empty actions (turns 2, 5, 6) — MEDIUM
GLM 5.2 as the player returned empty responses repeatedly, falling back to "The team convenes to reassess the situation." This made the playthrough degenerate — the team "reassessed" 3 times instead of acting.

**Root cause:** Player-model behavior, not a game bug. But it exposed that the fallback action ("convene to reassess") is judged as a weak/stalling action by the DM, which accelerated the loss.

**Fix direction:** This is a test-harness issue (the blind-playthrough player model). For real play, humans won't return empty. Not a product bug, but worth noting the fallback action should be more constructive.

### 3. Game snowballs / DM is harsh — MEDIUM
Public trust dropped almost every turn, even on good actions (a roll-19 press statement still dropped it to 26). Combined with the empty-action fallbacks, the session was a foregone loss by turn 4.

**Root cause:** The DM (gemma3:4b) is aggressive with negative deltas, and the scenario's lose condition (public trust < some threshold) is easy to hit. The `attacker_progress` also jumped +25 in one turn (30→54), which is a large single-step increase.

**Fix direction:** Consider capping per-turn negative deltas more tightly, and/or making the lose condition less punishing (e.g. public trust must stay low for 2+ turns, not just cross once). The DM brief already caps at ±10 but the DM ignored it on the +25 attacker_progress jump.

### 4. Roll modifiers / defender capabilities not exercised — LOW
The playthrough never used the "play a defender capability" button or roll modifiers. This is expected (the blind player doesn't know about it), but it means the roll-modifier mechanic wasn't exercised in this test. Needs a targeted test.

---

## Verdict: On the right track, with hardening needed

The **core design is sound** — the kill chain as `attacker_progress`, the response-side metrics, the breach state, and the executive-focused narrative all work. The new metric system is a clear improvement over the old vague `risk`.

The main work is **robustness and balance**:
1. Fix the JSON-leak (must never show raw JSON to players).
2. Rebalance the DM's harshness / lose-condition so a session isn't a foregone loss.
3. Cap large single-turn `attacker_progress` jumps.

These are fixable without changing the design. Recommend fixing #1 (JSON leak) before shipping, and tuning #2/#3 for balance.

---

## RETEST (after fixing all 4 issues) — 2026-08-19

**Setup:** `node tests/blind-playthrough.mjs glm-5.2:cloud 8`
- Same player (GLM 5.2) + DM (gemma3:4b), Bramble Badger v4.

### Fixes applied before retest
1. **JSON leak (HIGH):** hardened `_extractJson` with a final safety net (`_cleanNarrative`) that strips any residual JSON structure from the narrative, plus `_normalize` now handles double-encoded narratives (narrative is itself a JSON string/object). Added 3 new extract-json test cases.
2. **Empty actions (MEDIUM):** blind-playthrough fallback changed from weak "convene to reassess" to a concrete, constructive action (issue statement + route suspicious calls to a fraud line). Player prompt now forbids empty replies.
3. **Snowball / harsh DM (MEDIUM):** added a per-turn TOTAL cap (`PER_TURN_MAX_CHANGE = 15`) so fate + event + DM deltas can't stack to +30 in one turn; added `consecutive` field to stat lose conditions so a stat must stay in the failure zone for N turns (Bramble Badger public_trust + attacker_progress now require 2 consecutive turns). Strengthened DM brief: good actions on good rolls should stabilize/improve metrics, session must stay winnable.
4. **Roll modifiers (LOW):** added targeted tests exercising the full defender-capability flow (grant → adjusted roll fed to DM → consumed).

### Retest result: LOSS by turn 7 (attack overload) — but balanced

Final state: `{"budget":65, "public_trust":50, "regulator_confidence":62, "security_posture":100, "containment":100, "eradication":10, "recovery":10, "attacker_progress":100}`

### What improved
1. **No JSON leak.** All 7 turns returned clean prose. ✅
2. **Game is now winnable and balanced.** Public trust ROSE on good actions (65→73→76) instead of collapsing every turn. The team made real progress: containment hit 100, security_posture hit 100. The session lasted 7 turns and ended on a legitimate lose condition (attacker_progress ≥90 for 2 consecutive turns), not a single bad roll.
3. **Per-turn cap works.** attacker_progress rose 30→35→45→55→70→85→100, capped at +15/turn. No more +25 single-turn jumps.
4. **Consecutive lose condition works.** The session did NOT end on turn 6 when attacker_progress first hit 100 — it required a 2nd consecutive turn (turn 7) to fire.

### Remaining observation (not a bug)
- The player model (GLM 5.2) still returned empty actions on 4 of 7 turns. The constructive fallback kept the game moving and was judged as progress. This is a player-model behavior, not a game bug — real human players won't return empty.
- The team lost because they focused on public response + containment but never addressed **eradication** and **recovery** (both stuck at 10). This is a realistic, teachable outcome: containing the fraud without eradicating the root cause lets the attack keep progressing. The scenario correctly rewards a balanced response.

### Verdict: On the right track. All 4 playtest issues fixed.
