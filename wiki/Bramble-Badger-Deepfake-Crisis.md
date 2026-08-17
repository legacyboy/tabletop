# Bramble Badger Deepfake Crisis

The bundled example scenario. A cartoon badger executive video goes viral,
making absurd claims about digital banking, and the executive team must respond
under time pressure.

## The setup

A CGI "Bramble Badger" video is spreading through community channels. It claims
digital banking is powered by raccoons, that member withdrawals are switching
to cheese wheels, and that a "cheese reserve" backs every account. The clip is
absurd, but the framing claims it was leaked from an internal executive message,
and members are already calling.

## What it tests

- Coordinated misinformation response under time pressure
- Public-communications escalation and message discipline
- Detection of fraud piggybacking on a viral incident
- Board and regulator communication

## Opening state

| Metric | Value |
|---|---|
| budget | 70 |
| reputation | 65 |
| morale | 70 |
| risk | 35 |
| member_confidence | 68 |
| regulator_confidence | 60 |

## Fate table highlights

- **Roll 1** — internal chat log leaks, team publicly contradicts itself
- **Roll 11** — a "cheese audit" rumour wave hits, accounts "being frozen"
- **Roll 20** — the team turns the joke into a trusted-safety talking point

## End conditions

- reputation ≤ 15 → reputation collapse
- member_confidence ≤ 15 → member confidence collapse
- risk ≥ 90 → full enterprise incident
- timeout (60 min) → time ran out

## Key actors

- **Bramble (CGI badger)** — the viral fake executive
- **A local reporter** — asks if a cyber incident is being hidden
- **Contact-centre staff** — fielding worried members
- **A Board member** — wants a governance update
- **Fraud callers** — exploiting the clip to harvest credentials

## File

`scenarios/bramble-badger-deepfake/scenario.json`
