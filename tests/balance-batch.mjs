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

// Three roll "profiles" to test: bad luck, mixed, good luck. Each is a 6-turn
// sequence so the arc has a chance to resolve either way.
const PROFILES = {
  bad:   [2, 3, 1, 6, 4, 5],
  mixed: [7, 14, 3, 11, 7, 16],
  good:  [14, 18, 20, 11, 16, 19],
};

const ACTIONS = [
  'We convene the team, establish one point of contact, and verify the facts before saying anything publicly.',
  'We issue a short honest holding statement and brief the front line so every answer matches.',
  'We brief the board and the regulator with a timeline, and protect anyone who raised concerns.',
  'We run our own investigation, fix what is genuinely wrong, and commit to visible follow-through.',
  'We communicate progress to staff and members and close out the remediation.',
  'We push the last remediation items over the line and publicly correct anything we got wrong.',
];

const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });

const results = [];
for (let r = 0; r < RUNS; r++) {
  const profileName = Object.keys(PROFILES)[r % 3];
  const rolls = PROFILES[profileName];
  const s = new DMSession(provider, scenario);
  await s.openScene();
  const start = { ...s.state };
  let end = null;
  for (let i = 0; i < rolls.length && !end; i++) {
    const res = await s.takeTurn(ACTIONS[i], rolls[i]);
    if (res.endCondition) end = res.endCondition;
  }
  const fin = s.state;
  const notable = rolls.filter((x) => x === 1 || x === 5 || x === 11 || x === 20);
  results.push({ profileName, rolls, start, fin, end, turns: s.turn, notable });
  console.log(`RUN ${r + 1} [${profileName}] rolls=${rolls.join(',')} notable=${notable.join(',') || '-'}`);
  console.log(`   ${format(start)} -> ${format(fin, start)}  turns=${s.turn}`);
  console.log(`   end: ${end ? `${end.type}/${end.result} (${end.win_quality || '-'})` : 'none (still playing)'}`);
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
  const resolved = rs.filter((r) => r.end).length;
  console.log(`${name}: avg trust=${avg('public_trust')} reg=${avg('regulator_confidence')} contain=${avg('containment')} erad=${avg('eradication')} rec=${avg('recovery')} | resolved ${resolved}/${rs.length}`);
}
