/**
 * Scenario loading + optional live company-info enrichment.
 *
 * Scenarios are listed in scenarios/registry.json and stored as standalone
 * JSON files. The loader fetches them, validates their v2 shape, and can pull
 * public company information when a scenario provides a company_url.
 *
 * Company fetch is best-effort: cross-origin requests to arbitrary sites are
 * often blocked by CORS in the browser. When that happens we fall back to any
 * static company_info in the scenario, and surface a gentle notice so the
 * moderator can paste info manually if they want.
 */

import { loadSettings } from './providers/registry.js';

const REGISTRY_PATH = 'scenarios/registry.json';

/** Minimal v2/v3 validation. Returns { valid, errors }. */
export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== 'object') return { valid: false, errors: ['Scenario is not an object'] };
  if (!scenario.scenario_id) errors.push('missing scenario_id');
  if (!scenario.title) errors.push('missing title');
  if (scenario.version !== 2 && scenario.version !== 3) errors.push('version must be 2 or 3');
  if (!scenario.intro || typeof scenario.intro !== 'object') errors.push('missing intro object');
  if (!scenario.opening_state || typeof scenario.opening_state !== 'object') errors.push('missing opening_state');
  if (!scenario.dm_brief || !scenario.dm_brief.situation) errors.push('dm_brief.situation is required');
  if (scenario.fate_table && typeof scenario.fate_table !== 'object') errors.push('fate_table must be an object');
  return { valid: errors.length === 0, errors };
}

/** Load the registry list of scenarios. */
export async function loadRegistry() {
  const res = await fetch(REGISTRY_PATH);
  if (!res.ok) throw new Error(`Cannot load ${REGISTRY_PATH} (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Registry is not an array.');
  return data;
}

/** Load + validate a single scenario by its registry path. */
export async function loadScenario(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Cannot load scenario ${path} (${res.status})`);
  const scenario = await res.json();
  const check = validateScenario(scenario);
  if (!check.valid) throw new Error(`Scenario ${path} invalid: ${check.errors.join('; ')}`);
  return scenario;
}

/**
 * Best-effort fetch of public info about the organization, to enrich the DM's
 * context with real company details. Returns a string on success, or null when
 * blocked/bypassed. Never throws.
 *
 * The URL comes from the user-entered companyUrl in settings when set
 * (overriding the scenario's own intro.company_url), else from
 * scenario.intro.company_url. When neither is present, or when
 * allowCompanyFetch is disabled, returns null without fetching.
 *
 * Tries a direct browser fetch first (some sites allow CORS); if that fails
 * (blocked), falls back to the optional local proxy at /api/company (the tiny
 * Node server), which fetches server-side and avoids CORS entirely.
 */
export async function fetchCompanyInfo(scenario, opts = {}) {
  const settings = loadSettings();
  if (!settings.allowCompanyFetch) return null;

  // Prefer the user-entered URL (explicit opt-in), else the scenario's.
  const userUrl = opts.companyUrl || settings.companyUrl || '';
  const url = (userUrl || '').trim() || (scenario.intro && scenario.intro.company_url);
  if (!url) return null;

  return (await directFetch(url)) || (await proxyFetch(url));
}

async function directFetch(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
    clearTimeout(t);
    if (!res.ok) return null;
    return summarize(await res.text());
  } catch {
    return null;
  }
}

async function proxyFetch(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch('/api/company?url=' + encodeURIComponent(url), { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

function summarize(html) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  const desc =
    (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1] ||
    (html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i) || [])[1] || '';
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const info = [clean(title) && `Title: ${clean(title)}`, clean(desc) && `Description: ${clean(desc)}`]
    .filter(Boolean)
    .join('\n');
  return info || null;
}
