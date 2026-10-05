# TEST RESULTS — limitation-closing pass (2026-10-05, v2.1)

**Model:** `deepseek-v4.1-flash:cloud` (local Ollama) · **Live:** legacyboy.github.io/tabletop

## The four limitations from v2 — now closed

| # | Limitation | Fix | Test | Result |
|---|---|---|---|---|
| L1 | No per-player attribution | `takeTurn(action, roll, player)`; `player` on the turn + audit + transcript; UI Player field; report `actions_by_player` | `playability-audit.mjs` | ✅ `{"Alice":2,"Bob":2,"Carol":2}` |
| L2 | No token/cost accounting | providers report usage via `onUsage` (Ollama `eval_count`, OpenAI `usage`); session totals + per-turn counts | `playability-audit.mjs` | ✅ 41,196 tokens / 7 calls, `estimated:false` |
| L3 | Concurrency untested | localStorage session snapshot per turn; reload → resume; two-tab active-tab lock | `concurrency-persistence.mjs` | ✅ 17/17 (incl. real-browser reload) |
| L4 | Settings migration only unit-tested | headless boot of the deployed app with a stale payload | `settings-migration.mjs` | ✅ 5/5 — **found+fixed a self-heal bug** |

## Suite results (local, this pass)

| Suite | Result |
|---|---|
| Unit (`npm test`) | **224 / 0** |
| Expanded regime (E1–E7) | **43 / 43** |
| Endgame drive | **15 / 15** |
| Playability + audit (L1/L2) | **16 / 16** |
| Concurrency / persistence (L3) | **17 / 17** |
| Live-bundle budget (browser) | **14 / 14** |
| Settings migration (L4) | **5 / 5** |

## Notable evidence

**L1/L2 — real Ollama run:**
```
turn 1 usage : {prompt_tokens: 4249, completion_tokens: 826, provider: ollama}
session      : prompt 29,747 · completion 11,449 · total 41,196 · 7 calls · estimated: false
by player    : {"Alice":2,"Bob":2,"Carol":2}
```

**L3 — refresh/resume in a real browser:** after one turn the snapshot is written
(`turn=1`); a hard reload auto-resumes into the play phase with the prior turn
still in the run log (`logLen=182`). Node-level: serialize→restore preserves
state, history, audit trail, player attribution, token usage, attack chain,
streaks, beats, budget; no already-fired event re-fires.

**L4 — self-heal bug found:** the retired-model-id migration was applied to the
in-memory settings object but **never written back**, so `localStorage` kept the
stale id until the user manually saved. Fixed: `loadSettings` now re-persists when
the migration changes anything. Verified by booting the deployed app with a stale
payload — the persisted model is now `deepseek-v4.1-flash:cloud` and no retired
id remains.

## Notes
- Browser suites run against a local static server pre-push, then re-verified on
  the deployed Pages bundle after push.
- Token accounting is provider-reported when available; falls back to a
  ~4-chars/token estimate (flagged `estimated: true`) so the audit always has a
  number.
