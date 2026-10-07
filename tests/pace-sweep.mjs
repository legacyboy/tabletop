/**
 * PACING SWEEP — the CEO crisis played at four tempos.
 *
 * Dan (2026-10-07): "I want a set of tests at various pacing, fast, slow, really
 * slow. Test it out and see if it holds well."
 *
 * Four group behaviours against the same scenario + build:
 *   BLITZ     - ~5-6 actions in one turn (a big coordinated push)
 *   NORMAL    - 2-3 actions
 *   SLOW      - 1 action, deliberate
 *   REALLY SLOW - 1 small action, and the group dawdles (some no-progress turns)
 *
 * For each we record, per turn: the number of actions the group took, the size of
 * the DM's narrative (a proxy for how much the world threw back), the number of
 * metrics the DM moved, and whether the run still reached a clean resolution. The
 * question Dan cares about: does the world's response SCALE with the group's
 * effort, and does a slow game still hold together over an hour?
 *
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/pace-sweep.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { buildReport, renderReportHtml } from '../server/report.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });

const scenario = JSON.parse(readFileSync(ROOT + 'scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));
const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });

// Action-sets of increasing size. Each entry is the text the group types.
const ACTIONS = {
  blitz: [
    'We fire everything at once: release a plain-language statement, pin the CEO live on our own channel, brief every branch and the whole call centre on one script, open a member hotline, send takedown notices to both platforms, brief the regulator and the deposit insurer with a timeline, and task the fraud team to freeze every account showing the drain pattern.',
    'Full-court press: we get the agency to hand over console logs and pull the attacker session, loop in law enforcement on attribution, publish a public timeline, make the first victims whole, and stand up an hourly member update.',
    'We close it all out: harden the marketing channel with MFA and rotated credentials, hand attribution evidence to the crown, run a member town hall, publish the final writeup, and stand down the incident.',
  ],
  normal: [
    'Comms drafts one plain statement confirming the video is fake and pins the CEO live within the hour; we brief the frontline so branch answers match.',
    'We push platform takedowns on the 30-second cut and the hashtag, brief the regulator with what we know and a timeline, and task the fraud team to watch for account-drain patterns.',
    'We lean on the agency for their console logs, loop in law enforcement on attribution, and start freezing accounts showing the pattern.',
    'We rotate the agency credentials, enforce MFA, revoke the compromised posting account, and put out an hourly member update.',
    'We publish a plain-language timeline, make the first fraud victims whole, and start rebuilding trust with a member town hall.',
  ],
  slow: [
    'We put out one plain statement confirming the video is fake.',
    'We pin the CEO live on our own channel to deny it in her own words.',
    'We open a single member hotline for people who are worried.',
    'We ask the platform to take down the clip.',
    'We brief our branch staff so they say the same thing.',
    'We ask the agency for their posting logs.',
    'We tell the regulator what we know so far.',
  ],
  really_slow: [
    'We put out one plain statement confirming the video is fake.',
    'We spend the turn discussing internally and take no outward action.',
    'We pin the CEO live on our own channel to deny it in her own words.',
    'We debate the wording of a follow-up and get nothing out the door.',
    'We open a single member hotline for people who are worried.',
    'We keep the hotline running and take no other action this turn.',
    'We ask the platform to take down the clip.',
    'We brief our branch staff so they say the same thing.',
    'We ask the agency for their posting logs.',
  ],
};

const ROSTER = [
  { key: 'blitz', label: 'BLITZ (~5-6 actions/turn)', max: 5, rolls: [12, 13, 14, 15, 16] },
  { key: 'normal', label: 'NORMAL (2-3 actions/turn)', max: 6, rolls: [12, 13, 14, 15, 16, 17] },
  { key: 'slow', label: 'SLOW (1 action/turn)', max: 8, rolls: [13, 14, 15, 16, 17, 18, 13, 14] },
  { key: 'really_slow', label: 'REALLY SLOW (1 action + dithering)', max: 10, rolls: [13, 14, 15, 16, 17, 18, 13, 14, 15] },
];

const countActions = (t) => {
  // Rough action count: split on sentence-ish boundaries and conjunctions that
  // signal a distinct move.
  const moves = (t.match(/;\s|\band\b|,\s*(?:and\s)?/gi) || []).length + 1;
  return Math.max(1, moves);
};

const results = [];

for (const run of ROSTER) {
  const s = new DMSession(provider, scenario);
  s.companyInfo = 'First Meridian Credit Union — a mid-sized member-owned credit union, ~$4B in assets.';
  await s.openScene();

  const rows = [];
  let end = null;
  const plays = ACTIONS[run.key];

  for (let i = 0; i < run.max && !end; i++) {
    const action = plays[Math.min(i, plays.length - 1)];
    const roll = run.rolls[i % run.rolls.length];
    const verdict = (s._paceBrief().split('PACING VERDICT:')[1] || '').trim().split('—')[0].trim();
    const before = JSON.stringify(s.state);
    const res = await s.takeTurn(action, roll);
    const changed = Object.keys(res.state).filter((k) => JSON.parse(before)[k] !== res.state[k]).length;
    const beat = s.beats[s.currentBeatIndex]?.id || '-';
    rows.push({
      turn: s.turn,
      actions: countActions(action),
      narrativeChars: (res.narrative || '').length,
      metricsMoved: changed,
      beat,
      verdict,
      fate: res.event?.fate ? true : false,
    });
    if (res.endCondition) end = res.endCondition;
  }

  results.push({ run: run.label, key: run.key, rows, end, turns: s.turn, session: s });
  console.log(`\n=== ${run.label} — ${s.turn} turns, ended=${end ? end.result : 'no'} ===`);
  for (const r of rows) {
    console.log(`  t${r.turn} actions~${r.actions} narrative=${r.narrativeChars}ch metricsMoved=${r.metricsMoved} beat=${r.beat} fate=${r.fate ? 'Y' : 'n'} verdict=${r.verdict}`);
  }
}

// ---- Analysis: does the response scale with the effort? ----
console.log('\n\n################  SCALING ANALYSIS  ################');
const summary = results.map((r) => {
  const n = r.rows.length;
  const avgActs = r.rows.reduce((a, x) => a + x.actions, 0) / n;
  const avgNarr = Math.round(r.rows.reduce((a, x) => a + x.narrativeChars, 0) / n);
  const avgMetrics = (r.rows.reduce((a, x) => a + x.metricsMoved, 0) / n).toFixed(1);
  return { run: r.run, turns: r.turns, avgActs: avgActs.toFixed(1), avgNarr, avgMetrics, ended: r.end ? r.end.result : 'none' };
});
for (const s of summary) {
  console.log(`  ${s.run.padEnd(38)} turns=${String(s.turns).padStart(2)}  avgActions=${s.avgActs}  avgNarrative=${String(s.avgNarr).padStart(4)}ch  avgMetricsMoved=${s.avgMetrics}  end=${s.ended}`);
}

// Correlation between action count and narrative size across ALL turns.
const all = results.flatMap((r) => r.rows);
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const mx = mean(all.map((r) => r.actions)), my = mean(all.map((r) => r.narrativeChars));
let num = 0, dx = 0, dy = 0;
for (const r of all) { num += (r.actions - mx) * (r.narrativeChars - my); dx += (r.actions - mx) ** 2; dy += (r.narrativeChars - my) ** 2; }
const corr = num / Math.sqrt(dx * dy);
console.log(`\n  Pearson r (action count vs narrative length), all ${all.length} turns: ${corr.toFixed(3)}`);
console.log(`  ${corr > 0.3 ? 'PASS' : corr > 0 ? 'weak' : 'FAIL'} — the world's response ${corr > 0.3 ? 'scales with' : 'does NOT clearly scale with'} the group's effort.`);

// Does the dithering (no-progress) run still reach resolution rather than stalling out?
const rs = results.find((r) => r.key === 'really_slow');
console.log(`  REALLY SLOW reached: ${rs.end ? rs.end.result + ' in ' + rs.turns + ' turns' : 'NO END — stalled'}`);
const sl = results.find((r) => r.key === 'slow');
console.log(`  SLOW reached:        ${sl.end ? sl.end.result + ' in ' + sl.turns + ' turns' : 'NO END — stalled'}`);

// Write reports for the two extremes.
for (const r of [results[0], results[results.length - 1]]) {
  try {
    const report = buildReport(r.session);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `pace-sweep-${r.key}-${stamp}`;
    writeFileSync(join(OUT, base + '.json'), JSON.stringify({ report, transcript: r.session.history }, null, 2));
    writeFileSync(join(OUT, base + '.html'), renderReportHtml(report, { title: `Pace sweep — ${r.run}` }));
    console.log(`  wrote ${base}.html`);
  } catch (e) { console.log(`  (report skipped for ${r.key}: ${e.message})`); }
}
process.exit(0);
