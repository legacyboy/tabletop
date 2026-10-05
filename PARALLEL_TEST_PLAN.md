# PARALLEL TEST PLAN — Tabletop DM truncation fix

_2026-10-05. Dan tests live (GitHub Pages); Steve tests local (Ollama)._

## The bug

DM "starts replying and stops before the end of the paragraph."

**Root cause = output token budget, not the model.** The DM asks for a strict-JSON
turn: a 4-7 sentence narrative PLUS `state_delta`, `progress`, `reveal_stage`,
`contain_stage`, `beat`, `beat_quality`. That envelope measures **~700-1300
generated tokens** on a capable model — and a *reasoning* model (e.g. glm-5.3)
spends thousands more on internal thinking BEFORE it writes the answer.

The old caps were `maxTokens: 1200` (opening scene) and `1500` (turn). The model
hit that ceiling mid-sentence; `_extractJson` Strategy 4 silently recovered the
truncated prose, so the app showed a paragraph that stopped early instead of an
error. (Separately, Ollama's `/v1` endpoint ignores `num_ctx`, so the ~4.3k-token
DM system prompt was also being clipped to 4096 tokens for local models.)

## The fix (ported to the real repo `projects/tabletop/`)

- `app/js/dm.js` — named budgets: `SCENE_TOKENS = 4096`, `TURN_TOKENS = 8192`,
  `DM_NUM_CTX = 16384`. Provider-agnostic: the same `maxTokens` goes to EVERY
  provider (direct DeepSeek on Pages AND local Ollama).
- `app/js/providers/openai-compatible.js` — when the base URL is an Ollama host,
  route to Ollama's NATIVE `/api/chat` (honours `num_ctx`; `/v1` does not).
  Default `max_tokens` raised 800 -> 8192.
- `app/js/providers/server-proxy.js` — forwards `num_ctx` / `num_predict`.
- `server/api.js` — `NUM_CTX` env (default 16384).
- `scripts/run-local.sh` — local Ollama launcher.

**All 217 unit tests pass** (`npm test`).

## How the two of us test in parallel

### Dan — LIVE (GitHub Pages)
The live site is **identical to the upstream repo**, and Pages has **no server**,
so live uses the **direct browser -> API** path (DeepSeek preset). It CANNOT use
the local server proxy.

- **Wait for the fix to be pushed** before re-testing; live is stale until then.
- Re-test on live with the **DeepSeek preset** (api.deepseek.com). With the
  maxTokens bump, a full turn should now finish its paragraph.
- Optionally: if you open the live site **on the Kali box**, you can pick the
  "Server (local Ollama)" preset — I've now enabled `OLLAMA_ORIGINS` so the
  browser (origin legacyboy.github.io) can reach `localhost:11434`. Note this
  only works on the same machine as Ollama (localhost = the browser's device).

### Steve — LOCAL (Ollama)
```bash
cd /home/claw/.openclaw/workspace/projects/tabletop
bash scripts/run-local.sh deepseek-v4-flash:cloud   # or glm-5.3:cloud
# open http://localhost:8000
```
Verified locally: full turns now return ~1,200-1,460-char narratives, `done: stop`.

## Model notes from testing
- `deepseek-v4-pro:cloud` (reasoning): completes fine even at 1200 tok (it
  self-moderates thinking). Good default.
- `glm-5.3:cloud` (reasoning): WORST offender — at 2048 output tokens it returned
  EMPTY content (all 9170 chars went to thinking); needs 8192.
- `gemma3:4b` (local, non-reasoning): works at 8192 ctx, but ~5 tok/s on this
  CPU = 4-9 MINUTES per turn. Too slow for interactive testing; use a cloud model.
- `deepseek-v4-flash:cloud`: fast, good for iteration.

## Open question for Dan
Which model/preset were you on when it truncated live? If it was DeepSeek, the
maxTokens bump alone should fix it. If it was a reasoning model, same fix applies.
