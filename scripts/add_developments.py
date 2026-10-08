#!/usr/bin/env python3
"""
Add `developments` to each beat (Dan, 2026-10-07): "more steps, things inject as
the story moves." Each beat gets one mid-beat development that fires on the
group's second turn inside the beat, so a beat carries two turns of real story
and the arc stretches to 5-6 turns through content, not padding.

Each development: { text, state_delta }.
"""
import json, collections

DEV = {
 "bramble-badger-deepfake": {
  "b1-public": {
    "text": "A second, shorter clip surfaces that splices the CEO's own voice from a genuine staff briefing into the fake - it is far more convincing than the first, and a regional news outlet picks it up as 'new evidence', forcing the team to answer a harder question than the one they had prepared for.",
    "state_delta": {"public_trust": -3}},
  "b2-fraud": {
    "text": "The fraud crew pivots faster than expected: the fake clip is re-cut and seeded through a wave of freshly created accounts, and two members who called the 'safe account' line are now reported as having moved money - the campaign is adapting to the takedowns in real time.",
    "state_delta": {"containment": -3}},
  "b3-eradicate": {
    "text": "The compromised agency channel turns out to be linked to a larger credential leak that touches a second vendor, so closing the obvious door is not enough - the team discovers the same stolen session token pattern in another partner's access, widening the job just as it looked finished.",
    "state_delta": {"containment": -2}},
  "b4-recover": {
    "text": "As the recovery messaging goes out, a group of members publishes an open letter demanding an independent review of how the credit union handled the panic - the story's final turn is not the fraud but whether the institution can show it has genuinely changed.",
    "state_delta": {"public_trust": -2}},
 },
 "executive-scandal": {
  "b1-vacuum": {
    "text": "A second outlet obtains the original, unrecorded disclosure note and publishes it, shifting the story from 'allegation' to 'documented - and why was it never logged?' - the posture must now survive a fact, not a rumour.",
    "state_delta": {"public_trust": -3}},
  "b2-governance": {
    "text": "The independent review hits an obstacle: a board member who was close to the executive asks to be recused, and the press reads the recusal as a sign the institution is protecting its own - the process must show independence under scrutiny.",
    "state_delta": {"regulator_confidence": -3}},
  "b3-resolve": {
    "text": "On the eve of the decision, the executive's lawyer signals a wrongful-dismissal claim if the process goes against him, and two directors waver - the group must hold the line between fairness to the individual and accountability to the institution.",
    "state_delta": {"public_trust": -2}},
  "b4-rebuild": {
    "text": "As the governance fixes are announced, staff-survey results leak showing confidence had collapsed during the crisis - recovery now has to be proven internally, not just declared publicly.",
    "state_delta": {"regulator_confidence": -2}},
 },
 "rogue-ai": {
  "b1-public": {
    "text": "The reporter publishes a second story within hours: the assistant was never formally approved for the lending-advice use case at all, so the question shifts from 'what went wrong' to 'why was it running unapproved' - a harder admission than the first.",
    "state_delta": {"public_trust": -3}},
  "b2-forensics": {
    "text": "The forensics turn up something worse than bad data: the session plumbing that leaked records was a known bug logged by an engineer months ago and deprioritised - the failure was visible and ignored, not unseen.",
    "state_delta": {"containment": -3}},
  "b3-eradicate": {
    "text": "While scrubbing the training data the team finds the bias is not a one-off - the flawed corpus feeds a second, quieter model used for member messaging, so the fix has to reach further than the flagged system.",
    "state_delta": {"containment": -2}},
  "b4-recover": {
    "text": "As the relaunch is proposed, staff who raised the original warnings ask publicly why they were ignored, turning the recovery into a test of whether the organisation can hear its own people.",
    "state_delta": {"public_trust": -2}},
 },
 "toxic-workplace-viral-post": {
  "b1-public": {
    "text": "The post is reposted by an account with a large following, and a second former employee adds a screenshot with a date that contradicts the organisation's 'long since resolved' line - the response now has to account for a specific document.",
    "state_delta": {"public_trust": -3}},
  "b2-investigate": {
    "text": "The investigation hits a wall: the named manager's performance file is thin and a key witness has left the organisation, so the group must decide whether to act on pattern evidence rather than proof - and the post's audience is watching that call.",
    "state_delta": {"regulator_confidence": -3}},
  "b3-fix": {
    "text": "As consequences land, a group of current employees privately warns that the fixes are being read as punishment of one person rather than culture change - the group must show the change is structural, not a scapegoat.",
    "state_delta": {"public_trust": -2}},
  "b4-rebuild": {
    "text": "The engagement survey lands mid-recovery and shows the people who stayed feel less heard than those who left - rebuilding trust has an internal audience that public messaging will not satisfy.",
    "state_delta": {"regulator_confidence": -2}},
 },
 "whistleblower": {
  "b1-stakeholders": {
    "text": "CBC publishes a first story before the team is ready, quoting the documents and naming the drift in the concentration number - the group is now responding to a published fact, not a request for comment.",
    "state_delta": {"public_trust": -3}},
  "b2-investigate": {
    "text": "The investigation finds the whistleblower kept a second set of files the journalists have not seen, and someone inside is quietly trying to identify the source - the group must protect the source while the truth keeps growing.",
    "state_delta": {"regulator_confidence": -3}},
  "b3-remediate": {
    "text": "The remediation exposes an uncomfortable truth: the concentration risk is larger than the reports claimed, so fixing it means an expensive exposure reduction the board never budgeted for - acting honestly now has a real cost.",
    "state_delta": {"containment": -2}},
  "b4-rebuild": {
    "text": "Staff who once raised concerns ask the group to prove, not promise, that speaking up is now safe - and the regulator asks for evidence that the culture change is real, not a statement of intent.",
    "state_delta": {"regulator_confidence": -2}},
 },
}

BASE = "/home/claw/.openclaw/workspace/projects/tabletop/scenarios"
for sid, devs in DEV.items():
    p = f"{BASE}/{sid}/scenario.json"
    d = json.load(open(p), object_pairs_hook=collections.OrderedDict)
    beats = d["beats"]
    added = 0
    for b in beats:
        if b["id"] in devs:
            b["developments"] = [collections.OrderedDict(devs[b["id"]])]
            added += 1
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    open(p, "a").write("\n")
    print(f"{sid}: {added} beats got a development")
print("done")
