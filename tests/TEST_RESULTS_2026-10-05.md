# TEST RESULTS — Tabletop DM truncation fix (2026-10-05)

Model under test: **`deepseek-v4.1-flash:cloud`** (via local Ollama), plus cross-model checks.
Commit: `6689a62` (pushed to main, live on legacyboy.github.io/tabletop).

## Summary

| Test | What | Result |
|---|---|---|
| T1 | Unit test suite | **223 passed, 0 failed** |
| T2 | Single-turn truncation (native + /v1 routes) | **2/2 PASS** |
| T3 | Multi-turn sessions (3 runs x 7 turns) | **PASS, 0 truncated** |
| T4 | 7-turn detailed run | **PASS, all 7 turns clean** |
| T5 | All 5 scenarios | **5/5 PASS** |
| T6 | Cross-model regression (glm-5.3, deepseek-pro) | **4/4 PASS** |

## Detail

### T1 — Unit tests
`npm test`: dm-session 149, dm-integration 6, extract-json 12, presets 56 => **223 pass**.

### T2 — Truncation check
Deepfake scenario, one multi-action turn, roll 15.
- Native Ollama (our fix): 1,109 chars, ends clean, no JSON leak.
- `/v1` route: 1,146 chars, ends clean, no JSON leak.
Both PASS.

### T3 — Multi-turn (3 runs x 7 turns = 21 turns)
Three different team strategies. Every turn produced a complete narrative.
State arcs differ sensibly by strategy (full-arc run ended trust=82/reg=76;
weak-holding-statement run ended trust=59/reg=67). Zero truncation.

### T4 — 7-turn detailed
Read all 7 narratives: coherent, each ends on terminal punctuation, each
introduces a NEW in-world development (spoofed hotline calls, regulator
deadline, platform takedown, agency console trace). Exactly the intended
behavior. No cut-offs.

### T5 — All scenarios
bramble_badger_deepfake, toxic_workplace_viral_post, rogue_ai, whistleblower,
executive_scandal => 5/5 PASS. Narrative lengths 750–1,724 chars, all clean.

### T6 — Cross-model regression
- `glm-5.3:cloud` (the WORST offender — previously returned EMPTY content):
  now 1,215 / 1,355 chars, both PASS.
- `deepseek-v4-pro:cloud`: 868 / 797 chars, both PASS.

## Findings / issues discovered during testing

### 🔴 `deepseek-v4-flash:cloud` is RETIRED (2026-09-25)
The Ollama cloud alias `deepseek-v4-flash:cloud` maps to `deepseek-v4-flash:0731`,
which was **retired 2026-09-25** (410 Gone). Any test/preset using that exact
`:cloud` id on the Ollama path now fails hard.

- **Live site (Dan's path) is UNAFFECTED**: it uses the DIRECT DeepSeek API with
  id `deepseek-v4-flash` (no `:cloud`), which is still live at api.deepseek.com.
- **Ollama-routed path IS affected**: must use **`deepseek-v4.1-flash:cloud`**
  (the current Flash) instead. `deepseek-v3.2:cloud` is also retired.

**Recommendation:** update the `OLLAMA_MODELS` list + server default + presets in
`registry.js`/`api.js` to `deepseek-v4.1-flash:cloud`, and refresh `presets.test.js`
expectations. (Not yet done — flagged for approval since it touches a preset default.)

## Verdict
The truncation fix is **verified working** across routes, models, multi-turn
sessions, and all scenarios. The only outstanding item is the retired
`deepseek-v4-flash:cloud` alias on the Ollama path.
