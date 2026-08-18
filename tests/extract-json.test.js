// Verify the _extractJson fix handles markdown-fenced JSON (the poor-play bug).
import { DMSession } from '../app/js/dm.js';

const s = new DMSession({ chat: async () => '' }, { opening_state: {}, end_conditions: [] });

const cases = [
  {
    name: 'plain JSON',
    input: '{"narrative":"hi","state_delta":{"risk":5}}',
    expect: { narrative: 'hi', state_delta: { risk: 5 } },
  },
  {
    name: 'markdown-fenced JSON (the bug)',
    input: '```json\n{"narrative":"satire","state_delta":{"reputation":-8}}\n```',
    expect: { narrative: 'satire', state_delta: { reputation: -8 } },
  },
  {
    name: 'prose + JSON block',
    input: 'Here is the result:\n{"narrative":"ok","state_delta":{"morale":2}}',
    expect: { narrative: 'ok', state_delta: { morale: 2 } },
  },
  {
    name: 'no JSON at all',
    input: 'The team handled it well.',
    expect: {},
  },
  {
    name: 'narrative with literal line break (state_delta survives)',
    input: '{\n  "narrative": "First line\nsecond line",\n  "state_delta": { "reputation": -10, "risk": 5 }\n}',
    expect: { state_delta: { reputation: -10, risk: 5 } },
  },
  {
    name: 'truncated mid-JSON (token cap) recovers narrative',
    input: '```json\n{\n  "narrative": "The team swiftly drafted a statement acknowledging the video, assuring members that it\'s a hoax, and emphasizing the credit union\'s commitment to security. Simultaneously, ',
    expect: { narrative: "The team swiftly drafted a statement acknowledging the video, assuring members that it's a hoax, and emphasizing the credit union's commitment to security. Simultaneously," },
  },
  {
    name: 'double-escaped narrative is unescaped',
    input: '{"narrative": "The CEO said \\"hello\\" to the board.", "state_delta": {"risk": 3}}',
    expect: { narrative: 'The CEO said "hello" to the board.', state_delta: { risk: 3 } },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = s._extractJson(c.input);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) pass++; else { fail++; console.log('FAIL', c.name, 'got', JSON.stringify(got)); }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
