# Back Doors & Breaches (BDB) → Tabletop App: Transfer Review

**Date:** 2026-08-19
**Author:** Research subagent (Steve4)
**Scope:** Research + recommendations only. No code modified.

---

## 1. BDB Overview

**Back Doors & Breaches** (BDB) is an incident-response card game by Black Hills
Information Security / Active Countermeasures / Antisyphon Training. It exists in
two main forms:

- **Classic** — a cooperative tabletop exercise. One player is the **Incident
  Captain** (the DM/facilitator). The Captain secretly builds a **kill chain** of
  4 attack cards and runs the defenders through a realistic scenario. The
  defenders (everyone else) work together to *discover* the hidden attack chain
  before time runs out.
- **Competitive** — a head-to-head, resource-driven variant (2-4 players). Each
  player builds a kill chain against opponents while defending their own network,
  racing to deplete opponents' **Resource Points (RP)**. First player standing wins.

### Core mechanics (Classic)

- **The kill chain is the heart of the game.** The Captain secretly selects one
  card from each of 4 attack categories, in a fixed order:
  1. **Initial Compromise** (RED) — how the attacker got in
  2. **Persistence** (PURPLE) — how they maintain access
  3. **Pivot & Escalate** (YELLOW) — how they gained privileges / moved laterally
  4. **C2 & Exfil** (BROWN) — how they communicate out and steal data
- The Captain presents a scenario that *hints* at these methods without revealing
  them. Defenders investigate using **Detection (BLUE)** cards, **Procedure**
  cards, and a **d20**.
- **Win condition:** Defenders correctly identify all 4 attack cards within a
  round limit (typically 10 rounds). Win as a team or lose as a team.
- **Inject (GREY)** cards are scenario twists — random events that simulate the
  chaos of a real incident (a regulator calls, a second breach surfaces, a
  reporter leaks something).

### Core mechanics (Competitive)

- Each player starts with **10 Resource Points (RP)** and a deck of **15 PREP
  cards** (up to 3 Traps).
- Each turn has **3 phases**:
  1. **Preparation** — draw/activate a PREP card (bonus rolls, skip turns, traps).
  2. **Purchase** — spend RP to buy Detection cards into your "Toolbox" (max 3).
  3. **Action** — Attack (roll d20, ≥11 succeeds, build your kill chain against an
     opponent) or Defend (roll to counter an opponent's attack card).
- **Kill chain completion** lets you roll to **steal RP** from the opponent
  (roll 11→1 RP up to 20→10 RP).
- **Lose** when you run out of RP or run out of PREP cards before opponents.

### What makes it engaging

- **A concrete, discoverable mystery.** The hidden kill chain gives the exercise a
  clear objective and a satisfying "aha" when defenders piece it together.
- **A shared mental model.** The 4-stage kill chain (Compromise → Persistence →
  Pivot/Escalate → C2/Exfil) is a real, industry-standard way to think about
  attacks (Lockheed Martin Cyber Kill Chain / MITRE ATT&CK). It teaches *structure*,
  not just facts.
- **Cooperative pressure.** Classic mode is team-vs-the-scenario, so it builds
  collaboration and communication — ideal for training.
- **Low-stakes, high-repetition.** Cards make it fast to spin up a new scenario,
  so teams can run many exercises cheaply.
- **Detection as a resource.** Detection cards are limited and must be bought/
  deployed strategically — forces prioritization, not just "do everything."

---

## 2. Transferable Concepts

The tabletop app is an **open-ended LLM-DM executive simulator**. BDB is a
**structured card game**. The two are philosophically different (open-ended vs.
structured), but BDB's *concepts* map cleanly onto the app's data-driven
scenario model. Here's the mapping, concept by concept.

### 2.1 The Kill Chain / Attack Progression (HIGH value)

**In BDB:** The attack is modeled as a fixed 4-stage progression (Initial
Compromise → Persistence → Pivot & Escalate → C2 & Exfil). The defenders must
discover and counter each stage.

**In the tabletop app:** The current Bramble Badger scenario has no notion of an
*attack progression* — it's a single viral event with `risk` as a vague catch-all.
A BDB-inspired model would give the scenario a **staged attack** the DM tracks:

- Add a per-scenario `attack_chain` to the schema: an ordered list of stages,
  each with a name, a description, and a "revealed" flag.
- The DM's brief tells it the hidden chain. As players investigate, the DM
  reveals stages. Each stage has its own `state_delta` when it "fires" or when
  it's "contained."
- **Win condition becomes "contain all stages"** rather than just "get stats
  above a number." This gives the exercise a concrete, discoverable objective —
  the single biggest engagement win BDB offers.

**Concrete example for a security scenario:**
```
"attack_chain": [
  { "id": "compromise",  "name": "Initial Compromise",  "revealed": false },
  { "id": "persistence", "name": "Persistence",         "revealed": false },
  { "id": "pivot",       "name": "Pivot & Escalate",     "revealed": false },
  { "id": "exfil",       "name": "C2 & Exfil",           "revealed": false }
]
```
The DM reveals a stage when the group's investigation plausibly uncovers it.
Containing a stage (e.g. "we revoked the compromised account") locks it and
prevents further damage from that vector.

### 2.2 Attacker / Defender Card Draws (MEDIUM-HIGH value)

**In BDB:** The Captain draws attack cards; defenders draw/use Detection and
Procedure cards. Cards are the *fuel* for both sides.

**In the tabletop app:** The app already has a **fate table** (D20 rolls trigger
authored twists) and **conditional events**. This is the natural home for a
"card draw" mechanic:

- **Attack cards** = the `events` array + `fate_table` twists. These are already
  the "attacker's moves." Formalize them as a deck the DM draws from.
- **Defender cards** = a new concept: a set of *capabilities* the group can
  "play" (e.g. "Activate the fraud-monitoring playbook," "Escalate to the board,"
  "Issue a public statement"). Each has a cost (budget) and a mechanical effect
  (a stat bonus or a guaranteed containment of one attack stage).
- **The D20 already exists.** BDB's "roll ≥11 to succeed" maps directly onto the
  app's D20 roll. The app could add **roll modifiers** (a played defender card
  gives +2 to the next roll) — a small, high-impact addition.

### 2.3 Injects (HIGH value, easy win)

**In BDB:** Inject (GREY) cards are random scenario twists injected by the
Captain to simulate incident chaos.

**In the tabletop app:** This is *already implemented* as the **conditional
events** system (`stall`, `stat`, `turn` triggers). BDB validates the design —
the app's `events` array is essentially a structured inject deck. **Recommendation:
keep this, and lean into it.** The Bramble Badger scenario already uses it well
(e.g. `e3` fires when `risk >= 60`). This is the most BDB-aligned feature the app
already has.

### 2.4 Scoring Rounds / Round Limit (MEDIUM value)

**In BDB:** Classic mode has a hard round limit (10 rounds). Competitive has
turn-based phases.

**In the tabletop app:** The app has a `timeout` end condition (3600s) but no
*round* concept. A **round limit** (e.g. "resolve the crisis within 12 turns")
would add urgency and a cleaner win/lose structure. The `turn` trigger type
already exists in the events system, so a round limit is a natural extension.

### 2.5 Blue-Team Actions / Detection as a Resource (MEDIUM value)

**In BDB:** Detection cards are limited and must be purchased/deployed
strategically. You can't do everything.

**In the tabletop app:** The current model lets the group try anything with no
resource constraint beyond vague `budget`. A BDB-inspired model would make
**detection/investigation a scarce resource** — e.g. the group has a limited
number of "investigation actions" per turn, or must spend budget to activate
monitoring. This forces prioritization and makes the exercise harder and more
realistic.

### 2.6 A "Breach" State (HIGH value)

**In BDB:** The kill chain stages represent escalating attacker progress. If
defenders don't act, the attacker progresses.

**In the tabletop app:** The app has `risk` as a single number. A BDB-inspired
model would add a **discrete breach state** — e.g. `contained → active → escalated
→ exfiltrated` — that the DM advances as the attack chain progresses. This is
more legible to executives than an abstract `risk` number, and it gives the DM a
clear escalation ladder to narrate.

---

## 3. Score / Morale / Metric Rework

The current metric set is: **budget, reputation, morale, risk, member_confidence,
regulator_confidence**. These are all 0-100, data-driven per scenario, and tracked
generically by the engine. That's a good foundation — the engine doesn't care
what the metrics are, so we can rework them freely.

### Assessment of the current set

| Metric | Verdict | Why |
|---|---|---|
| `budget` | **Keep** | Universal, legible, forces trade-offs. Works for any scenario. |
| `reputation` | **Keep** | Core for an executive/public-facing scenario. |
| `risk` | **Rework** | Too vague and overloaded. It's doing the job of "attacker progress" but without structure. Replace or split. |
| `morale` | **Keep but de-emphasize** | Fine as a secondary/internal metric, but it's the weakest of the six — rarely the deciding factor. |
| `member_confidence` | **Keep** | Good, specific, scenario-appropriate. |
| `regulator_confidence` | **Keep** | Good, specific, adds a governance dimension. |

**The core problem:** `risk` is a catch-all that conflates *attacker progress*
with *organizational exposure*. BDB separates these cleanly. The app should too.

### A BDB-inspired metric set (for security/IR scenarios)

For a security-focused scenario (which is what BDB is about), I'd propose a set
that separates **attacker progress** from **organizational response**:

**Attacker-side (the kill chain):**
- `attacker_progress` (0-100) — how far the attack has gotten. Replaces the
  vague `risk`. Advances as the kill chain stages fire; drops as stages are
  contained. **This is the BDB kill chain as a number.**

**Response-side (the defenders' posture):**
- `security_posture` (0-100) — overall defensive readiness / controls strength.
- `containment` (0-100) — how well the incident is boxed in.
- `eradication` (0-100) — how thoroughly the root cause is removed.
- `recovery` (0-100) — how well normal operations are restored.

**Stakeholder-side (the executive/public view):**
- `public_trust` (0-100) — replaces/absorbs `reputation` + `member_confidence`.
- `regulator_confidence` (0-100) — keep as-is.
- `budget` (0-100) — keep as-is.

**Optional:**
- `morale` — keep only if the scenario is long enough for internal fatigue to
  matter. Otherwise drop it.

### A proposed "BDB-style" metric set for a security scenario

```
opening_state: {
  "budget": 70,
  "public_trust": 65,
  "regulator_confidence": 60,
  "security_posture": 60,
  "containment": 20,      // incident just started
  "eradication": 10,
  "recovery": 10,
  "attacker_progress": 30 // attack is underway
}
```

**Win conditions** would then be structured like BDB's "contain all stages":
```
win_conditions: [
  { "stat": "attacker_progress", "operator": "lte", "value": 20 },
  { "stat": "containment",       "operator": "gte", "value": 80 },
  { "stat": "eradication",       "operator": "gte", "value": 80 },
  { "stat": "recovery",          "operator": "gte", "value": 70 },
  { "stat": "public_trust",      "operator": "gte", "value": 60 }
]
```

### Different metric sets for different scenario types

Because the metrics are data-driven per scenario, Dan can (and should) define
*different* sets per scenario type:

- **Security/IR scenario** (BDB-style): the set above — attacker_progress,
  containment, eradication, recovery, security_posture, public_trust,
  regulator_confidence, budget.
- **Misinformation/reputation scenario** (like Bramble Badger): keep the current
  set mostly, but **replace `risk` with `attacker_progress`** (the fraud
  piggybacking is the "attack") and consider adding `message_discipline` or
  `narrative_control` (how well the group controls the public story).
- **Operational/financial scenario**: budget, liquidity, service_uptime,
  customer_confidence, regulator_confidence, staff_morale.

The engine already supports this — it just tracks whatever `opening_state`
defines. The only engine change needed is to make sure the DM brief and the
report render the metric names generically (which they already do).

---

## 4. What NOT to Copy

BDB is a great source of *concepts*, but several of its mechanics don't fit an
open-ended executive LLM-DM tabletop. Don't copy these:

1. **The rigid card-deck structure.** BDB's physical cards, purchase phases, and
   cooldown systems are great for a card game but would fight the app's
   open-ended LLM-DM design. The app's strength is that players type *anything*.
   Don't turn it into a menu-driven card game. **Steal the concepts (kill chain,
   injects, detection-as-resource), not the card mechanics.**

2. **The exact kill-chain taxonomy.** BDB's 4 stages (Compromise, Persistence,
   Pivot/Escalate, C2/Exfil) are *technical* and MITRE-flavored. An **executive**
   audience (CEOs, board members, non-technical managers) won't know or care
   about "C2 and Exfil." Keep the *idea* of a staged attack, but rename the
   stages in plain language (e.g. "How they got in" → "How they spread" → "What
   they took"). Don't force MITRE jargon on executives.

3. **The competitive PvP mode.** BDB Competitive (players attacking each other,
   stealing RP) is fun but wrong for an executive tabletop. The app's value is
   cooperative team-vs-scenario. Don't add player-vs-player mechanics.

4. **The hard round limit as a hard fail.** BDB Classic's "10 rounds or you lose"
   is rigid. The app's open-ended LLM-DM model benefits from a *soft* pressure
   (a round counter that injects events) rather than a hard "you lose on turn 12."
   Keep the timeout as a soft pressure, not a hard fail.

5. **Over-mechanizing the D20.** BDB's "roll ≥11 = success" is binary. The app's
   D20 is already richer (fate table + DM tiering). Don't flatten it back to a
   pass/fail threshold. Use roll *modifiers* from defender actions, but keep the
   DM's judgment in the loop.

6. **Too many metrics.** BDB tracks essentially one resource (RP). Don't bloat
   the app to 10+ metrics — executives can't track that many. Keep it to 5-7
   legible metrics per scenario. The proposed set above is at the upper bound.

---

## 5. Prioritized Recommendations

### HIGH — do these first

1. **Add a per-scenario `attack_chain` (kill chain).** Give scenarios a hidden,
   staged attack the DM reveals and the group must contain. This is the single
   biggest engagement win from BDB. Win condition becomes "contain all stages."
   *Engine change: add `attack_chain` to schema; DM tracks revealed/contained
   stages. Low effort, high payoff.*

2. **Replace `risk` with `attacker_progress`.** `risk` is a vague catch-all.
   Split it into attacker progress (the kill chain as a number) and keep the
   response-side metrics separate. *Pure data change — no engine work.*

3. **Add roll modifiers from defender actions.** Let the group "play" a defender
   capability (spend budget) to get a +2/+3 on the next D20 roll. This makes the
   D20 feel like a resource game, not a coin flip. *Small engine change.*

### MEDIUM — strong value, more work

4. **Add a soft round counter.** Track turns and inject pressure events on a
   schedule (the `turn` trigger already exists). Gives urgency without a hard
   fail. *Small engine change.*

5. **Introduce "detection as a resource."** Limit investigation/response actions
   per turn, or make activating monitoring cost budget. Forces prioritization.
   *Mostly a DM-brief + rules_of_play change; minimal engine work.*

6. **Add a discrete "breach state"** (contained → active → escalated →
   exfiltrated) that the DM narrates as the attack chain progresses. More legible
   to executives than an abstract number. *DM-brief + schema addition.*

### LOW — nice to have

7. **Rework the metric set per scenario type.** Define different `opening_state`
   sets for security vs. reputation vs. operational scenarios. The engine already
   supports this. *Pure data work.*

8. **Add a "contained stages" counter to the report.** Show which kill-chain
   stages the group contained and which they missed — a BDB-style debrief that
   highlights weak areas. *Report rendering change.*

9. **Drop `morale` for short scenarios.** It's the weakest metric. Keep it only
   for long exercises where internal fatigue matters. *Data change.*

---

## Summary

BDB's most transferable ideas are: **(1)** the hidden kill chain as a concrete,
discoverable objective, **(2)** injects as scenario chaos (already implemented in
the app's `events` system), **(3)** detection as a scarce resource, and **(4)**
separating attacker progress from organizational response. The app's current
`risk` metric is the main thing to fix — it conflates these. The metrics are
already data-driven, so Dan can rework them per scenario without engine changes.
Don't copy BDB's rigid card mechanics, its technical MITRE jargon, or its
competitive PvP mode — the app's open-ended LLM-DM model is its strength, and
BDB should inform it, not replace it.
