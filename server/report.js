/**
 * Two-part audit report generator for a tabletop session.
 *
 * Produces a professional, auditor-friendly report with:
 *
 *   PART 1 — Full Audit
 *     Every action the group took, every DM decision, every state change,
 *     the full timeline, and the final state.
 *
 *   PART 2 — Proof of Play
 *     Evidence the exercise actually happened: scenario, participants,
 *     duration, turn count, fate events, end condition, and a verifiable
 *     session fingerprint (hash) so an auditor can confirm integrity.
 *
 *   RECOMMENDATIONS
 *     A section for the moderator to add lessons / follow-up actions.
 *
 * Output: an HTML string (email-friendly) and a JSON object.
 */

import { createHash } from 'node:crypto';

/** Humanize a metric key: member_confidence -> Member Confidence. */
function humanize(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Escape HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

/** Build a verifiable session fingerprint (SHA-256 of the full log). */
function fingerprint(session) {
  const canonical = JSON.stringify({
    scenario_id: session.scenario.scenario_id,
    turns: session.turn,
    history: session.history,
    final_state: session.state,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Format seconds as m:ss. */
function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Build the full report object.
 * @param {DMSession} session
 * @param {object} opts { ending, participants, moderator, recommendations }
 */
export function buildReport(session, opts = {}) {
  const ending = opts.ending || session.ending || null;
  const durationSec = session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : null;
  const fp = fingerprint(session);

  // Part 1: full audit — every turn with action, roll, DM decision, state.
  const audit = session.history.map((e, i) => ({
    turn: i + 1,
    action: e.action,
    roll: e.roll,
    fate: e.fate || null,
    dm_decision: e.narrative,
    state_after: e.state,
  }));

  // Part 2: proof of play.
  const proof = {
    scenario_id: session.scenario.scenario_id,
    scenario_title: session.scenario.title,
    participants: opts.participants || 'Executive team (tabletop exercise)',
    moderator: opts.moderator || 'Facilitator',
    date: new Date().toISOString(),
    duration_seconds: durationSec,
    duration: fmtDuration(durationSec),
    turns: session.turn,
    fate_events: session.history.filter((e) => e.fate).length,
    end_condition: ending,
    final_state: session.state,
    fingerprint: fp,
    integrity_note:
      'This report is generated from the session log. The fingerprint is a SHA-256 hash of the full turn log, final state, and scenario id; any alteration invalidates it.',
  };

  // BDB-style debrief: which attack-chain stages the group contained and
  // which they missed. Executive-focused (plain-language stage names).
  const chain = session.attackChain || [];
  const chainDebrief = chain.length
    ? {
        title: 'Attack chain debrief',
        contained: chain.filter((s) => s.contained).map((s) => s.name),
        missed: chain.filter((s) => !s.contained).map((s) => s.name),
        contained_count: chain.filter((s) => s.contained).length,
        total: chain.length,
        breach_state: session.breachState || '—',
      }
    : null;

  return {
    report_title: (session.scenario.report && session.scenario.report.title_note) || 'Tabletop Exercise Report',
    scenario: session.scenario.title,
    scenario_id: session.scenario.scenario_id,
    generated_at: new Date().toISOString(),
    part1_audit: {
      title: 'Part 1 — Full Audit',
      description: 'Every action taken, every DM decision, and every state change during the exercise.',
      turns: audit,
      final_state: session.state,
    },
    part2_proof: {
      title: 'Part 2 — Proof of Play',
      description: 'Evidence the exercise was conducted, for an auditor.',
      ...proof,
    },
    attack_chain_debrief: chainDebrief,
    recommendations: opts.recommendations || [],
    audit_note: (session.scenario.report && session.scenario.report.audit_note) || '',
  };
}

/** Render the report as a self-contained HTML email body. */
export function renderReportHtml(report) {
  const stateRows = Object.entries(report.part1_audit.final_state)
    .map(([k, v]) => `<tr><td>${esc(humanize(k))}</td><td>${v}</td></tr>`)
    .join('');

  const turnRows = report.part1_audit.turns
    .map(
      (t) => `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap">${t.turn}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${esc(t.action)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${t.roll === null || t.roll === undefined ? '—' : t.roll}${t.fate ? ' ⚡' : ''}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${esc(t.dm_decision)}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top;font-size:12px">${esc(JSON.stringify(t.state_after))}</td>
      </tr>`
    )
    .join('');

  const recRows = (report.recommendations || [])
    .map((r, i) => `<li><b>${i + 1}.</b> ${esc(r)}</li>`)
    .join('');

  const proof = report.part2_proof;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(report.report_title)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a;line-height:1.5;margin:0;padding:24px;background:#f5f6f8">
<div style="max-width:900px;margin:auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
  <div style="background:#1f3a5f;color:#fff;padding:20px 28px">
    <h1 style="margin:0;font-size:22px">${esc(report.report_title)}</h1>
    <p style="margin:6px 0 0;opacity:.85">${esc(report.scenario)} · Generated ${esc(report.generated_at)}</p>
  </div>

  <div style="padding:24px 28px">
    <h2 style="color:#1f3a5f;border-bottom:2px solid #1f3a5f;padding-bottom:6px">${esc(report.part1_audit.title)}</h2>
    <p style="color:#555">${esc(report.part1_audit.description)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#eef2f7">
        <th style="padding:8px;border:1px solid #ddd;text-align:left">Turn</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left">Action taken</th>
        <th style="padding:8px;border:1px solid #ddd">D20</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left">DM decision / outcome</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left">State after</th>
      </tr></thead>
      <tbody>${turnRows}</tbody>
    </table>

    <h3 style="color:#1f3a5f;margin-top:24px">Final state</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#eef2f7"><th style="padding:8px;border:1px solid #ddd;text-align:left">Metric</th><th style="padding:8px;border:1px solid #ddd">Value</th></tr></thead>
      <tbody>${stateRows}</tbody>
    </table>

    ${report.attack_chain_debrief ? `
    <h3 style="color:#1f3a5f;margin-top:24px">Attack chain debrief</h3>
    <p style="color:#555">Which stages of the attack the group contained and which they missed.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tbody>
        <tr><td style="padding:6px;border:1px solid #ddd;width:40%"><b>Contained</b></td><td style="padding:6px;border:1px solid #ddd">${esc((report.attack_chain_debrief.contained || []).join(', ') || 'None')} (${report.attack_chain_debrief.contained_count}/${report.attack_chain_debrief.total})</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Missed</b></td><td style="padding:6px;border:1px solid #ddd">${esc((report.attack_chain_debrief.missed || []).join(', ') || 'None')}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Final breach state</b></td><td style="padding:6px;border:1px solid #ddd">${esc(report.attack_chain_debrief.breach_state)}</td></tr>
      </tbody>
    </table>
    ` : ''}

    <h2 style="color:#1f3a5f;border-bottom:2px solid #1f3a5f;padding-bottom:6px;margin-top:32px">${esc(report.part2_proof.title)}</h2>
    <p style="color:#555">${esc(report.part2_proof.description)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tbody>
        <tr><td style="padding:6px;border:1px solid #ddd;width:40%"><b>Scenario</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.scenario_title)} (${esc(proof.scenario_id)})</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Participants</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.participants)}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Moderator</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.moderator)}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Date</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.date)}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Duration</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.duration)}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Turns played</b></td><td style="padding:6px;border:1px solid #ddd">${proof.turns}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Fate events</b></td><td style="padding:6px;border:1px solid #ddd">${proof.fate_events}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>End condition</b></td><td style="padding:6px;border:1px solid #ddd">${esc(proof.end_condition || 'None (session ended manually)')}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Session fingerprint</b></td><td style="padding:6px;border:1px solid #ddd;font-family:monospace;font-size:12px">${esc(proof.fingerprint)}</td></tr>
      </tbody>
    </table>
    <p style="color:#888;font-size:12px;margin-top:8px">${esc(proof.integrity_note)}</p>

    <h2 style="color:#1f3a5f;border-bottom:2px solid #1f3a5f;padding-bottom:6px;margin-top:32px">Recommendations</h2>
    ${recRows ? `<ol>${recRows}</ol>` : '<p style="color:#888">No recommendations recorded.</p>'}

    ${report.audit_note ? `<p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">${esc(report.audit_note)}</p>` : ''}
  </div>
</div>
</body></html>`;
}
