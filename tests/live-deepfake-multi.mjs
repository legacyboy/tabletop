// Multi-run Deepfake CEO test: N runs, per-run summary, aggregated results.
// Usage: node tests/live-deepfake-multi.mjs [runs]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { DMSession } from '../app/js/dm.js';

const RUNS = parseInt(process.argv[2] || '3', 10);
const MODEL = process.env.TEST_MODEL || 'deepseek-v4.1-flash:cloud';
const BASE = 'http://localhost:11434/v1';
const ROOT = new URL('../', import.meta.url).pathname;

const scenario = JSON.parse(readFileSync(join(ROOT, 'scenarios/bramble-badger-deepfake/scenario.json'), 'utf8'));

// Cycle through a few plausible team strategies so runs aren't identical.
const strategies = [
  [ // full arc
    'We issue a public statement confirming the deepfake and set up a member hotline.',
    'We brief the board and regulator, and have IT trace the seed through the agency console.',
    'We activate fraud monitoring and warn members about the phishing wave.',
    'The CEO records a direct on-camera denial and we post a member FAQ.',
    'We work with platforms to take down the video and map the amplifier network.',
    'We follow up with affected members, review controls, and prep a lessons-learned.',
    'We hold a staff town hall and hand the regulator a full timeline + evidence package.',
  ],
  [ // slow/publicity-first
    'We issue a short holding statement but otherwise stay quiet while we investigate internally.',
    'We bring in a crisis PR firm to shape the messaging before we go public.',
    'We only alert the board privately and hold off telling members anything yet.',
    'Under reporter pressure, we release a minimal statement with no CEO appearance.',
    'We finally work with platforms to take down the video.',
    'We begin reaching out to affected members one by one.',
    'We brief the regulator with everything we have learned.',
  ],
  [ // aggressive full-frontal
    'We immediately go public: live press conference, CEO on camera, direct call to law enforcement.',
    'We freeze the compromised agency account and publish all forensic logs.',
    'We blast an all-members alert and activate 24/7 fraud monitoring.',
    'We threaten legal action against the platform and demand a takedown deadline.',
    'We publicly name the likely source and announce we are pursuing criminal charges.',
    'We launch a member-compensation fund and guarantee deposits in writing.',
    'We publish a full post-mortem and hold a public town hall Q&A.',
  ],
];

async function run(strategyIdx, runLabel) {
  const provider = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: '', model: MODEL });
  const session = new DMSession(provider, scenario);
  const a = strategies[strategyIdx % strategies.length];

  const opening = await session.openScene();
  const first = (opening || '').replace(/\s+/g, ' ').slice(0, 90);

  const path = [];
  for (let i = 0; i < a.length; i++) {
    const res = await session.takeTurn(a[i], 12);
    const narr = (res && (res.narrative || res.text)) || '';
    const st = session.state || {};
    // Detect if the session ended this turn (loss or win).
    const ended = !!(res && (res.endCondition || res.ending || res.result));
    path.push({
      t: i + 1,
      trust: st.public_trust,
      reg: st.regulator_confidence,
      contain: st.containment,
      erad: st.eradication,
      narr: narr ? narr.replace(/\s+/g, ' ').slice(0, 160) : '(empty)',
      ended,
    });
  }
  const st = session.state || {};
  return {
    label: runLabel,
    strategy: a[0].slice(0, 50),
    opening: first,
    path,
    final: { trust: st.public_trust, reg: st.regulator_confidence, contain: st.containment, erad: st.eradication },
  };
}

console.log(`Running ${RUNS} Deepfake CEO test runs...\n`);
const results = [];
for (let r = 0; r < RUNS; r++) {
  results.push(await run(r, `Run ${r + 1}`));
}
for (const res of results) {
  console.log(`===== ${res.label} =====`);
  console.log(`STRATEGY: ${res.strategy}...`);
  console.log(`OPENING: ${res.opening}...`);
  const p = res.path.map((x) => `T${x.t}:trust=${x.trust} reg=${x.reg} contain=${x.contain} erad=${x.erad}${x.ended ? ' [ENDED]' : ''}`).join('\n  ');
  console.log(`  ${p}`);
  console.log(`FINAL: trust=${res.final.trust} reg=${res.final.reg} contain=${res.final.contain} erad=${res.final.erad}`);
  // Sample first narrative of a mid turn
  const mid = res.path[4] || res.path[0];
  console.log(`MID NARRATIVE (T${(res.path[4]||res.path[0]).t}): ${(res.path[4]||res.path[0]).narr}...`);
  console.log('');
}
console.log('DONE');
