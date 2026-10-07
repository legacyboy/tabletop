/**
 * PLAYTEST ALL — plays each remaining authored scenario end-to-end with the real
 * DM model, printing the arc trail, ending, and how the story reads for each.
 * Usage: DM_MODEL=deepseek-v4.1-flash:cloud node tests/playtest-all.mjs [maxTurns]
 */
import { readFileSync } from 'node:fs';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const MAX = parseInt(process.argv[2] || '8', 10);
const ROOT = new URL('../', import.meta.url).pathname;

const SCENARIOS = [
  ['toxic-workplace-viral-post', 'The Toxic Workplace Viral Post'],
  ['rogue-ai', 'The Rogue AI'],
  ['whistleblower', 'The Whistleblower'],
  ['executive-scandal', 'The Executive Scandal'],
];

const line = (c = '-') => c.repeat(78);

for (const [dir, title] of SCENARIOS) {
  const scenario = JSON.parse(readFileSync(ROOT + 'scenarios/' + dir + '/scenario.json', 'utf8'));
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
  const s = new DMSession(provider, scenario);
  s.companyInfo = 'A mid-sized member-owned credit union.';

  console.log(`\n${line('#')}\n#  ${title}  (${dir})\n${line('#')}\n`);
  const open = await s.openScene();
  console.log(`OPENING [beat=${s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-'}]`);
  console.log(open.trim().slice(0, 700));
  console.log('');

  // Generic competent play that adapts to the current beat: acknowledge the
  // beat, take coordinated action, and keep pressing the arc forward.
  const GENERIC = [
    'We convene the response team, put out one clear public statement, brief the frontline so every answer matches, and open a channel for people to report what they know.',
    'We engage the relevant external parties honestly on the record, brief the board and the regulator with facts and a timeline, and task the team to establish exactly what is true.',
    'We investigate the substance ourselves, verify the facts, protect the people who raised concerns, and keep everyone updated as we learn.',
    'We fix what is genuinely wrong, remediate any harm, correct the process failures, and rebuild confidence with a visible follow-through.',
  ];

  let end = null;
  const trail = [];
  for (let i = 0; i < MAX && !end; i++) {
    const res = await s.takeTurn(GENERIC[Math.min(i, GENERIC.length - 1)], 12 + (i % 5));
    const beat = s.beats[s.currentBeatIndex] ? s.beats[s.currentBeatIndex].id : '-';
    const contained = s.attackChain.filter((x) => x.contained).map((x) => x.id);
    trail.push({ turn: s.turn, beat, contained: contained.slice() });
    console.log(line('='));
    console.log(`TURN ${s.turn}  beat=${beat}  breach=${s.breachState}  contained=[${contained.join(',') || '-'}]  q=${s.lastBeatQuality || '-'}`);
    console.log((res.narrative || '').trim());
    console.log(`\n  metrics: trust=${s.state.public_trust} reg=${s.state.regulator_confidence} contain=${s.state.containment} erad=${s.state.eradication} rec=${s.state.recovery}${s.collapsed ? '  [IN CRISIS]' : ''}\n`);
    if (res.endCondition) end = res.endCondition;
  }
  const distinct = new Set(trail.map((t) => t.beat)).size;
  console.log(line('#'));
  console.log(`${title}: ${s.turn} turns | arc ${trail.map((t) => 't' + t.turn + ':' + t.beat).join(' ')} | beats ${distinct}/${s.beats.length}`);
  if (end) {
    console.log(`ENDING: ${end.type}/${end.result}${end.success_kind ? '/' + end.success_kind : ''}${end.win_quality ? ' quality=' + end.win_quality : ''}${end.final_beat ? ' finalBeat=' + end.final_beat : ''}${end.open_stages ? ' open=[' + end.open_stages.join(',') + ']' : ''}`);
    console.log(`HOW IT READS: ${end.win_summary || '-'}`);
    console.log(`WHEREFORE: ${end.why || '-'}`);
  } else {
    console.log(`ENDING: none after ${s.turn} turns (still playing)`);
  }
  console.log('');
}
