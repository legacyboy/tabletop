# PR — BDB-inspired features + playtest fixes + API-keys-only refactor

One consolidated PR covering three layers of work. **Goal: an executive-focused,
BDB-inspired tabletop that runs entirely on API keys (no in-browser model, no
local bundle).**

## Layer 1 — BDB-inspired features (from BDB_REVIEW.md, all executive-focused)

- **Kill chain (`attack_chain`)** — per-scenario hidden, ordered attack stages
  with plain-language names ("How they got in", "How it spread", "What they
  took"). The DM reveals/contains stages; the win condition is "contain all
  stages".
- **Metric rework** — replaced vague `risk` with `attacker_progress`; added
  `containment`, `eradication`, `recovery`, `security_posture`, `public_trust`;
  kept `budget`, `regulator_confidence`. Data-driven per scenario.
- **Roll modifiers** — the group can "play" a defender capability (spend
  budget) for a +2/+3 nudge on the next D20 roll.
- **Soft round counter** — turn-triggered events inject pressure; no hard fail.
- **Detection as a resource** — DM brief/rules enforce limited response actions.
- **Breach state** — `contained → active → escalated → exfiltrated`, fed to DM
  and shown to players.
- **Contained-stages report** — BDB-style debrief showing which stages were
  contained vs missed.
- **Random mode** — a `random` registry entry + shell; the DM generates the
  scenario, opening state, goal, and events on the fly.
- Bramble Badger updated to v4 with the new metric set + attack chain + breach.

## Layer 2 — Playtest fixes (all 4 issues from PLAYTEST_REPORT.md)

1. **JSON leak (HIGH)** — hardened `_extractJson` with a final `_cleanNarrative`
   safety net; `_normalize` handles double-encoded narratives; `takeTurn` guard
   never falls back to raw JSON.
2. **Empty actions (MEDIUM)** — blind-playthrough fallback is now a concrete
   constructive action; player prompt forbids empty replies.
3. **Snowball / harsh DM (MEDIUM)** — per-turn TOTAL cap (`PER_TURN_MAX_CHANGE
   = 15`) so fate + event + DM deltas can't stack; `consecutive` field on stat
   lose conditions (stat must stay in the zone for N turns); strengthened DM
   brief (good rolls stabilize/improve, session winnable).
4. **Roll modifiers (LOW)** — targeted tests for the full defender-capability
   flow.

**Test harness improvements:** D20 roll now generated truly randomly
(`Math.random()*20+1`, matching the real app — not via the LLM, which biases);
robust 6-attempt action retry; fallback flagged `[FALLBACK]`.

## Layer 3 — API-keys-only refactor (removes in-browser WebLLM / local bundle)

- **Removed** the in-browser WebLLM provider (`app/js/providers/webllm.js`),
  all WebLLM references in registry/settings/index, the `vendor/` offline
  bundle (593 MB, git-ignored), `models/`, `scripts/vendor-offline.sh`,
  `DEBUG_WEBLLM.md`, `REVIEW_WEBLLM.md`, and the README/wiki WebLLM sections.
- The app now runs **purely on API keys**: OpenAI / DeepSeek / Anthropic
  (direct), or Ollama via the server proxy (`Server (local)` / `Ollama (remote)`).
- Docs updated (README, wiki) to reflect API-key-only usage.

## Testing

- presets 33, dm-session 92, dm-integration 6, extract-json 12, report pass,
  verify-features 54 (zero page errors) — all pass.
- Playtests (blind-playthrough): authored + random mode, using gemma4:31b-cloud
  player + gemma3:4b DM — no empty player responses, no JSON leak. Random mode
  generates a coherent scenario on the fly.
