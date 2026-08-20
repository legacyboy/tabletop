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
    name: 'narrative with literal line break (state_delta survives, narrative recovered)',
    input: '{\n  "narrative": "First line\nsecond line",\n  "state_delta": { "reputation": -10, "risk": 5 }\n}',
    expect: { narrative: 'First line\nsecond line', state_delta: { reputation: -10, risk: 5 } },
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
  {
    name: 'double-encoded narrative (narrative is itself a JSON string)',
    input: '{"narrative": "\\"The CEO convened the board and issued a statement.\\"", "state_delta": {"public_trust": -2}}',
    expect: { narrative: 'The CEO convened the board and issued a statement.', state_delta: { public_trust: -2 } },
  },
  {
    name: 'raw JSON object leaked as narrative is stripped to prose',
    input: '{"narrative": {"narrative": "The team acted decisively.", "state_delta": {"public_trust": 2}}}',
    expect: { narrative: 'The team acted decisively.' },
  },
  {
    name: 'unparseable JSON with narrative key falls back to clean prose',
    input: '{"narrative": "The team issued a statement and monitored the situation.", "state_delta": {',
    expect: { narrative: 'The team issued a statement and monitored the situation.' },
  },
  {
    name: 'unescaped quote in narrative: state_delta preserved, narrative truncated to prose (no JSON leak)',
    input: '```json\n{\n  "narrative": "A member posts a screenshot that reads as \"confused\". [e1]",\n  "state_delta": { "public_trust": -5 },\n  "progress": true,\n  "reveal_stage": "null",\n  "contain_stage": "null"\n}\n```',
    expect: { narrative: 'A member posts a screenshot that reads as', state_delta: { public_trust: -5 } },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = s._extractJson(c.input);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) pass++; else { fail++; console.log('FAIL', c.name, 'got', JSON.stringify(got)); }
}

// Extra: takeTurn-level guard — a DM reply that is raw JSON (even unparseable)
// must NEVER surface as the player-facing narrative.
const s2 = new DMSession({ chat: async () => '```json\n{"narrative": "The team acted.\" state_delta missing", "state_delta": {', }, { opening_state: { public_trust: 50 }, end_conditions: [] });
const r = await s2.takeTurn('Act', 10);
const looksLikeJson = /^[{\[]/.test(r.narrative.trim()) || r.narrative.includes('state_delta') || r.narrative.includes('narrative\"');
if (!looksLikeJson) pass++; else { fail++; console.log('FAIL takeTurn never leaks raw JSON, got:', JSON.stringify(r.narrative)); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
