# How to Build a Scenario

v3 scenarios are **loose, DM-driven** — they give the dungeon master a world
and stakes, not a rigid script. The group takes any action they want; the DM
(an LLM) improvises the consequences within your brief, modifies tracked
state, and moves the story. Your job as the author is to set the stage and the
rails, then let the DM drive.

Each scenario is one JSON file under `scenarios/<name>/scenario.json`, listed
in `scenarios/registry.json`. See [[Scenario Schema v3]] for the full
reference. Start from `scenarios/templates/blank-scenario-template.json`.

## Fast workflow

1. Copy `scenarios/templates/blank-scenario-template.json` to
   `scenarios/<name>/scenario.json`.
2. Fill in the intro, opening state, DM brief, conditional events, fate table,
   story beats (an ordered arc so the story keeps moving), and end conditions.
3. Add one line to `scenarios/registry.json`:
   `{ "id": "...", "title": "...", "path": "scenarios/<name>/scenario.json" }`
4. Run `npm start`, open the app, and play-test.
5. Iterate on the DM brief — the better the brief, the better the DM.

## The key parts

### Intro (text-first case introduction)
`intro.narrative` is the case introduction — the PRIMARY thing shown to all
participants (there is no human facilitator; the DM is the LLM). `intro.video`
(optional) is a file path under `assets/` or a scenario `media/` dir.
`intro.company_url` (optional) lets the app fetch public company info to enrich
the DM context.

### Opening state
Tracked metrics, all 0-100. The DM updates these each turn; they make the
session consequential and feed end conditions. Typical set: budget,
reputation, morale, risk, plus scenario-specific ones.

### DM brief (`dm_brief`)
The heart. Give the DM:
- `situation` — the world + current problem
- `stakes` — what is lost on failure
- `key_actors` — who is involved, their interests and knowledge
- `pressure_points` — (optional, backward-compatible) events the DM MAY inject
  if the group stalls; prefer the top-level `events` array below
- `rules_of_play` — constraints, e.g. "never propose actions", "only tracked metrics may change"

The **stronger the brief, the better the open-ended play.** Write the situation
with enough texture for the DM to improvise consistently.

### Conditional events (`events`)
Pre-compiled events that fire **at most once per session** when their
conditional trigger is met. This replaces the old loose `pressure_points`
stall-injection with structured, once-per-session events. When an event
fires, the engine applies its `state_delta` and tells the DM to weave its
`text` into the narrative.

```json
"events": [
  {
    "id": "e1",
    "trigger": { "type": "stall", "turns": 2 },
    "text": "A second spoof video drops, claiming accounts are frozen for a 'cheese audit'.",
    "state_delta": { "member_confidence": -6, "risk": 8 }
  },
  {
    "id": "e2",
    "trigger": { "type": "stat", "stat": "risk", "operator": "gte", "value": 60 },
    "text": "The regulator's office calls asking for a factual summary.",
    "state_delta": { "regulator_confidence": -5 }
  }
]
```

Trigger types:
- `{ "type": "stall", "turns": N }` — fires after N consecutive turns the
  DM judged as no meaningful progress (the DM's per-turn `progress` judgment,
  not action text length).
- `{ "type": "stat", "stat": "<name>", "operator": "gte"|"lte", "value": N }` —
  fires when the stat crosses the threshold.
- `{ "type": "turn", "turn": N }` — fires on a specific turn number (optional;
  stall/stat are the primary conditional triggers).

### Fate table
Optional. Maps specific D20 rolls to **authored twists** that fire regardless
of the free-form action:

```json
"fate_table": {
  "1":  { "kind": "crit_fail",    "twist": "Roll 1 catastrophe.",     "state_delta": { "morale": -8, "risk": 10 } },
  "11": { "kind": "twist",        "twist": "The building catches fire.", "state_delta": { "budget": -15, "risk": 8 } },
  "20": { "kind": "crit_success", "twist": "Roll 20 outstanding win.", "state_delta": { "reputation": 8 } }
}
```

Numbers not listed are adjudicated purely by the DM. Use the fate table for
flavorful, authored moments ("an 11 means X") on top of the DM's open judgment.

### Story beats (optional ordered arc)

Add a `beats` array to give the scenario a **sequence of steps** so the story
keeps moving instead of stalling into "act → react → dead end". Each beat has
an `id`, a `name`, and a `narrative` (what the group faces and must resolve
this step). The DM advances to the next beat when the group resolves the
current one; a group that handled a beat **well** finds the next step **softer**,
one that handled it **poorly** finds it **worse**, and a decisive action can
**skip** forward. See Scenario-Schema-v3.md for the full spec.

### Goal (win condition) — OPTIONAL

The `goal` object is **optional**. It defines the win condition for exercises
that have a concrete objective. It is used by the engine to end the session in
success when all `win_conditions` are met simultaneously (or when all
attack-chain stages are contained), and it lives in the DM's private brief. It
is **never shown to players** in the UI.

**Two modes — pick based on the exercise type:**

- **IT / kill-chain exercise (use a `goal`).** A concrete objective exists —
  find and kill the threat, contain all attack-chain stages, restore the
  system. The group "wins" when they hit the thresholds or contain all stages.
- **Executive / fallout exercise (omit `goal`).** No discrete thing to "win"
  against — a data leak, PR scandal, or regulatory probe is *fallout you
  manage*. Omit `goal`; the session runs to a lose condition or timeout, and
  the closing report is the debrief (final metrics + contained vs missed
  stages). No artificial "you hit 80, you win" bell.

If you include a `goal`, the win condition should reference `attacker_progress`
+ containment / eradication / recovery (the BDB-style "contain all stages"
objective).

```json
"goal": {
  "description": "Contain the attack chain and restore trust.",
  "win_conditions": [
    { "stat": "public_trust", "operator": "gte", "value": 60 },
    { "stat": "containment", "operator": "gte", "value": 80 },
    { "stat": "eradication", "operator": "gte", "value": 70 },
    { "stat": "recovery", "operator": "gte", "value": 60 },
    { "stat": "attacker_progress", "operator": "lte", "value": 20 }
  ],
  "ending": "Crisis resolved: the attack chain is contained and trust restored."
}
```

### Roll modifiers (defender capabilities)
The group can "play" a defender capability (spend budget) to get a +2/+3 on
the next D20 roll. The engine tracks a `rollModifier` in the session. The DM
brief explains this mechanic. The modifier **nudges** the roll — it does not
replace the DM's judgment.

### Breach state
A discrete breach ladder (`contained → active → escalated → exfiltrated`) the
DM narrates as the attack chain progresses. It is derived from the attack chain
and is more legible to executives than an abstract number.

### Random mode
A registry entry with `"random": true` (or `id: "random"`) has **no
pre-authored scenario.json**. When selected, the DM generates the scenario on
the fly from a generic prompt. Keep it executive-focused — the DM should
generate an appropriate executive tabletop scenario (security, reputation,
operational, etc.).

### End conditions
End the session when a stat crosses a threshold, or on timeout:

```json
"end_conditions": [
  { "type": "stat", "stat": "attacker_progress", "operator": "gte", "value": 90, "ending": "Attack overload: full enterprise incident." },
  { "type": "timeout", "duration_seconds": 3600, "ending": "Time ran out." }
]
```

### Report
Optional `title_note` and `audit_note` added to the closing report the app
produces at session end or timeout — useful for tabletop debrief and audit.

## Suggested 60-minute structure

| Time | Activity |
|---:|---|
| 0-5 | Rules and roles |
| 5-10 | Select scenario, case introduction (narrative + optional video) |
| 10-15 | Group discusses the opening, first action |
| 15-55 | Free-form play: act, roll, DM adjudicates (timer running) |
| 55-60 | Hotwash + close (report generated) |
