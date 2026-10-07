#!/usr/bin/env python3
"""
Expand each scenario's 3-beat arc to 4 beats (Dan, 2026-10-07: a 4-turn run is
too fast; 5-6 turns is the goal). Split the combined "resolve + recover" final
beat into two: an ACT/ERADICATE beat (b3) and a RECOVER/REBUILD/CLOSE beat (b4).
"""
import json, collections

# New narrative for the revised b3 (act on the findings), and the new b4
# (recover / rebuild / close the loop), per scenario. b3 keeps its id; the
# old b3 text is folded into b3+b4.
NEW = {
 "bramble-badger-deepfake": {
   "b3": {
     "id": "b3-eradicate",
     "name": "Step 3 — Eradicate the root cause",
     "narrative": "The story is contained but the cause is not. Step 3 is to eradicate it: close the compromised channel (the agency account/token the fake was seeded from) and harden it, confirm the fraud campaign is actually stopped rather than paused, and take the platform relationship from reactive takedowns to a standing escalation path. Show the group that closing the door behind the attacker is a separate job from calming the room."
   },
   "b4": {
     "id": "b4-recover",
     "name": "Step 4 — Rebuild trust and close the loop",
     "narrative": "The threat is dead and the systems are clean. The final step is recovery: make the reassured members whole and keep them reassured, rebuild the ordinary confidence the run shook (deposits, call volumes, staff morale), publish what changed and why, and close out with the board and the regulator on an honest account of what was missed. A hard-won win should read as earned by what the group did after the crisis, not just during it."
   }
 },
 "executive-scandal": {
   "b3": {
     "id": "b3-resolve",
     "name": "Step 3 — Resolve on the evidence",
     "narrative": "The process is running and the findings are landing. Step 3 is to resolve the leader's situation on the evidence with fairness intact — whatever the review clears or confirms — close out the conflict-of-interest findings with real consequences, and make the conduct decisions the investigation demands. This is the hardest step: acting on uncomfortable findings without letting the institution look vindictive or the individual look abandoned."
   },
   "b4": {
     "id": "b4-rebuild",
     "name": "Step 4 — Rebuild governance and confidence",
     "narrative": "The immediate situation is resolved. The final step is recovery: rebuild the governance the crisis exposed as weak (the disclosure that was never recorded, the conflict-of-interest controls), restore staff and member confidence, publish what changed, and close out with the board and the regulator on a credible account of what was fixed. The story should end on whether the institution is stronger for how it handled this, not merely that it survived it."
   }
 },
 "rogue-ai": {
   "b3": {
     "id": "b3-eradicate",
     "name": "Step 3 — Fix the root causes",
     "narrative": "The story is contained but the cause is not. Step 3 is to eradicate it: scrub and validate the training data, fix the session plumbing that leaked, test for the bias the forensic work surfaced, and pin the vendor's responsibility where the evidence puts it. Show the group that making the system safe is a separate job from calming the room — fixing the model, not just muting it."
   },
   "b4": {
     "id": "b4-recover",
     "name": "Step 4 — Earn the relaunch and rebuild trust",
     "narrative": "The root causes are fixed. The final step is recovery: make the affected members whole, decide the assistant's future on evidence rather than fear, rebuild the ordinary confidence the failure shook, and publish what changed and why. Close out with the regulator and the board on an honest account. The story should end on whether the organization earned back the trust its AI cost it."
   }
 },
 "toxic-workplace-viral-post": {
   "b3": {
     "id": "b3-fix",
     "name": "Step 3 — Fix what's real",
     "narrative": "The investigation has separated truth from noise. Step 3 is to act on it: real consequences for the real problems the review substantiated, a real process change for the culture the post exposed, and a clear, defensible line on what was found to be false. Show the group that the fixes have teeth — that this is action taken on findings, not a statement about taking action."
   },
   "b4": {
     "id": "b4-rebuild",
     "name": "Step 4 — Rebuild the culture and close the loop",
     "narrative": "The problems are being fixed. The final step is recovery: rebuild the trust of the staff who spoke up and the staff who stayed, show the change is durable rather than a crisis-time promise, and close out with the board and the regulator on an honest account of what was corrected. The story should end on whether the workplace is genuinely better for how this was handled."
   }
 },
 "whistleblower": {
   "b3": {
     "id": "b3-remediate",
     "name": "Step 3 — Remediate the real risk",
     "narrative": "The facts are established. Step 3 is to eradicate the real risk the reports exposed: fix the concentration exposure the numbers confirmed, remediate any genuine member harm and make those members whole, correct what the documents show was exaggerated, and protect the source while doing it. Show the group that acting on uncomfortable truths is a separate job from managing the disclosure."
   },
   "b4": {
     "id": "b4-rebuild",
     "name": "Step 4 — Prove the culture changed",
     "narrative": "The risk is being remediated. The final step is recovery: prove to staff, members, and the regulator that raising concerns now leads somewhere, restore the confidence the crisis shook, publish what changed, and close out on an honest account of what was missed and fixed. The story should end on whether the organization is one that can hear bad news — at a cost, but earned."
   }
 },
}

BASE = "/home/claw/.openclaw/workspace/projects/tabletop/scenarios"
for sid, spec in NEW.items():
    p = f"{BASE}/{sid}/scenario.json"
    d = json.load(open(p), object_pairs_hook=collections.OrderedDict)
    beats = d["beats"]
    assert len(beats) == 3, (sid, len(beats))
    # Replace b3 with the eradicate/act beat, then append the new recover beat.
    beats[2] = collections.OrderedDict(spec["b3"])
    beats.append(collections.OrderedDict(spec["b4"]))
    d["beats"] = beats
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    open(p, "a").write("\n")
    print(f"{sid}: beats now {[b['id'] for b in beats]}")
print("done")
