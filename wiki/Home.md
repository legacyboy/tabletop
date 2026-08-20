# Executive Tabletop D20

Open-ended executive tabletop simulations run by an **LLM dungeon master (DM)**.

The group picks a scenario, watches an intro, then types **any action they want**
into a free-text box and rolls a D20. The DM (an LLM) adjudicates their action
against the scenario, updates tracked state (budget, reputation, morale, risk…),
and the world responds. **The DM never proposes actions or leads the group** —
it reacts only to what the group actually decides. A timer runs the session and
ends it on an end condition or timeout, producing an audit-ready report.

## Play it

The live app is at **https://legacyboy.github.io/tabletop/** (works with an
API key such as DeepSeek, OpenAI, or Anthropic).

## The flow

1. **Select** a scenario
2. **Intro** — intro video (optional) + narrative read/displayed by the moderator
3. **Play** — the group types an action, rolls a D20
4. **DM adjudicates** — returns a narrative + state changes
5. **Timer** running; ends on end-condition or timeout
6. **Report** — closing summary for debrief / audit

## Pages

- [[How to Build a Scenario]] — authoring guide
- [[Scenario Schema v2]] — the full scenario format
- [[Bramble Badger Deepfake Crisis]] — the bundled example scenario

## Choosing a DM

- **API key** — OpenAI, DeepSeek, Anthropic, or any OpenAI-compatible endpoint,
  including a local Ollama for a fast free Gemma.
- **Server (local)** — the DM runs on the server box via the `/api/dm` proxy
  (e.g. a local Ollama the browser can't reach directly).

> The GitHub **wiki** is static documentation. The interactive app runs on
> **GitHub Pages** or locally — both use API keys; there is no in-browser model.
