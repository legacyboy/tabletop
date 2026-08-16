# How to Build Additional Scenarios

Scenarios are JSON data, not code. A scenario defines:

- opening state
- decision points
- options
- D20 outcome tiers
- state changes
- candidate next beats
- end conditions

Each scenario is a standalone JSON file under `scenarios/<name>/scenario.json`,
listed in `scenarios/registry.json` (one line per scenario: id, title, path).

## Fast workflow (in-app)

1. Serve the folder: `python3 serve.py` and open `http://localhost:8000`.
2. Go to **Scenario editor**.
3. Select **Load current scenario** or **Load blank template**.
4. Edit the JSON.
5. Select **Validate**.
6. Select **Apply to session**.
7. Play-test.
8. Select **Download scenario JSON** when happy.

To make it permanent, save the file under `scenarios/<name>/scenario.json` and
add it to `scenarios/registry.json`.

## Important design rule

Do **not** build a fixed choose-your-own-adventure tree.

Use `next` as a candidate pool:

```json
"next": ["dp_02_media_pressure", "dp_02_branch_calls", "dp_02_board_question"]
```

The app chooses from the pool using current state, tags, and the D20 outcome tier.

## Recommended state variables

```json
"opening_state": {
  "budget": 70,
  "reputation": 65,
  "morale": 70,
  "risk": 35,
  "member_confidence": 68,
  "regulator_confidence": 60
}
```

All values are clamped from 0 to 100.

## Decision point pattern

```json
{
  "id": "dp_01_start",
  "prompt_seed": "The situation begins with incomplete information. What does the executive team do first?",
  "tags": ["governance", "complication"],
  "options": [
    {
      "id": "assemble_team",
      "label": "Assemble the cross-functional response team",
      "modifiers": { "risk": -3, "morale": 2 },
      "roll_modifier": 1,
      "flag": "response_team_assembled"
    }
  ],
  "outcomes": {
    "crit_fail": { "text": "The situation escalates.", "state_delta": { "risk": 12 } },
    "fail": { "text": "The action helps slightly, but coordination is weak.", "state_delta": { "risk": 6 } },
    "mixed": { "text": "Progress, but a new complication appears.", "state_delta": { "risk": 4 } },
    "success": { "text": "The team aligns on ownership.", "state_delta": { "risk": -5 } },
    "crit_success": { "text": "The team gets ahead of the story.", "state_delta": { "risk": -9 } }
  },
  "next": ["dp_02_pressure"]
}
```

## Useful tags

- `media`
- `member`
- `governance`
- `escalation`
- `complication`
- `operations`
- `vendor`
- `fraud`
- `privacy`
- `legal`

## Suggested 60-minute structure

| Time | Activity |
|---:|---|
| 0-5 | Rules and roles |
| 5-10 | Opening inject/video |
| 10-20 | Decision 1 and roll |
| 20-35 | Decision 2 and roll |
| 35-50 | Decision 3 and roll |
| 50-60 | Hotwash and owners |

## Publishing a new scenario

1. Save the scenario JSON as `scenarios/<name>/scenario.json`.
2. Add an entry to `scenarios/registry.json`:

```json
{ "id": "my_scenario", "title": "My Scenario", "path": "scenarios/<name>/scenario.json" }
```

3. The app discovers it at startup and it appears in the **Play** tab scenario selector.
