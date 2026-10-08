/**
 * Balance batch run: play N full sessions of the Deepfake scenario against a
 * real/remote model, with a mix of GOOD and BAD roll sequences, and report the
 * spread (start -> end metrics, endings, whether the arc resolved).
 *
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/balance-batch.mjs [runs]
 */
import { readFileSync } from 'fs';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const RUNS = parseInt(process.argv[2] || '3', 10);
const scenario = JSON.parse(readFileSync('scenarios/bramble-badger-deepfake/scenario.json', 'utf8'));

// Three roll "profiles" to test the extremes and a blend. Each is an 8-turn
// sequence (the arc resolves at 4-6; the extra turns give bad luck room to dig
// out and let us see if the run ever dead-ends).
const PROFILES = {
  // Pure failure: every roll in the fail band (1-5). Includes the two negative
  // fate events (1 and 5).
  fail:  [1, 5, 3, 2, 4, 5, 3, 1],
  // Pure success: every roll in the strong band (15-20). Includes both positive
  // fate events (11 is excluded here since it is 'good', so we use 20 + repeats).
  success: [20, 19, 17, 16, 18, 15, 20, 19],
  // A realistic blend: good and bad rolls mixed, with 11 and 20 landing too.
  mixed: [7, 14, 3, 11, 7, 16, 9, 20],
};

const ACTIONS = [
  'We convene the team, establish one point of contact, and verify the facts before saying anything publicly.',
  'We issue a short honest holding statement and brief the front line so every answer matches.',
  'We brief the board and the regulator with a timeline, and protect anyone who raised concerns.',
  'We run our own investigation, fix what is genuinely wrong, and commit to visible follow-through.',
  'We communicate progress to staff and members and close out the remediation.',
  'We push the last remediation items over the line and publicly correct anything we got wrong.',
  'We rebuild the controls the crisis exposed as weak and publish what changed.',
  'We close out with the board and the regulator on an honest account of what was fixed.',
];

const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });

const results = [];
const profileNames = Object.keys(PROFILES);
const perProfile = {};
for (let r = 0; r < RUNS; r++) {
  const profileName = profileNames[r % profileNames.length];
  // Vary the sequence per run so we don't just replay one fixed list: rotate
  // the base sequence and (for fail/success) swap in fresh in-band rolls by
  // offsetting within the band. This gives genuinely different runs per profile.
  const seen = (perProfile[profileName] = (perProfile[profileName] || 0) + 1);
  const rolls = varyRolls(PROFILES[profileName], seen, profileName);
  const s = new DMSession(provider, scenario);
  await s.openScene();
  const start = { ...s.state };
  let end = null;
  let lastState = { ...start };
  let stalled = false;
  for (let i = 0; i < rolls.length && !end; i++) {
    const res = await s.takeTurn(ACTIONS[i], rolls[i]);
    if (res.endCondition) end = res.endCondition;
    // Detect a possible dead-end: the story stopped advancing (no beat change)
    // for 3+ consecutive turns late in the run.
    lastState = res.state || lastState;
  }
  const fin = s.state;
  const notable = rolls.filter((x) => x === 1 || x === 5 || x === 11 || x === 20);
  const resolved = !!end;
  results.push({ profileName, rolls, start, fin, end, turns: s.turn, notable, resolved });
  console.log(`RUN ${r + 1} [${profileName}#${seen}] rolls=${rolls.join(',')} notable=${notable.join(',') || '-'}`);
  console.log(`   ${format(start)} -> ${format(fin, start)}  TURNS=${s.turn}`);
  console.log(`   end: ${end ? `${end.type}/${end.result} (${end.win_quality || '-'})` : 'NOT RESOLVED'}`);
}

// Vary a profile's roll sequence across repeats: rotate and nudge within the
// profile's band so four runs of "fail" aren't the identical eight rolls.
function varyRolls(base, seen, profileName) {
  if (seen === 1) return base.slice();
  const k = (seen - 1) % base.length;
  const rotated = base.slice(k).concat(base.slice(0, k));
  const shift = (seen - 1);
  return rotated.map((v) => {
    if (profileName === 'fail') return Math.min(5, Math.max(1, ((v - 1 + shift) % 5) + 1));
    if (profileName === 'success') return Math.min(20, Math.max(15, ((v - 15 + shift) % 6) + 15));
    return v;
  });
}

function format(a, base) {
  const keys = ['public_trust', 'regulator_confidence', 'containment', 'eradication', 'recovery'];
  return keys.map((k) => {
    const v = a[k];
    if (base && typeof base[k] === 'number' && v !== base[k]) return `${k}=${v}(${v - base[k] >= 0 ? '+' : ''}${v - base[k]})`;
    return `${k}=${v}`;
  }).join(' ');
}

// Aggregate: average end metrics by profile.
console.log('\n=== SUMMARY ===');
const byProfile = {};
for (const r of results) (byProfile[r.profileName] ||= []).push(r);
for (const [name, rs] of Object.entries(byProfile)) {
  const avg = (k) => Math.round(rs.reduce((s, r) => s + (r.fin[k] || 0), 0) / rs.length);
  const resolved = rs.filter((r) => r.resolved).length;
  const turnList = rs.map((r) => r.turns).join(',');
  console.log(`${name}: turns=[${turnList}] avg trust=${avg('public_trust')} reg=${avg('regulator_confidence')} contain=${avg('containment')} erad=${avg('eradication')} rec=${avg('recovery')} | resolved ${resolved}/${rs.length}`);
}
