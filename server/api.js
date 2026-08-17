/**
 * Executive Tabletop D20 — HTTP API (curl-playable).
 *
 * Lets you run a full tabletop session from the command line:
 *
 *   # list scenarios
 *   curl localhost:8000/api/scenarios
 *
 *   # create a session (uses local Ollama by default; pass base_url/api_key/model to override)
 *   curl -X POST localhost:8000/api/session \
 *     -H 'Content-Type: application/json' \
 *     -d '{"scenario_id":"bramble_badger_deepfake"}'
 *
 *   # take a turn
 *   curl -X POST localhost:8000/api/session/<id>/turn \
 *     -H 'Content-Type: application/json' \
 *     -d '{"action":"Issue a calm public statement","roll":15}'
 *
 *   # get state / report
 *   curl localhost:8000/api/session/<id>
 *   curl localhost:8000/api/session/<id>/report
 *
 * Provider config (per-request, with env defaults):
 *   base_url  (default OLLAMA_URL or http://localhost:11434/v1)
 *   api_key   (default OLLAMA_API_KEY or '')
 *   model     (default MODEL or gemma3:4b)
 *
 * Sessions are held in memory (Map). Restarting the server clears them.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMSession } from '../app/js/dm.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { saveSession, loadAll, deleteSession } from './persistence.js';
import { buildReport, renderReportHtml } from './report.js';
import { sendEmail } from './gmail.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// In-memory session store: id -> DMSession
const sessions = new Map();
let sessionSeq = 0;

// Provider config per session id (needed to rebuild on restart).
const providerConfigs = new Map();

const ENV = {
  baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434/v1',
  apiKey: process.env.OLLAMA_API_KEY || '',
  model: process.env.MODEL || 'gemma3:4b',
};

/** Load the scenario registry. */
async function loadRegistry() {
  const raw = await readFile(join(ROOT, 'scenarios/registry.json'), 'utf8');
  return JSON.parse(raw);
}

/** Load a scenario by id (from the registry). */
async function loadScenarioById(id) {
  const registry = await loadRegistry();
  const entry = registry.find((s) => s.id === id);
  if (!entry) return null;
  const raw = await readFile(join(ROOT, entry.path), 'utf8');
  return JSON.parse(raw);
}

/** Read a JSON request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response. Returns true so handlers can `return json(...)`. */
function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
  return true;
}

/** Build a provider from request body + env defaults. */
function buildProvider(body) {
  return new OpenAICompatibleProvider({
    baseUrl: body.base_url || ENV.baseUrl,
    apiKey: body.api_key || ENV.apiKey,
    model: body.model || ENV.model,
  });
}

/** Public view of a session (no internal history unless requested). */
function sessionView(session, { includeLog = false } = {}) {
  const view = {
    id: session.id,
    scenario_id: session.scenario.scenario_id,
    title: session.scenario.title,
    turn: session.turn,
    state: session.state,
    seconds_left: session.secondsLeft(),
    duration_seconds: session.durationSeconds,
    ended: session.ended || false,
    ending: session.ending || null,
  };
  if (includeLog) view.log = session.history;
  return view;
}

/**
 * Route the API. Returns true if handled, false if not an API route.
 */
export async function handleApi(req, res, pathname, url) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // GET /api/scenarios
  if (pathname === '/api/scenarios' && req.method === 'GET') {
    const registry = await loadRegistry();
    return json(res, 200, { scenarios: registry });
  }

  // GET /api/scenarios/:id
  const scenarioMatch = pathname.match(/^\/api\/scenarios\/([^/]+)$/);
  if (scenarioMatch && req.method === 'GET') {
    const scenario = await loadScenarioById(decodeURIComponent(scenarioMatch[1]));
    if (!scenario) return json(res, 404, { error: 'Scenario not found' });
    return json(res, 200, {
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      intro: scenario.intro,
      opening_state: scenario.opening_state,
      meta: scenario.meta,
    });
  }

  // POST /api/session
  if (pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req);
    const scenario = await loadScenarioById(body.scenario_id);
    if (!scenario) return json(res, 404, { error: 'Scenario not found: ' + body.scenario_id });

    let provider;
    try {
      provider = buildProvider(body);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const session = new DMSession(provider, scenario);
    session.id = 's' + (++sessionSeq);
    session.ended = false;
    session.ending = null;
    session.start();
    sessions.set(session.id, session);
    providerConfigs.set(session.id, {
      base_url: body.base_url || ENV.baseUrl,
      api_key: body.api_key || ENV.apiKey,
      model: body.model || ENV.model,
    });
    await saveSession(session.id, session.serialize(), providerConfigs.get(session.id));

    return json(res, 201, {
      id: session.id,
      message: 'Session created. POST to /api/session/' + session.id + '/turn to play.',
      scenario: scenario.title,
      opening_state: session.state,
      seconds_left: session.secondsLeft(),
    });
  }

  // GET /api/session/:id
  const sessionGet = pathname.match(/^\/api\/session\/([^/]+)$/);
  if (sessionGet && req.method === 'GET') {
    const session = sessions.get(sessionGet[1]);
    if (!session) return json(res, 404, { error: 'Session not found' });
    return json(res, 200, sessionView(session, { includeLog: true }));
  }

  // POST /api/session/:id/turn
  const turnMatch = pathname.match(/^\/api\/session\/([^/]+)\/turn$/);
  if (turnMatch && req.method === 'POST') {
    const session = sessions.get(turnMatch[1]);
    if (!session) return json(res, 404, { error: 'Session not found' });

    if (session.ended) {
      return json(res, 400, { error: 'Session already ended', ending: session.ending });
    }

    const body = await readBody(req);
    const action = (body.action || '').trim();
    const roll = body.roll;

    if (!action) return json(res, 400, { error: 'action is required' });
    if (!Number.isInteger(roll) || roll < 1 || roll > 20) {
      return json(res, 400, { error: 'roll must be an integer 1-20' });
    }

    try {
      const result = await session.takeTurn(action, roll);
      if (result.endCondition) {
        session.ended = true;
        session.ending = result.endCondition.ending;
      }
      // Persist after every turn so a restart doesn't lose progress.
      await saveSession(session.id, session.serialize(), providerConfigs.get(session.id));
      return json(res, 200, {
        turn: result.event.turn,
        roll,
        narrative: result.narrative,
        fate: result.event.fate || null,
        state: result.state,
        end_condition: result.endCondition ? result.endCondition.ending : null,
        ended: session.ended,
      });
    } catch (err) {
      return json(res, 502, { error: 'DM error: ' + err.message });
    }
  }

  // GET /api/session/:id/report
  const reportMatch = pathname.match(/^\/api\/session\/([^/]+)\/report$/);
  if (reportMatch && req.method === 'GET') {
    const session = sessions.get(reportMatch[1]);
    if (!session) return json(res, 404, { error: 'Session not found' });
    const report = buildReport(session, { ending: session.ending });
    return json(res, 200, report);
  }

  // POST /api/session/:id/report/email — generate the two-part report and email it.
  const emailMatch = pathname.match(/^\/api\/session\/([^/]+)\/report\/email$/);
  if (emailMatch && req.method === 'POST') {
    const session = sessions.get(emailMatch[1]);
    if (!session) return json(res, 404, { error: 'Session not found' });
    const body = await readBody(req);
    const report = buildReport(session, {
      ending: session.ending,
      participants: body.participants,
      moderator: body.moderator,
      recommendations: body.recommendations || [],
    });
    const html = renderReportHtml(report);
    const subject = body.subject || `Tabletop Exercise Report — ${report.scenario}`;
    const to = body.to || process.env.REPORT_TO || 'legacyboy@gmail.com';

    try {
      await sendEmail({ to, subject, html });
      return json(res, 200, {
        message: 'Report emailed',
        to,
        subject,
        fingerprint: report.part2_proof.fingerprint,
      });
    } catch (err) {
      return json(res, 502, { error: 'Email send failed: ' + err.message });
    }
  }

  // DELETE /api/session/:id
  const deleteMatch = pathname.match(/^\/api\/session\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = deleteMatch[1];
    if (!sessions.has(id)) return json(res, 404, { error: 'Session not found' });
    sessions.delete(id);
    providerConfigs.delete(id);
    await deleteSession(id);
    return json(res, 200, { message: 'Session deleted', id });
  }

  return false; // not an API route
}

/**
 * Restore persisted sessions into the in-memory store. Call once at startup.
 * Returns the number of sessions restored.
 */
export async function restoreSessions() {
  const saved = await loadAll();
  let restored = 0;
  for (const [id, data] of saved) {
    try {
      const scenario = await loadScenarioById(data.snapshot.scenario_id);
      if (!scenario) continue;
      const provider = new OpenAICompatibleProvider({
        baseUrl: data.providerConfig.base_url || ENV.baseUrl,
        apiKey: data.providerConfig.api_key || ENV.apiKey,
        model: data.providerConfig.model || ENV.model,
      });
      const session = DMSession.restore(provider, scenario, data.snapshot);
      session.id = id;
      sessions.set(id, session);
      providerConfigs.set(id, data.providerConfig);
      // Track the highest sequence so new ids don't collide.
      const n = parseInt(id.replace(/^s/, ''), 10);
      if (!Number.isNaN(n) && n > sessionSeq) sessionSeq = n;
      restored++;
    } catch {
      // skip corrupt session files
    }
  }
  return restored;
}
