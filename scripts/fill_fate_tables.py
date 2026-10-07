#!/usr/bin/env python3
"""
Fill each scenario's fate_table to cover all 20 D20 rolls.

Dan (2026-10-07): "Let's do 1, but leave the fate rolls." = fill the table to
all 20 rolls, but do NOT change the 8 existing scripted entries (1,5,7,9,11,14,
17,20). This adds scripted entries for the 12 missing rolls (2,3,4,6,8,10,12,
13,15,16,18,19) so the DM is never improvising the outcome.

Band design (keeps the failure band at 1-5, unchanged):
  1        crit_fail   (existing)
  2-4      fail        (+ 5 existing)
  6-8      mixed       (+ 7 existing)
  9-14     good        (+ 9,11,14 existing)
  15-19    strong      (+ 17 existing)
  20       crit_success (existing)
Failure = 5/20 = 25%; never a coin flip.
"""
import json, collections, sys

ORDER = ["scenario_id", "title", "version", "cast", "goal", "intro",
         "opening_state", "meta", "attack_chain", "beats", "dm_brief",
         "events", "fate_table", "end_conditions", "report"]

def load(p):
    with open(p) as f:
        return json.load(f, object_pairs_hook=collections.OrderedDict)

def save(p, d):
    # preserve original order where possible, appending unknown keys
    out = collections.OrderedDict()
    for k in ORDER:
        if k in d:
            out[k] = d[k]
    for k, v in d.items():
        if k not in out:
            out[k] = v
    with open(p, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")

# ---- Banded deltas (same shape across scenarios; per-scenario twist text) ----
def delta_for(roll, extra_key):
    """Return the state_delta for a filler roll. extra_key names the scenario's
    second metric when a twist calls for one (kept simple + consistent)."""
    if roll in (2, 3, 4):
        # fail band (5 already exists)
        base = {"public_trust": -6}
        if roll == 4:
            base = {"public_trust": -7}
        if roll == 3:
            base = {"public_trust": -8, extra_key: -3}
        if roll == 2:
            base = {"public_trust": -9, extra_key: -4}
        return base
    if roll in (6, 8):
        if roll == 6:
            return {"public_trust": -1, "regulator_confidence": 1}
        return {"public_trust": 1, "regulator_confidence": 2}
    if roll in (10, 12, 13):
        if roll == 10:
            return {"public_trust": 3, "regulator_confidence": 2}
        if roll == 12:
            return {"public_trust": 5, "regulator_confidence": 3}
        return {"public_trust": 5, "containment": 4, "regulator_confidence": 3}
    if roll in (15, 16, 18, 19):
        if roll == 15:
            return {"containment": 6, "public_trust": 4}
        if roll == 16:
            return {"containment": 7, "regulator_confidence": 4}
        if roll == 18:
            return {"containment": 8, "public_trust": 5, "regulator_confidence": 4}
        return {"containment": 9, "public_trust": 6, "regulator_confidence": 5}
    return {}

# ---- Per-scenario filler twists -------------------------------------------------
# Each entry: roll -> (kind, twist, second_metric_key)
SECOND = {
    "bramble-badger-deepfake": "containment",
    "executive-scandal": "regulator_confidence",
    "rogue-ai": "containment",
    "toxic-workplace-viral-post": "regulator_confidence",
    "whistleblower": "regulator_confidence",
}

TWISTS = {
  "bramble-badger-deepfake": {
    2: ("The statement goes out late and defensive, and by the time it lands a bank-run meme is circulating with the fake's 'pause on withdrawals' line attached - deposits are moving faster than anyone can reassure.",
        "The response is overtaken: two branch managers contradict the corporate line on local radio, and the fake gains a second life as 'proof the bank is hiding something'."),
    3: ("Your message is drowned out - the fake is now being repeated by a local councillor, and a screenshot of your own holding statement is being read as an admission.",
        "A takedown request is misfiled and the clip is re-uploaded to three mirrors within the hour, each with a fresh caption claiming the credit union deleted 'the truth'."),
    4: ("The response reads as legalistic and cold; a member's angry post about being 'fobbed off' by the call centre outpaces your statement.",
        "Staff go off-script under pressure, and two contradictory answers to the same question make the rounds before the afternoon is out."),
    6: ("Partial: the statement is picked up by local outlets, but the fraud calls continue and the takedown requests are still queued, so the panic eases only slightly.",
        "You slow the spread but don't stop it - one amplifier account is suspended while two new ones appear, and member call volume stays high."),
    8: ("Modest gain: the call-centre script holds up under scrutiny and a few early panickers are calmed, though the clip itself is still live and spreading.",
        "The takedown notices start landing, thinning the fake's reach - enough to buy breathing room, not enough to end the day."),
    10: ("Solid win: your coordinated statement and the takedown push together blunt the clip's spread, and the first genuine counter-narrative pieces get picked up locally.",
         "The fraud-report hotline you stood up catches several 'safe account' calls early, and the volume of new victims starts to fall."),
    12: ("A strong, well-sequenced response: statement, takedowns, and member outreach land in the right order, and community voices begin to amplify the correction.",
         "The provenance trail firms up - a journalist confirms the stolen agency session token - and the fake's credibility takes a real hit."),
    13: ("The group's handling visibly steadies the room: branch staff get their talking points, the app's outbound-transfer spike starts to flatten, and the narrative turns your way.",
         "With the takedowns actioned and the fraud line live, the panic loses its fuel - members start hearing a consistent, credible story and calm down."),
    15: ("Strong play: the fraud crew's 'safe account' cluster is traced and handed to police, and the takedowns strip the clip from the major platforms almost at once.",
         "The insurer's liaison signals support and the withdrawals slow sharply - the run is being contained, not just managed."),
    16: ("Real momentum: the fake is discredited locally, the fraud network is visibly wounded, and your message is now the one spreading.",
         "A bank's-worth of reassurance lands: the balance sheet is reaffirmed on the record and the deposit drain reverses."),
    18: ("Near-decisive: the provenance exposé runs and the fake collapses as a story - attention swings to the criminals who built it, and the credit union looks like the victim it is.",
         "The takedowns, the fraud line, and the member outreach all click at once - the campaign is on the back foot and the panic is draining out of the feeds."),
    19: ("A commanding turn: platforms act fast, the fraud crew is named publicly, and the correction travels further than the fake ever did.",
         "Everything lands - trust is visibly rebuilding, the withdrawal spike is over, and the board gets the good news early for once."),
  },
  "executive-scandal": {
    2: ("The vacuum widens: with no line agreed, two directors give conflicting quotes to the same reporter and the story metastasizes into 'leadership in disarray'.",
        "The silence reads as a cover-up, and a second outlet starts asking whether the board knew more than it is saying."),
    3: ("A procedural misstep - treating the executive as guilty in an internal email that surfaces - hands his lawyer a grievance and hands the press a quote.",
        "The organization's 'no comment' is read as a cold shoulder, and the human story of a 14-year veteran turned into a news item outruns the institutional line."),
    4: ("The statement lands as bureaucratic and self-protective, and staff start leaking their own hot takes to fill the gap.",
        "The board's split spills into public view, and the regulator notes the governance wobble in its case file."),
    6: ("Partial: the single-line discipline mostly holds, but the ambiguity invites a fresh round of speculation and one outlet frames it as a stall.",
        "You steady the worst of it, yet the absence of any process detail keeps the story alive for another news cycle."),
    8: ("Modest progress: the board agrees a defensible process and the tone shifts from chaos to procedure, though the optics are still awkward.",
        "A quiet briefing to the regulator lands well enough to buy time, and the press cycle slows without stopping."),
    10: ("Solid win: a single, fair, consistent line is agreed and held, and staff stop improvising answers at the branches.",
         "The stepped-back authority arrangement is framed as process rather than punishment, and the story starts to cool."),
    12: ("Strong handling: fairness to the individual and protection of the institution are both made explicit, and the board visibly unifies.",
         "The regulator accepts the disclosed process and the case moves from 'what were they hiding' to 'how did they handle it' - a much better story."),
    13: ("The group's steady handling converts a potential scandal into a governance story the institution can survive, and the leaks dry up.",
         "A clean, prompt process keeps the outlet's follow-ups short and the community's appetite for the story begins to fade."),
    15: ("Strong play: the conflict-of-interest thread is surfaced and handled transparently, removing the one fact that could have turned a stumble into a fire.",
         "The board's unified, defensible process earns a notably softer line from the regulator's supervision lead."),
    16: ("Real control regained: the individual's rights are protected, the institution's process is airtight, and the press loses its wedge.",
         "The story is now about how well the organization handled a hard moment - rare favourable coverage for a scandal that never had to be one."),
    18: ("Near-decisive: a single honest statement, a fair process, and visible board unity put the story to bed almost before it grew.",
         "The regulator closes its supervision note with a cooperative posture, and the community reads a leadership that kept its head."),
    19: ("A commanding turn: the executive is treated fairly, the institution is protected, and the outcome is handled so cleanly it becomes a case study in process.",
         "Everything lands - no charges, no cover-up, no disarray - and the organization's handling earns quiet respect."),
  },
  "rogue-ai": {
    2: ("The response backfires: a defensive statement that the AI is 'working as designed' is screenshotted and read as a confession, and the reporter's story gets a damning headline.",
        "Your explanation of the leak is too vague to be believed, and the regulator escalates its AI file to a formal inquiry."),
    3: ("A rushed fix breaks something else - the assistant starts refusing legitimate member questions - and both the outage and the original failures make the morning news.",
        "The internal blame-shifting surfaces in a leak, and the story shifts from 'AI failed' to 'company hid that it failed'."),
    4: ("The statement reads as corporate and evasive; affected members' stories outpace it, and the bias evidence is now a segment on a national broadcast.",
        "The vendor publicly blames 'customer data quality', and the credit union's refusal to rebut it looks like an admission."),
    6: ("Partial: the assistant is paused for the flagged use cases, but the transcript and bias examples are already public and still driving the story.",
        "You contain the immediate leak, yet the training-data problem remains unexplained and the reporter presses on it."),
    8: ("Modest gain: the engineering lead's account is corroborated internally and the March warning is acknowledged, buying credibility with the regulator.",
        "The flawed recommendations are quietly corrected and remediated for affected members, and some trust starts to return."),
    10: ("Solid win: the system is scoped down to safe functions, the leak is closed, and the affected members are made whole - the story loses its sharpest edges.",
         "A plain-language explanation of the dirty training data lands well, and the regulator notes the organization moved proactively."),
    12: ("Strong handling: the vendor is held to account, the fix is verifiable, and the group's transparency converts a scandal into a responsible-response story.",
         "The engineering lead's warnings are vindicated and acted on, and the regulator's file moves toward a cooperative resolution."),
    13: ("The group's handling turns the narrative: the failures are owned, fixed, and explained, and member harm is addressed rather than buried.",
         "The bias finding is confirmed and remediated with an independent check, and the reporter's follow-up is notably more balanced."),
    15: ("Strong play: an independent audit confirms the root causes are fixed and the vendor's role is pinned down, removing the ambiguity the story fed on.",
         "The regulator accepts the remediation plan and the affected members settle, draining the story's emotional fuel."),
    16: ("Real control: the AI is safely re-scoped, the leak is provably closed, and the bias is corrected with evidence - the failure becomes a fix.",
         "The vendor accepts responsibility, and the credit union emerges as the operator that caught and corrected its own problem."),
    18: ("Near-decisive: the remediation is fast, verifiable, and member-centred, and the story turns into 'how a bank fixed its AI' rather than 'how its AI failed'.",
         "The regulator closes the file with credit for proactive handling, and the harmed members' stories end in restitution rather than grievance."),
    19: ("A commanding turn: root cause named, fix verified, vendor accountable, members made whole - the response is close to a textbook recovery.",
         "Everything lands, and what began as an AI failure becomes evidence of a governance culture that works under pressure."),
  },
  "toxic-workplace-viral-post": {
    2: ("The response inflames it: a statement that reads as dismissive is screenshotted, and current employees start posting their own stories in protest.",
        "Someone screenshots an HR note and the post's audience explodes - the story is now 'the company attacked its own accusers'."),
    3: ("A clumsy attempt to fact-check the post in public backfires and legitimizes the accusations, with more former employees coming forward.",
        "Legal's heavy-handed takedown request is reported as censorship, and the regulator's conduct-risk interest sharpens."),
    4: ("The statement lands as tone-deaf and self-justifying, and the named manager's angry denial makes the culture problem worse, not better.",
        "Staff who spoke up feel betrayed by the response, and internal morale visibly dips as posts about 'nothing changing' spread."),
    6: ("Partial: the complaint history is quietly reviewed, but the public post keeps running and the 'handled with coaching' detail looks like a cover story.",
        "You slow the pile-on but don't address the underlying story, so the allegations stay live and credible."),
    8: ("Modest gain: some employees accept the response and the loudest anonymous accounts go quiet, though the named manager's status remains an open wound.",
        "An honest acknowledgement of past process failures lands better than expected and begins to blunt the outrage."),
    10: ("Solid win: an independent review is announced with teeth, the named manager is properly re-examined, and staff start to feel heard rather than managed.",
         "The regulator accepts that the culture concerns are being investigated in good faith, and the story loses its 'they don't care' spine."),
    12: ("Strong handling: real consequences and process change are made visible, current employees stop amplifying, and the post's momentum stalls.",
         "The review confirms systemic issues are being fixed, and the conversation shifts from accusation to remediation."),
    13: ("The group's handling turns the room: employees who spoke up are protected, the process is shown to have changed, and the public post loses its force.",
         "The regulator's conduct file moves to a monitored-but-cooperative footing, and the 'unsafe culture' framing no longer lands."),
    15: ("Strong play: the honest review surfaces the true pattern, consequences follow, and the staff collective publicly signals that something real changed.",
         "The culture story flips into a 'they actually fixed it' story, and the named manager's case is resolved without further damage."),
    16: ("Real control: the allegations are substantiated where true and rebutted where false, with evidence, and the organization earns back credibility.",
         "Staff retention concerns ease, the post stops spreading, and the regulator notes the response as a governance positive."),
    18: ("Near-decisive: a credible, independent review with real consequences lands fast, and the post's authors lose the moral high ground they had.",
         "The culture story becomes a case study in getting the response right, and internal trust visibly rebuilds."),
    19: ("A commanding turn: accountability, protection for those who spoke up, and visible change - the post is answered by actions, not words.",
         "Everything lands, and the organization ends the week better on culture than it started, credibility intact."),
  },
  "whistleblower": {
    2: ("The response backfires: a combative legal threat to CBC is reported as an attack on the press, and the regulator's interest hardens into a formal case.",
        "The organization's denial that anything was ignored is undercut by a leaked memo, and the story becomes 'they knew and did nothing'."),
    3: ("Scrambling to find the source turns into a witch-hunt that leaks, and the staff speculation poisons trust internally exactly when the organization needs solidarity.",
        "A rushed statement contradicts a document the journalists already hold, and the credibility gap widens."),
    4: ("The response reads as defensive and legalistic; the regulator's case lead notes the organization is 'managing perception rather than the risk'.",
        "Staff who raised concerns years ago go quiet, fearing the same treatment as the whistleblower, and the internal picture goes dark."),
    6: ("Partial: the organization engages CBC and avoids making it worse, but the substance stays unaddressed and the documents do the talking.",
        "Some documents are shown to be genuine, some are context-stripped, but the muddle leaves the core allegation unresolved."),
    8: ("Modest gain: an honest internal review begins and the regulator accepts the cooperative gesture, though CBC's deadline forces something out.",
        "You steady the board, but the 'how much is true' question keeps the story alive and the risk picture obscured."),
    10: ("Solid win: the organization establishes the real risk picture honestly - some warnings were valid, one number has drifted up - and acts on it.",
         "The regulator credits the self-report, and the story shifts from cover-up toward a genuine, if uncomfortable, reckoning."),
    12: ("Strong handling: the organization protects the whistleblower's anonymity, engages the facts, and commits to fixing what the reports exposed.",
         "CBC's story runs but lands as 'the organization is finally acting', and the regulator's posture turns cooperative."),
    13: ("The group's handling reframes the story: the legitimate concerns are owned, the framing exaggerations are gently corrected with evidence, and trust steadies.",
         "The risk remediation begins in earnest and the board unifies behind a defensible, honest position."),
    15: ("Strong play: an independent review confirms both the real warnings and the spin, and the organization's handling earns quiet credibility.",
         "The concentration risk is addressed head-on, and the regulator notes that the organization moved faster than it was obliged to."),
    16: ("Real control: the story becomes about how the organization responded to uncomfortable truths, and the regulator closes its posture to monitored cooperation.",
         "Staff see that raising concerns now leads somewhere, and the internal culture strengthens rather than fractures."),
    18: ("Near-decisive: full transparency with the regulator, real remediation, and protection for the source - the story loses its angle entirely.",
         "CBC's follow-up is notably measured, and the organization emerges as one that faced bad news honestly."),
    19: ("A commanding turn: the warnings are validated, the fix is real and visible, and the whistleblower's core point is publicly answered.",
         "Everything lands, and the crisis becomes evidence of a risk culture that finally works - at a real cost, but earned."),
  },
}

def apply(path, sid):
    d = load(path)
    ft = d.get("fate_table")
    if not ft:
        print(f"  skip {sid}: no fate_table")
        return
    existing = set(int(k) for k in ft)
    second = SECOND[sid]
    twists = TWISTS[sid]
    added = 0
    for roll in range(1, 21):
        if roll in existing:
            continue
        kind = ("fail" if roll <= 5 else "mixed" if roll <= 8
                else "good" if roll <= 14 else "strong")
        twist = twists[roll][0] if roll in twists else None
        if twist is None:
            print(f"  !! no twist for {sid} roll {roll}")
            continue
        entry = collections.OrderedDict()
        entry["kind"] = kind
        entry["twist"] = twist
        entry["state_delta"] = delta_for(roll, second)
        ft[str(roll)] = entry
        added += 1
    # re-sort fate_table keys numerically for readability
    d["fate_table"] = collections.OrderedDict(
        (k, ft[k]) for k in sorted(ft, key=lambda x: int(x)))
    save(path, d)
    print(f"  {sid}: +{added} rolls -> {len(d['fate_table'])}/20")

BASE = "/home/claw/.openclaw/workspace/projects/tabletop/scenarios"
for sid in ["bramble-badger-deepfake", "executive-scandal", "rogue-ai",
            "toxic-workplace-viral-post", "whistleblower"]:
    apply(f"{BASE}/{sid}/scenario.json", sid)
print("done")
