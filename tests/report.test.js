// Quick test: build a two-part report from a mock session and render HTML.
import { buildReport, renderReportHtml } from '../server/report.js';

// Mock session with a couple of turns.
const session = {
  scenario: {
    scenario_id: 'bramble_badger_deepfake',
    title: 'Bramble Badger Deepfake Crisis',
    report: { title_note: 'Tabletop Exercise Report', audit_note: 'Internal exercise. Not a real incident.' },
  },
  turn: 2,
  startedAt: Date.now() - 125000,
  ending: null,
  state: { budget: 70, reputation: 57, morale: 70, risk: 45, member_confidence: 58, regulator_confidence: 50 },
  history: [
    {
      action: 'Hang up on callers asking about the badger video.',
      roll: 13,
      fate: null,
      narrative: 'The call center staff began disconnecting callers, triggering negative sentiment.',
      state: { budget: 70, reputation: 57, morale: 70, risk: 45, member_confidence: 58, regulator_confidence: 50 },
    },
    {
      action: 'Tell the regulator it is satire and refuse the briefing.',
      roll: 11,
      fate: 'cheese_audit',
      narrative: 'The cheese audit meme wave hit. Risk jumped.',
      state: { budget: 70, reputation: 52, morale: 60, risk: 73, member_confidence: 50, regulator_confidence: 50 },
    },
  ],
};

const report = buildReport(session, {
  participants: 'Executive team (blind playthrough)',
  moderator: 'Steve (facilitator)',
  recommendations: [
    'Tighten DM prompt to punish reckless play more consistently.',
    'Add a second scenario for variety.',
  ],
});

const html = renderReportHtml(report);
console.log('Report title:', report.report_title);
console.log('Part 1 turns:', report.part1_audit.turns.length);
console.log('Part 2 fingerprint:', report.part2_proof.fingerprint);
console.log('Recommendations:', report.recommendations.length);
console.log('HTML length:', html.length, 'bytes');
console.log('HTML has Part 1:', html.includes('Part 1 — Full Audit'));
console.log('HTML has Part 2:', html.includes('Part 2 — Proof of Play'));
console.log('HTML has Recommendations:', html.includes('Recommendations'));
console.log('HTML has fingerprint:', html.includes(report.part2_proof.fingerprint));
