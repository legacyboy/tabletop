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

  // Part 1b: full two-sided transcript for the audit trail. For every turn this
  // shows the PLAYER side (the action taken + D20 roll), the exact PROMPT sent
  // to the DM, and the DM's RAW reply (before parsing/cleanup). Omitted for any
  // turn that predates audit capture (older persisted sessions) so the report
  // never shows empty conversation blocks.
  const transcript = session.history
    .filter((e) => Array.isArray(e.dm_prompt) || typeof e.dm_reply === 'string')
    .map((e, i) => ({
      turn: e.turn,
      player_action: e.action,
      player_roll: e.roll,
      dm_prompt: e.dm_prompt || null,
      dm_reply_raw: typeof e.dm_reply === 'string' ? e.dm_reply : null,
      narrative_shown: e.narrative,
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
    part1b_transcript: {
      title: 'Part 1b — Full Transcript (both sides of the conversation)',
      description:
        'The complete DM <-> player exchange for every turn: the player action and D20 roll, the exact prompt sent to the DM, and the DM\'s raw reply, alongside the narrative shown to the group.',
      turns: transcript,
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

  // Part 1b — full two-sided transcript, collapsible per turn.
  const transcriptBlocks = (report.part1b_transcript && report.part1b_transcript.turns || [])
    .map((t) => {
      const promptMsgs = (t.dm_prompt || [])
        .map((m) => `<div style="margin:4px 0"><b style="color:#1f3a5f">${esc(m.role)}:</b><pre style="white-space:pre-wrap;margin:4px 0;background:#f7f8fa;border:1px solid #e3e6ea;padding:8px;font-size:12px;border-radius:4px">${esc(m.content)}</pre></div>`)
        .join('');
      return `
      <details style="border:1px solid #ddd;border-radius:6px;margin:10px 0;padding:8px 12px;background:#fcfcfd">
        <summary style="cursor:pointer;font-weight:600">Turn ${t.turn}${t.turn === 0 ? ' (opening scene)' : ''} — roll ${t.player_roll === null || t.player_roll === undefined ? '—' : t.player_roll}</summary>
        <div style="margin-top:8px">
          <div style="margin:4px 0"><b style="color:#2a6b3f">player action:</b> <span>${esc(t.player_action)}</span></div>
          ${promptMsgs}
          <div style="margin:4px 0"><b style="color:#8a3b00">dm reply (raw):</b><pre style="white-space:pre-wrap;margin:4px 0;background:#fff7f0;border:1px solid #f0e0d0;padding:8px;font-size:12px;border-radius:4px">${esc(t.dm_reply_raw || '(not captured)')}</pre></div>
          <div style="margin:4px 0"><b style="color:#1f3a5f">narrative shown to group:</b><div style="background:#eef4fb;border:1px solid #d6e4f5;padding:8px;border-radius:4px">${esc(t.narrative_shown || '')}</div></div>
        </div>
      </details>`;
    })
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

    ${report.part1b_transcript ? `
    <h2 style="color:#1f3a5f;border-bottom:2px solid #1f3a5f;padding-bottom:6px;margin-top:32px">${esc(report.part1b_transcript.title)}</h2>
    <p style="color:#555">${esc(report.part1b_transcript.description)}</p>
    ${transcriptBlocks || '<p style="color:#888">No transcript captured for this session.</p>'}
    ` : ''}

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
