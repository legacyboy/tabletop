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

## Hosting

### GitHub Pages (works with API keys)

The app is a static site and deploys to GitHub Pages automatically (see
`.github/workflows/pages.yml`). Once enabled, it's live at
`https://legacyboy.github.io/tabletop/` and works with any API-key provider
(DeepSeek, OpenAI, Anthropic) directly from the browser. The in-browser model
and local Ollama are not available on Pages (no WebGPU / no local runner), but
API keys work fine.

> The GitHub **wiki** is static Markdown and cannot run the app — use it for
> scenario docs and guides. The interactive app lives on Pages.

### Fully-offline portable bundle

For a standalone, offline app (in-browser model, no server, no network):

```bash
bash scripts/vendor-offline.sh   # downloads WebLLM + Gemma 3 1B (~590 MB) into vendor/
```

Then open the app and choose **In-browser model (WebLLM)** in DM/Keys. The app
detects `vendor/` and loads the model from local files. Requires a WebGPU
browser (Chrome/Edge). The vendored files are git-ignored (large binaries);
re-run the script on each machine.

## Choosing a DM

Open **⚙ DM / Keys**. Pick one:

- **In-browser model (WebLLM)** — portable, standalone, offline. Runs a small
  Gemma/Llama model in the browser via WebGPU. Requires a WebGPU-capable
  browser (current Chrome/Edge). Model downloads once (~1-2 GB). The bundled
  model is **Gemma 3 1B** (`gemma3-1b-it-q4f16_1-MLC`) — the only Gemma 3
  available in WebLLM. (The 4B Gemma is not in WebLLM's supported set; use
  the Server (local) path with Ollama's `gemma3:4b` if you need a bigger
  model.)
- **Server (local)** — the DM runs on the **server box** (e.g. a local Ollama
  on the same machine as the app server). The browser talks to the server's
  `/api/dm` proxy, and the server calls the LLM. This is the right choice
  when the app is served on your network: remote clients only need to reach
  the server, not the LLM. No Ollama network exposure required.
- **API key** — OpenAI, DeepSeek, Anthropic (OpenAI-compatible), or any
  custom OpenAI-compatible endpoint. Keys are stored in the browser
  (localStorage) and sent only to the chosen provider.

> Free local Gemma via Ollama: run `OLLAMA_ORIGINS=* ollama serve`, then set
> Base URL to `http://localhost:11434/v1` and model `gemma3:4b`. For the
> **Server (local)** option, Ollama only needs to be reachable from the server
> (localhost is fine) — remote clients go through the server proxy.

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
  SCENARIO_SCHEMA_v2.md   Full scenario schema reference
tests/                    Mock-provider + integration + real-LLM smoke tests
```

## How to build a scenario

Scenarios are **loose, DM-driven** — they give the dungeon master a world and
stakes, not a rigid script. The group takes any action they want; the DM (an
LLM) improvises the consequences within your brief, modifies tracked state,
and moves the story. Your job as the author is to set the stage and the rails,
then let the DM drive.

Each scenario is one JSON file under `scenarios/<name>/scenario.json`, listed
in `scenarios/registry.json`. See `docs/SCENARIO_SCHEMA_v2.md` for the full
reference. Start from `scenarios/templates/blank-scenario-template.json`.

### Fast workflow

1. Copy `scenarios/templates/blank-scenario-template.json` to
   `scenarios/<name>/scenario.json`.
2. Fill in the intro, opening state, DM brief, fate table, **goal** (win
   condition), and end conditions (lose conditions).
3. Add one line to `scenarios/registry.json`:
   `{ "id": "...", "title": "...", "path": "scenarios/<name>/scenario.json" }`
4. Run `npm start`, open the app, and play-test.
5. Iterate on the DM brief — the better the brief, the better the DM.

### The key parts

**Intro** — `intro.narrative` is shown/read to the group to set the scene.
`intro.video` (optional) is a file path under `assets/` or a scenario
`media/` dir. `intro.facilitator_notes` is moderator-only. `intro.company_url`
(optional) lets the app fetch public company info to enrich the DM context.

**Opening state** — tracked metrics, all 0-100. The DM updates these each
turn; they make the session consequential and feed end conditions. Typical
set: budget, reputation, morale, risk, plus scenario-specific ones.

**DM brief (`dm_brief`)** — the heart. Give the DM:
- `situation` — the world + current problem
- `stakes` — what is lost on failure
- `key_actors` — who is involved, their interests and knowledge
- `pressure_points` — events the DM MAY inject if the group stalls (keeps tension)
- `rules_of_play` — constraints, e.g. "never propose actions", "only tracked metrics may change"

The **stronger the brief, the better the open-ended play.** Write the situation
with enough texture for the DM to improvise consistently.

**Fate table** — optional. Maps specific D20 rolls to **authored twists** that
fire regardless of the free-form action:

```json
"fate_table": {
  "1":  { "kind": "crit_fail",    "twist": "Roll 1 catastrophe.",     "state_delta": { "morale": -8, "risk": 10 } },
  "11": { "kind": "twist",        "twist": "The building catches fire.", "state_delta": { "budget": -15, "risk": 8 } },
  "20": { "kind": "crit_success", "twist": "Roll 20 outstanding win.", "state_delta": { "reputation": 8 } }
}
```

Numbers not listed are adjudicated purely by the DM. Use the fate table for
flavorful, authored moments ("an 11 means X") on top of the DM's open judgment.

**Goal (win condition)** — the **objective the group is trying to achieve**.
When ALL `win_conditions` are met **simultaneously**, the scenario ends in
**success** — the group has resolved the situation. This is what makes a
session feel like it has a point: the group works toward a concrete outcome,
not just a timer.

```json
"goal": {
  "description": "Restore trust and deflate the crisis.",
  "win_conditions": [
    { "stat": "reputation", "operator": "gte", "value": 60 },
    { "stat": "member_confidence", "operator": "gte", "value": 60 },
    { "stat": "risk", "operator": "lte", "value": 45 }
  ],
  "ending": "Crisis resolved: trust restored. The exercise concludes."
}
```

- `win_conditions` is a list of stat thresholds. **All** must be true at once
  for the goal to fire — partial progress does not end the session.
- `operator` is `gte` (stat must be at/above value) or `lte` (at/below).
- `ending` is the success message shown when the goal is met.
- A good goal is **hard but reachable**: it should take a competent group
  several turns of sensible play to hit, and a careless group should struggle
  to reach it.

**End conditions (lose conditions)** — end the session in **failure** when a
stat crosses a threshold, or on timeout. These are the ways the group can
*lose* — the mirror of the goal:

```json
"end_conditions": [
  { "type": "stat", "stat": "risk", "operator": "gte", "value": 90, "ending": "Risk overload: full enterprise incident." },
  { "type": "timeout", "duration_seconds": 3600, "ending": "Time ran out." }
]
```

The session ends when **either** the goal is met (success) **or** a lose
condition fires (failure) **or** the timeout hits. Set lose thresholds so a
bad group can collapse, and a timeout as the hard ceiling for the exercise.

**Report** — optional `title_note` and `audit_note` added to the closing
report the app produces at session end or timeout — useful for tabletop
debrief and audit.

### Suggested 60-minute structure

| Time | Activity |
|---:|---|
| 0-5 | Rules and roles |
| 5-10 | Select scenario, intro video + narrative |
| 10-15 | Group discusses the opening, first action |
| 15-55 | Free-form play: act, roll, DM adjudicates (timer running) |
| 55-60 | Hotwash + close (report generated) |

## Testing

```bash
node tests/dm-session.test.js        # DM loop logic (mock provider)
node tests/dm-integration.test.js    # real HTTP path via a mock LLM server
node tests/dm-real-ollama.smoke.js   # one real turn against local Ollama
```
