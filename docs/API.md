# Tabletop HTTP API (curl-playable)

Run a full executive tabletop session from the command line. The server wraps
the same DM engine the web app uses, so you get the same open-ended LLM
adjudication, state tracking, fate table, and closing report — over HTTP.

## Start the server

```bash
npm start        # or: node server/serve.js [port]
```

Defaults to port 8000. The DM uses local Ollama by default; override per
request with `base_url`, `api_key`, `model` (or set `OLLAMA_URL`,
`OLLAMA_API_KEY`, `MODEL` env vars).

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/scenarios` | List available scenarios |
| GET | `/api/scenarios/:id` | Scenario intro + opening state |
| POST | `/api/session` | Create a session |
| GET | `/api/session/:id` | Session state + turn log |
| POST | `/api/session/:id/turn` | Take a turn (action + roll) |
| GET | `/api/session/:id/report` | Two-part audit report (full audit + proof of play) |
| POST | `/api/session/:id/report/email` | Generate the report and email it via Gmail |

## Play via curl

```bash
# 1. List scenarios
curl localhost:8000/api/scenarios

# 2. Create a session (local Ollama by default)
curl -X POST localhost:8000/api/session \
  -H 'Content-Type: application/json' \
  -d '{"scenario_id":"bramble_badger_deepfake"}'
# -> { "id": "s1", ... }

# 3. Take a turn — type any action, roll a D20 (1-20)
curl -X POST localhost:8000/api/session/s1/turn \
  -H 'Content-Type: application/json' \
  -d '{"action":"Issue a calm public statement and brief the board","roll":15}'
# -> { "turn":1, "narrative":"...", "state":{...}, "end_condition":null }

# 4. Check state / log
curl localhost:8000/api/session/s1

# 5. Two-part audit report (full audit + proof of play + recommendations)
curl localhost:8000/api/session/s1/report

# 6. Email the report (via Gmail SMTP)
curl -X POST localhost:8000/api/session/s1/report/email \
  -H 'Content-Type: application/json' \
  -d '{
    "participants":"Executive team",
    "moderator":"Facilitator",
    "recommendations":["Follow up on the regulator briefing"],
    "to":"legacyboy@gmail.com"
  }'
# -> { "message":"Report emailed", "fingerprint":"..." }
```

## The two-part report

The report endpoint returns a structured object with three sections:

- **Part 1 — Full Audit**: every action taken, every D20 roll, every DM
  decision/outcome, and the state after each turn, plus the final state.
- **Part 2 — Proof of Play**: scenario, participants, moderator, date,
  duration, turn count, fate events, end condition, and a **SHA-256
  fingerprint** of the full turn log so an auditor can verify the report
  wasn't altered.
- **Recommendations**: a free-form list (passed in on the email request, or
  empty).

The email endpoint renders this as a self-contained HTML report and sends it
directly via Gmail SMTP from the server (`server/gmail.js`, Node built-ins,
no external script). Configure the sender with `SMTP_USER` / `SMTP_PASS` env
vars (`SMTP_PASS` is required — a Gmail app password; never hardcode it).

## Using a hosted API key (e.g. DeepSeek)

```bash
curl -X POST localhost:8000/api/session \
  -H 'Content-Type: application/json' \
  -d '{
    "scenario_id":"bramble_badger_deepfake",
    "base_url":"https://api.deepseek.com/v1",
    "api_key":"sk-...",
    "model":"deepseek-chat"
  }'
```

## Request / response

**POST /api/session** body:
```json
{ "scenario_id": "bramble_badger_deepfake",
  "base_url": "http://localhost:11434/v1",   // optional
  "api_key": "",                              // optional
  "model": "gemma3:4b" }                      // optional
```

**POST /api/session/:id/turn** body:
```json
{ "action": "What the group decides to do", "roll": 15 }
```
`roll` must be an integer 1-20. The DM never proposes actions — it reacts to
what you type. A roll in the scenario's `fate_table` fires an authored twist.

## Notes

- Sessions are **persisted to disk** (`data/sessions/`) and survive server
  restarts. On startup the server restores any saved sessions.
- `DELETE /api/session/:id` removes a session (memory + disk).
- The DM is the same engine as the web app: state clamped 0-100, per-turn
  delta capped ±10, end conditions + timeout produce the report.
- See `scripts/play-tabletop.sh` for a ready-made interactive curl player.

## Hosting the API remotely ("API on GitHub")

GitHub Pages is static and **cannot** run the API server. To get a remote,
curl-playable API, deploy the Node server to a container host:

- **Render** (free tier): push this repo to GitHub, then in Render choose
  **New + → Blueprint → this repo**. It reads `render.yaml` and provisions the
  service. Set your LLM key in the Render dashboard.
- **Railway / Fly.io / Docker**: use the included `Dockerfile`.

Once deployed you get a URL like `https://tabletop-api.onrender.com` and can
play from anywhere:

```bash
curl -X POST https://tabletop-api.onrender.com/api/session \
  -H 'Content-Type: application/json' \
  -d '{"scenario_id":"bramble_badger_deepfake",
       "base_url":"https://api.deepseek.com/v1",
       "api_key":"***",
       "model":"deepseek-chat"}'
```

> The API is provider-flexible per request, so a hosted deployment works with
> any OpenAI-compatible key (DeepSeek/OpenAI/Anthropic). Local Ollama is only
> available when the server runs on the same machine as Ollama.
