# How to Build a Scenario (v2)

v2 scenarios are **loose, DM-driven** — they give the dungeon master a world
and stakes, not a rigid script. The group takes any action they want; the DM
(an LLM) improvises the consequences within your brief, modifies tracked
state, and moves the story. Your job as the author is to set the stage and the
rails, then let the DM drive.

Each scenario is one JSON file under `scenarios/<name>/scenario.json`, listed
in `scenarios/registry.json`. See `SCENARIO_SCHEMA_v2.md` for the full
reference. Start from `scenarios/templates/blank-scenario-template.json`.

## Fast workflow

1. Copy `scenarios/templates/blank-scenario-template.json` to
   `scenarios/<name>/scenario.json`.
2. Fill in the intro, opening state, DM brief, fate table, and end conditions.
3. Add one line to `scenarios/registry.json`:
   `{ "id": "...", "title": "...", "path": "scenarios/<name>/scenario.json" }`
4. Run `npm start`, open the app, and play-test.
5. Iterate on the DM brief — the better the brief, the better the DM.

## The key parts

### Intro
`intro.narrative` is shown/read to the group to set the scene. `intro.video`
(optional) is a file path under `assets/` or a scenario `media/` dir.
`intro.facilitator_notes` is moderator-only. `intro.company_url` (optional)
lets the app fetch public company info to enrich the DM context.

### Opening state
Tracked metrics, all 0-100. The DM updates these each turn; they make the
session consequential and feed end conditions. Typical set: budget,
reputation, morale, risk, plus scenario-specific ones.

### DM brief (`dm_brief`)
The heart. Give the DM:
- `situation` — the world + current problem
- `stakes` — what is lost on failure
- `key_actors` — who is involved, their interests and knowledge
- `pressure_points` — events the DM MAY inject if the group stalls (keeps tension)
- `rules_of_play` — constraints, e.g. "never propose actions", "only tracked metrics may change"

The **stronger the brief, the better the open-ended play.** Write the situation
with enough texture for the DM to improvise consistently.

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

### End conditions
End the session when a stat crosses a threshold, or on timeout:

```json
"end_conditions": [
  { "type": "stat", "stat": "risk", "operator": "gte", "value": 90, "ending": "Risk overload: full enterprise incident." },
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
| 5-10 | Select scenario, intro video + narrative |
| 10-15 | Group discusses the opening, first action |
| 15-55 | Free-form play: act, roll, DM adjudicates (timer running) |
| 55-60 | Hotwash + close (report generated) |
