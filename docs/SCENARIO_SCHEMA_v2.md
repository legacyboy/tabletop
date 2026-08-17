# Scenario Schema v2 (Open-Ended DM Tabletop)

v2 changes the model fundamentally. v1 was a **fixed decision tree**: players
picked from authored options and the engine chose the outcome tier by D20.

v2 is an **open-ended session run by an LLM dungeon master (DM)**. Players
type *any* action into a free-text box, roll a D20, and the DM adjudicates the
action + roll against the scenario context. The scenario file is *inspiration
and structure, not a script* — it gives the DM a brief, some pressure points it
may inject, a **fate table** of dice rolls that trigger authored twists, state
it must track, and end conditions.

## File layout

Each scenario is a directory under `scenarios/<name>/`:

```
scenarios/<name>/
├── scenario.json      # the schema below
└── media/             # optional assets (intro video, images) referenced by path
```

Scenarios are listed in `scenarios/registry.json`.

## Schema

```jsonc
{
  // --- identity ---
  "scenario_id": "bramble_badger_deepfake",      // unique slug
  "title": "Bramble Badger Deepfake Crisis",
  "version": 2,

  // --- opening / intro (the "select scenario -> video -> moderator intro" flow) ---
  "intro": {
    "video": "media/bramble_badger_fake_exec_video.mp4",  // optional
    "narrative": "Text read aloud / displayed by the moderator to set the scene.",
    "facilitator_notes": "For the moderator only, not the players.",
    "company_url": "https://example.com",     // optional: DM may fetch public info
    "company_info": "Optional static background about the organization."
  },

  // --- starting state the DM must track and update each turn ---
  "opening_state": {
    "budget": 70, "reputation": 65, "morale": 70, "risk": 35,
    "member_confidence": 68, "regulator_confidence": 60
  },

  // --- facilitator metadata (not fed to players verbatim) ---
  "meta": {
    "suggested_minutes": 60,
    "difficulty": "medium",               // low | medium | high
    "tags": ["misinformation", "fraud", "governance"],
    "learning_objectives": [
      "Practice coordinated misinformation response",
      "Exercise public-communications escalation"
    ]
  },

  // --- the DM's private briefing (fuel for adjudication, not rigid script) ---
  "dm_brief": {
    "situation": "Full background the DM uses to make calls.",
    "stakes": "What is at risk if the group fails.",
    "key_actors": [
      { "name": "Bramble (CGI badger)", "role": "Antagonist", "interests": "...", "knowledge": "..." }
    ],
    "pressure_points": [
      "Ideas the DM may inject if the group stalls, e.g. a regulator calls."
    ],
    "rules_of_play": [
      "The DM must NOT propose actions or lead the group toward a choice.",
      "The DM responds only after the group states a concrete action."
    ]
  },

  // --- fate table: specific D20 rolls trigger authored twists ---
  // Other rolls are tiered by the DM (1=crit fail, 20=crit success, else magnitude).
  // Numbers not listed are adjudicated purely by the DM.
  "fate_table": {
    "1":  { "kind": "crit_fail",   "twist": "Roll 1: catastrophe twist.",                 "state_delta": { "reputation": -10, "risk": 8 } },
    "11": { "kind": "twist",       "twist": "Roll 11: the building catches fire.",        "state_delta": { "budget": -15, "risk": 10 } },
    "20": { "kind": "crit_success","twist": "Roll 20: perfect execution, role-model win.", "state_delta": { "reputation": 8, "morale": 5 } }
  },

  // --- the goal: what the group is trying to achieve ---
  // When ALL win_conditions are met simultaneously, the scenario ends in
  // success. This is the objective the group works toward — not a timer.
  "goal": {
    "description": "Restore trust and deflate the crisis.",
    "win_conditions": [
      { "stat": "reputation", "operator": "gte", "value": 60 },
      { "stat": "member_confidence", "operator": "gte", "value": 60 },
      { "stat": "risk", "operator": "lte", "value": 45 }
    ],
    "ending": "Crisis resolved: trust restored. The exercise concludes."
  },

  // --- what ends the session in failure ---
  // stat-based lose conditions: fires when a stat crosses the threshold.
  // timeout:     fires when the running session timer hits duration_seconds.
  "end_conditions": [
    { "type": "stat", "stat": "budget", "operator": "lte", "value": 10,
      "ending": "Budget exhausted: the response cannot be sustained." },
    { "type": "timeout", "duration_seconds": 3600,
      "ending": "Time ran out on the scheduled exercise." }
  ],

  // --- closing report shape (audit-friendly) ---
  "report": {
    "title_note": "De-escalation / hotwash report title",
    "audit_note": "The report is produced at session end or timeout for debrief and audit."
  }
}
```

## Roll semantics (v2)

- Players type an action, then roll.
- The roll number feeds the **fate table**; if the number is listed, the
  authored `twist` FIRES (with its `state_delta`).
- If the number is not in the fate table, the DM tiers it: low = failure,
  mid = mixed, high = success, with 1 and 20 as hard crits.
- The DM is told to never pre-suggest actions — it adjudicates what the group
  actually typed.

## State tracking

The DM receives the current state each turn and returns an updated state with
its judgment of the action's consequences. The engine clamps values to [0,100].
Persisting state across turns is what makes a long session consequential and
feeds `end_conditions` (e.g. "risk > 90 = the event becomes a full incident").
