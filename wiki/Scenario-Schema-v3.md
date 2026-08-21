# Scenario Schema v3

v3 builds on v2's open-ended, LLM-run model with three changes:

1. **Text-first intro.** The intro shows the group's **case brief** — the
   primary thing all participants read to set the scene. The video is
   optional. There is no human facilitator (the DM is the LLM), so there are
   no moderator-only notes on the player screen.
2. **Conditional events.** The loose `dm_brief.pressure_points` (a list of
   strings the DM *may* inject) is replaced by a structured top-level `events`
   array. Each event has a **conditional trigger** (stall, stat threshold, or
   turn) and optional state effects. Events fire **at most once per session**.
3. **Hidden goal.** The goal lives in the engine and the DM's private brief
   only. It is **never shown to players** in the UI.

v4 (the current version) adds the BDB-inspired features on top of v3:

4. **Attack chain (kill chain).** A hidden, ordered set of stages the group
   must discover and contain. The DM reveals a stage when the group's
   investigation uncovers it, and marks it contained when the group neutralizes
   it. The win condition becomes "contain all stages."
5. **BDB-style metric set.** `risk` is replaced by `attacker_progress` (the
   kill chain as a number), plus response-side metrics (`containment`,
   `eradication`, `recovery`, `security_posture`) and `public_trust`.
6. **Roll modifiers.** The group can "play" a defender capability (spend
   budget) to get a +2/+3 on the next D20 roll.
7. **Breach state.** A discrete ladder (`contained → active → escalated →
   exfiltrated`) the DM narrates as the attack chain progresses.
8. **Random mode.** A registry entry with no pre-authored scenario.json — the
   DM generates the scenario on the fly.

v1 was a **fixed decision tree**: players picked from authored options and the
engine chose the outcome tier by D20. v2/v3/v4 are **open-ended sessions run by
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

  // --- opening / intro (the "select scenario -> case introduction" flow) ---
  // The narrative is the CASE INTRODUCTION — the primary thing shown to all
  // participants. The video is optional. There is no human facilitator (the
  // DM is the LLM), so there are no moderator-only notes displayed.
  "intro": {
    "video": "media/bramble_badger_fake_exec_video.mp4",  // optional
    "narrative": "Text displayed to the group to introduce the case.",
    "company_url": "https://example.com",     // optional: DM may fetch public info
    "company_info": "Optional static background about the organization."
  },

  // --- starting state the DM must track and update each turn ---
  // BDB-style metric set. `attacker_progress` replaces the old vague `risk`.
  // The engine tracks whatever metrics you define here (data-driven).
  "opening_state": {
    "budget": 70, "public_trust": 65, "regulator_confidence": 60,
    "security_posture": 60, "containment": 20, "eradication": 10,
    "recovery": 10, "attacker_progress": 30
  },

  // --- the hidden attack chain (kill chain) ---
  // Ordered stages the group must discover and contain. Each has an id, an
  // executive-friendly name (plain language, NOT MITRE jargon), and a symptom
  // (what the group observes). `revealed` defaults to false. The DM reveals a
  // stage when the group's investigation uncovers it, and marks it contained
  // when the group neutralizes it. Win condition: contain all stages.
  "attack_chain": [
    { "id": "hook",   "name": "How they got in", "symptom": "Fraud callers reference the clip to harvest credentials.", "revealed": false },
    { "id": "spread", "name": "How it spread",   "symptom": "The clip is amplified across community channels.", "revealed": false },
    { "id": "take",   "name": "What they took",   "symptom": "Members report credential requests; funds are moving.", "revealed": false }
  ],

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
  //   stall: fires after N consecutive turns the DM judged as no meaningful
  //          progress (the DM's per-turn `progress` judgment, not action text
  //          length).
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

  // --- the story beats (optional ordered arc) ---
  // An ordered arc the DM walks the group through, so the story doesn't stall
  // into a flat "act -> react -> dead end". Each beat has an id, an executive-
  // friendly name, and a narrative describing the step and what it takes to
  // resolve it. The DM advances to the next beat when the group resolves the
  // current one, narrating the transition. A group that handled a beat WELL
  // finds the next step softer; one that handled it POORLY finds it worse. A
  // single decisive action can skip forward to a later beat. OMIT beats for
  // simple one-shot scenarios (the DM then just keeps the story advancing
  // turn to turn).
  "beats": [
    { "id": "b1", "name": "Step 1 — Get ahead of the story", "narrative": "<what the group faces and must resolve this step>" },
    { "id": "b2", "name": "Step 2 — The regulator and the fraud wave", "narrative": "<the next stage; note it is softer if Step 1 went well, harsher if not>" }
  ],

  // --- the goal: what the group is trying to achieve ---
  // HIDDEN from players. Lives only in the engine and the DM's private brief.
  // When ALL win_conditions are met simultaneously, the scenario ends in
  // success. This is the objective the group works toward — not a timer.
  // The win condition should reference attacker_progress + containment /
  // eradication / recovery (the BDB-style "contain all stages" objective).
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
  },

  // --- what ends the session in failure ---
  // stat-based lose conditions: fires when a stat crosses the threshold.
  // timeout:     fires when the running session timer hits duration_seconds.
  "end_conditions": [
    { "type": "stat", "stat": "attacker_progress", "operator": "gte", "value": 90,
      "ending": "Attack overload: the event becomes a full enterprise incident." },
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

## Story beats (optional ordered arc) — v4

An optional `beats` array gives a scenario an **ordered arc of steps** so the
story doesn't stall into a flat "act → react → dead end". Each beat has:

- `id` — a stable slug (e.g. `b1-public`).
- `name` — an executive-friendly label (e.g. "Step 1 — Get ahead of the story").
- `narrative` — what the group faces in this step and what it takes to resolve it.

**How it plays:** the group starts in beat 0. Each turn the DM is told which
beat the group is in and the arc. When the group's actions genuinely resolve
the current beat, the DM returns the **next beat id** in the `beat` field and
narrates the transition. A group that handled the beat **well** finds the next
step **softer**; one that handled it **poorly** finds it **worse**. A single
decisive action can **skip forward** to a later beat when the story warrants it.

The DM also reports `beat_quality` (`good`/`mixed`/`poor`) for the beat just
completed; the engine carries it into the next turn so the DM can calibrate the
incoming beat's tone.

The engine **tracks and persists** `currentBeatIndex` and `lastBeatQuality`
across a restore. A returned `beat` id only ever advances **forward** (never
backwards); an unknown or non-forward id is ignored. If a scenario has no
`beats`, this whole mechanic is inert and the DM simply keeps the story
advancing turn to turn.

> Pair `beats` with the momentum rule in the DM prompt: the DM is forbidden from
> presenting menus/options but is **required** to end each turn by advancing the
> world into its next natural development, so there is always something concrete
> for the group to respond to.

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
| `stall` | `turns: N` | the DM judges the group made no meaningful progress for N consecutive turns (per-turn `progress` judgment, not action text length) |
| `stat` | `stat`, `operator` (`gte`/`lte`), `value` | the stat crosses the threshold |
| `turn` | `turn: N` | the session reaches turn N (optional; stall/stat are the primary conditional triggers) |

`dm_brief.pressure_points` still works as a backward-compatible fallback (the
DM may inject them if the group stalls), but new scenarios should use the
top-level `events` array.

## Goal (win condition) — OPTIONAL

The `goal` object is **optional**. It is used by the engine (`dm.js`) to detect
an explicit successful end when all `win_conditions` are met simultaneously. It
is **not rendered in the UI** — players never see the goal, its win conditions,
or its ending text. It stays in the DM's private brief only. Do not surface it
to players.

**Two modes — pick based on the exercise type:**

- **IT / kill-chain exercise (use a `goal`).** There is a concrete objective —
  find and kill the threat, contain all attack-chain stages, restore the system.
  The group "wins" when they hit the thresholds or contain all stages. Example:
  a BDB-style incident-response scenario.
- **Executive / fallout exercise (omit `goal`).** There is no discrete thing to
  "win" against — a data leak, PR scandal, or regulatory probe is *fallout you
  manage*. The session runs to a lose condition or the timeout, and the closing
  report is the debrief (final metrics + which stages were contained vs missed).
  There is no artificial "you hit 80 containment, you win" bell.

When `goal` is omitted, the engine does **not** auto-win on attack-chain
containment — the scenario ends only on a lose condition or timeout. Authors
should still provide `end_conditions` (lose thresholds + a timeout) so every
scenario has a defined ending.

## State tracking

The DM receives the current state each turn and returns an updated state with
its judgment of the action's consequences. The engine clamps values to [0,100]
and caps per-turn changes to ±10 so a session keeps a believable arc. Persisting
state across turns is what makes a long session consequential and feeds
`end_conditions` (e.g. "attacker_progress > 90 = the event becomes a full
incident").

## Attack chain (kill chain)

The `attack_chain` array gives a scenario a hidden, ordered set of stages the
group must discover and contain. Each stage has:

- `id` — a stable slug (e.g. `hook`, `spread`, `take`).
- `name` — an **executive-friendly** plain-language name (e.g. "How they got
  in", "How it spread", "What they took"). Do NOT use technical MITRE jargon
  (no "C2 and Exfil", "Persistence", "Lateral Movement") — executives won't
  know or care.
- `symptom` — the executive-facing description of what the group observes that
  hints at this stage.
- `revealed` — bool, default `false`. The DM reveals a stage when the group's
  investigation plausibly uncovers it.

The DM's brief lists the hidden chain. The DM reveals a stage when the group
uncovers it, and marks it contained when the group neutralizes it. The engine
tracks `revealed`/`contained` per stage in the session (persisted across a
restore) and feeds the current chain state to the DM each turn.

**Win condition (only when a `goal` is defined):** containing ALL stages is a
success (the BDB-style "contain all stages" win), even if the numeric goal
thresholds aren't all met yet. If the scenario has **no** `goal`, containing
all stages does NOT auto-end the session — the exercise runs to its lose
condition or timeout (the executive/fallout mode).

## Roll modifiers (defender capabilities)

The group can "play" a defender capability (spend budget) to get a +2/+3 on
the next D20 roll. The engine tracks a `rollModifier` in the session (persisted
across a restore). When a defender action grants a modifier, the next roll is
adjusted. The DM brief explains this mechanic. The modifier **nudges** the roll
— it does not replace the DM's judgment.

## Breach state

A discrete breach ladder the DM narrates as the attack chain progresses:
`contained → active → escalated → exfiltrated`. It is derived from the attack
chain (how many stages are revealed but not yet contained) and is more legible
to executives than an abstract number. It is tracked in the session (persisted)
and fed to the DM each turn.

## Random mode

A registry entry with `"random": true` (or `id: "random"`) has **no
pre-authored scenario.json**. When selected, the DM generates the scenario on
the fly: an appropriate executive scenario, opening state, goal, and events,
from a generic prompt. The engine uses a minimal valid scenario shell and the
DM system prompt includes a RANDOM MODE block that instructs the DM to invent
the scenario. Keep it executive-focused — the DM should generate an appropriate
executive tabletop scenario (security, reputation, operational, etc.).
