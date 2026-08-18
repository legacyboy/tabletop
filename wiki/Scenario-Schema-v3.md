# Scenario Schema v3

v3 builds on v2's open-ended, LLM-run model with three changes:

1. **Text-first intro.** The intro narrative is the group's **opening scene** —
   the primary thing shown to players. The video is optional. Facilitator notes
   stay moderator-only.
2. **Conditional events.** The loose `dm_brief.pressure_points` (a list of
   strings the DM *may* inject) is replaced by a structured top-level `events`
   array. Each event has a **conditional trigger** (stall, stat threshold, or
   turn) and optional state effects. Events fire **at most once per session**.
3. **Hidden goal.** The goal lives in the engine and the DM's private brief
   only. It is **never shown to players** in the UI.

v1 was a **fixed decision tree**: players picked from authored options and the
engine chose the outcome tier by D20. v2/v3 are **open-ended sessions run by
an LLM dungeon master (DM)**. Players type *any* action into a free-text box,
roll a D20, and the DM adjudicates the action + roll against the scenario
context. The scenario file is *inspiration and structure, not a script* — it
gives the DM a brief, a set of **conditional events**, a **fate table** of dice
rolls that trigger authored twists, state it must track, and end conditions.

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
  "version": 4,

  // --- opening / intro (the "select scenario -> opening scene" flow) ---
  // The narrative is the group's OPENING SCENE — the primary thing shown to
  // players. The video is optional. facilitator_notes is moderator-only.
  "intro": {
    "video": "media/bramble_badger_fake_exec_video.mp4",  // optional
    "narrative": "Text read aloud / displayed to the group to set the scene.",
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
    // Optional, backward-compatible. Prefer the top-level `events` array.
    "pressure_points": [
      "Ideas the DM may inject if the group stalls, e.g. a regulator calls."
    ],
    "rules_of_play": [
      "The DM must NOT propose actions or lead the group toward a choice.",
      "The DM responds only after the group states a concrete action."
    ]
  },

  // --- pre-compiled conditional events (v3) ---
  // Each event fires AT MOST ONCE per session, when its trigger is met. When
  // it fires, the engine applies its state_delta and tells the DM to weave
  // its text into the narrative for that turn. Trigger types:
  //   stall: fires after N consecutive turns with no meaningful action
  //          (empty or very short action text).
  //   stat:  fires when a stat crosses a threshold (gte/lte).
  //   turn:  fires on a specific turn number (optional; stall/stat are the
  //          primary "conditional" triggers).
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
      "text": "The regulator's office calls asking for a factual summary and this morning's timeline.",
      "state_delta": { "regulator_confidence": -5 }
    },
    {
      "id": "e3",
      "trigger": { "type": "turn", "turn": 6 },
      "text": "An influencer with a large local following amplifies the clip.",
      "state_delta": { "reputation": -3, "risk": 4 }
    }
  ],

  // --- fate table: specific D20 rolls trigger authored twists ---
  // Other rolls are tiered by the DM (1=crit fail, 20=crit success, else magnitude).
  // Numbers not listed are adjudicated purely by the DM.
  "fate_table": {
    "1":  { "kind": "crit_fail",   "twist": "Roll 1: catastrophe twist.",                 "state_delta": { "reputation": -10, "risk": 8 } },
    "11": { "kind": "twist",       "twist": "Roll 11: the building catches fire.",        "state_delta": { "budget": -15, "risk": 10 } },
    "20": { "kind": "crit_success","twist": "Roll 20: perfect execution, role-model win.", "state_delta": { "reputation": 8, "morale": 5 } }
  },

  // --- the goal: what the group is trying to achieve ---
  // HIDDEN from players. Lives only in the engine and the DM's private brief.
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

## Roll semantics (v3)

- Players type an action, then roll.
- The roll number feeds the **fate table**; if the number is listed, the
  authored `twist` FIRES (with its `state_delta`).
- If the number is not in the fate table, the DM tiers it: low = failure,
  mid = mixed, high = success, with 1 and 20 as hard crits.
- The DM is told to never pre-suggest actions — it adjudicates what the group
  actually typed.

## Conditional events (v3)

Events are **conditional**, not a fixed schedule. Each fires at most once per
session (the engine tracks fired ids and persists them across a restore, so a
restored session never re-fires an event). When an event fires:

1. Its `state_delta` is applied to the current state.
2. Its `text` is injected into the DM's context for that turn, so the DM
   weaves it into the narrative.

Trigger types:

| type | fields | fires when |
|---|---|---|
| `stall` | `turns: N` | the group takes no meaningful action for N consecutive turns (empty or very short action text) |
| `stat` | `stat`, `operator` (`gte`/`lte`), `value` | the stat crosses the threshold |
| `turn` | `turn: N` | the session reaches turn N (optional; stall/stat are the primary conditional triggers) |

`dm_brief.pressure_points` still works as a backward-compatible fallback (the
DM may inject them if the group stalls), but new scenarios should use the
top-level `events` array.

## Hidden goal

The `goal` object is used by the engine (`dm.js`) to detect a successful end
when all `win_conditions` are met simultaneously. It is **not rendered in the
UI** — players never see the goal, its win conditions, or its ending text. It
stays in the DM's private brief only. Do not surface it to players.

## State tracking

The DM receives the current state each turn and returns an updated state with
its judgment of the action's consequences. The engine clamps values to [0,100]
and caps per-turn changes to ±10 so a session keeps a believable arc. Persisting
state across turns is what makes a long session consequential and feeds
`end_conditions` (e.g. "risk > 90 = the event becomes a full incident").
