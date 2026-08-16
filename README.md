# Executive Tabletop D20

Open-ended executive tabletop simulations run by an **LLM dungeon master (DM)**.

The group picks a scenario, watches an intro, then types **any action they want**
into a free-text box and rolls a D20. The DM (an LLM) adjudicates their action
against the scenario, updates tracked state (budget, reputation, morale, risk…),
and the world responds. **The DM never proposes actions or leads the group** —
it reacts only to what the group actually decides. A timer runs the session and
ends it on an end condition or timeout, producing an audit-ready report.

## The flow

1. **Select** a scenario
2. **Intro** — intro video (optional) + narrative read/displayed by the moderator
3. **Play** — the group types an action, rolls a D20
4. **DM adjudicates** — returns a narrative + state changes
5. **Timer** running; ends on end-condition or timeout
6. **Report** — closing summary for debrief / audit

## Run it

The core app is browser-side (ES modules), so it needs a tiny server to load
(no server-side LLM logic required).

```bash
npm install      # optional — only for local dev convenience
npm start        # or: node server/serve.js
```

Open http://localhost:8000.

### Choosing a DM

Open **⚙ DM / Keys**. Pick one:

- **In-browser model (WebLLM)** — portable, standalone, offline. Runs a small
  Gemma/Llama model in the browser via WebGPU. Requires a WebGPU-capable
  browser (current Chrome/Edge). Model downloads once (~1-2 GB).
- **API key** — OpenAI, DeepSeek, Anthropic (OpenAI-compatible), or any
  custom OpenAI-compatible endpoint — including a **local Ollama** for a fast
  free Gemma. Keys are stored in the browser (localStorage) and sent only to
  the chosen provider.

> Free local Gemma via Ollama: run `OLLAMA_ORIGINS=* ollama serve`, then set
> Base URL to `http://localhost:11434/v1` and model `gemma3:4b`.

## Layout

```
index.html                Entry point
app/js/
  dm.js                   DM session loop (state, fate table, timer, report)
  scenarios.js            Scenario loading + company-info enrichment
  main.js                 Play UI
  settings.js             DM provider / API key UI
  providers/              Pluggable LLM adapters
    registry.js           Provider selection + setting persistence
    openai-compatible.js  OpenAI / DeepSeek / Anthropic / Ollama
    webllm.js             In-browser model (portable)
server/
  serve.js                Static server + optional /api/company proxy
scenarios/
  registry.json           Available scenarios
  <scenario>/scenario.json   v2 scenario (dir per scenario)
assets/                   Media
docs/
  SCENARIO_SCHEMA_v2.md   Full scenario schema
  HOW_TO_BUILD_A_SCENARIO.md
tests/                    Mock-provider + integration + real-LLM smoke tests
```

## Scenarios are loose, not scripts

A v2 scenario gives the DM a **brief** (situation, stakes, key actors, optional
pressure points to inject when the group stalls), an **opening state**, a
**fate table** of dice numbers that trigger authored twists (e.g. "an 11 means
the building catches fire"), and **end conditions**. It does not constrain the
group to options — the DM improvises within the world you define. A scenario
may also carry a `company_url`; the app best-effort fetches public info about
the organization to enrich the DM's context.

To add a scenario: drop a `scenarios/<name>/scenario.json` file and add one
line to `scenarios/registry.json`. See `docs/SCENARIO_SCHEMA_v2.md`.

## Testing

```bash
node tests/dm-session.test.js        # DM loop logic (mock provider)
node tests/dm-integration.test.js    # real HTTP path via a mock LLM server
node tests/dm-real-ollama.smoke.js   # one real turn against local Ollama
```
