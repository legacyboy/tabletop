/**
 * Repeatability sweep: run the opening scene N times per scenario and measure
 * how often the narrative does NOT end on terminal punctuation. Distinguishes
 * a hard truncation (cut mid-word) from a stylistic soft ending (colon/dash).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';

const MODEL = process.env.DM_MODEL || 'deepseek-v4.1-flash:cloud';
const N = parseInt(process.env.N || '4', 10);
const ROOT = new URL('../', import.meta.url).pathname;
const registry = JSON.parse(readFileSync(join(ROOT, 'scenarios/registry.json'), 'utf8'))
  .filter((e) => !e.random);

const endsClean = (s) => /[.!?"')\]]\s*$/.test(String(s).trim());
const cutMidWord = (s) => /[a-z]$/.test(String(s).trim()); // ends on a bare lowercase letter

let totalRuns = 0, soft = 0, hard = 0;
const softExamples = [];

for (const entry of registry) {
  const scenario = JSON.parse(readFileSync(join(ROOT, entry.path), 'utf8'));
  let softHere = 0;
  for (let i = 0; i < N; i++) {
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: MODEL });
    const s = new DMSession(provider, scenario);
    s.companyInfo = 'A mid-sized member-owned credit union.';
    const opening = await s.openScene();
    totalRuns++;
    if (!endsClean(opening)) {
      if (cutMidWord(opening)) { hard++; }
      else { soft++; softHere++; if (softExamples.length < 3) softExamples.push(String(opening).slice(-90)); }
    }
  }
  console.log(`${entry.id}: ${softHere} soft / ${N} runs`);
}

console.log(`\n=== REPEATABILITY (${MODEL}, ${totalRuns} runs) ===`);
console.log(`soft (ends on colon/dash/quote, not mid-word): ${soft}`);
console.log(`hard (ends mid-word / truncated):              ${hard}`);
console.log(`clean rate: ${(((totalRuns - soft - hard) / totalRuns) * 100).toFixed(1)}%`);
if (softExamples.length) {
  console.log('\nsoft-ending examples (last 90 chars):');
  for (const e of softExamples) console.log('  ...' + JSON.stringify(e));
}
