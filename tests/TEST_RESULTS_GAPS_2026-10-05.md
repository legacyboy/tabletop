# TEST RESULTS — gap-closing pass (2026-10-05, v2)

**Model:** `deepseek-v4.1-flash:cloud` (local Ollama) · **Live:** legacyboy.github.io/tabletop
**Commit:** pending push.

## Summary — all green

| Suite | Command | Result |
|---|---|---|
| Unit tests | `npm test` | **224 / 0** |
| Expanded regime (E1–E7) | `expanded-regime.mjs` | **43 / 43** |
| Endgame reachability | `endgame-drive.mjs` | **15 / 15** |
| Two-sided audit trail | `playability-audit.mjs` | **12 / 12** |
| Live-bundle proof (static) | `live-browser-budget.mjs` | **11 / 11** |
| Live-bundle proof (browser) | `live-browser-budget.mjs --browser` | **14 / 14** |

## Gaps found in the v1 plan (and now closed)

1. **No run to a conclusion.** Every live test stopped after N turns. → `G1`
   drives to WIN, LOSS (collapse), and TIMEOUT, asserting ending + report.
2. **Fate events never fired.** Sweeps dodged rolls 1/11/20. → `E6` forces each;
   all three narrate cleanly and the twist is recorded on the turn.
3. **Fix not proven on the live path.** Only unit-tested. → `G3` captures the
   real browser request against the deployed bundle.
4. **Adversarial input untested with a real model.** → `E7` (junk, injection,
   no-op) all return clean narratives.

## Notable evidence

**Endgame (G1)** — real model, played badly on purpose:
```
WIN       goal/success   "Crisis resolved: the deepfake is discredited..."
LOSS      loss           "The collapse: no correction ever lands..."  (ended turn 4)
TIMEOUT   timeout        "Time ran out on the scheduled exercise."
real run  loss/loss      final trust=0 reg=15
```

**Fate (E6)** — roll 1 twist recorded verbatim:
> "Your first response is a disaster - a rushed holding statement goes out with
> a line that reads like an insolvency admission..." (1249 chars, clean)

**Live bundle (G3)** — captured from the deployed Pages app:
```
opening request  → max_tokens=4096  (scene budget)
turn request     → max_tokens=8192  (the fix)   ✅
```
Static: deployed `dm.js` has `TURN_TOKENS=8192`, `SCENE_TOKENS=4096`,
`DM_NUM_CTX=16384`, and the `dm_prompt`/`dm_reply` audit capture; provider routes
Ollama to `/api/chat` and sends `num_ctx`+`num_predict`.

**Audit trail (G2)** — every turn logs both sides; e.g. turn 1:
player action + roll 4 → system prompt 17,241 chars + user 2,109 chars →
raw reply 1,103 chars → shown narrative 892 chars.

## Notes
- `dm-session.test.js` (mocked, 136 checks) already covered win/loss/streak/
  timeout/fate/beats/persistence at unit level — the gaps were in the **live**
  layer, not engine logic.
- Transient soft-fail on E1 (whistleblower opening, no terminal punctuation) in
  an earlier run did **not** reproduce; not a defect.
