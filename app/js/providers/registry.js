/**
 * DM provider registry and settings store.
 *
 * A "DM provider" is anything that can take chat messages and return the DM's
 * reply: an OpenAI-compatible API (OpenAI, DeepSeek, Anthropic-compatible) or
 * an Ollama endpoint (reached via the server proxy). The rest of the app talks
 * only to the selected provider through a single `.chat(messages)` interface,
 * so swapping models or adding providers never touches the DM loop.
 *
 * Settings (which provider + its keys) are persisted to localStorage so the
 * app is configuration-light across sessions. The app runs on API keys — there
 * is no in-browser model path.
 */

import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ServerProxyProvider } from './server-proxy.js';

const SETTINGS_KEY = 'tabletop.dm.settings.v1';

/**
 * In-memory API key for session-only storage. When the user unchecks
 * "Remember my key", the key is kept here (never written to localStorage) so
 * the current session keeps working but the key is gone when the tab closes.
 */
let sessionApiKey = '';

/**
 * Common Ollama models offered in the settings dropdown for the
 * "Ollama (remote)" preset. Each entry is { value, label } where value is the
 * model id sent to the server and label is what the user sees. deepseek-v4-flash:cloud
 * is first and is the preset default DM (1M context, latest cloud build).
 */
export const OLLAMA_MODELS = [
  { value: 'deepseek-v4-flash:cloud', label: 'DeepSeek Flash' },
  { value: 'glm-5.2:cloud', label: 'GLM 5.2' },
  { value: 'qwen3.5:397b-cloud', label: 'Qwen 3.5' },
];

/** Built-in presets for the "plug a key" section. */
export const PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (OpenAI-compatible)',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-latest',
  },
  {
    id: 'server-local',
    label: 'Server (local Ollama)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-v4-flash:cloud',
    viaServer: true,
  },
  {
    id: 'ollama-remote',
    label: 'Ollama (remote)',
    // No base URL field: this preset is routed through the app server's
    // /api/dm proxy (viaServer), which reaches the remote Ollama using the
    // server-side OLLAMA_URL (default http://localhost:11434/v1). A browser on
    // the public internet can't reach a private remote Ollama directly, so we
    // never expose a URL to the user — the connection "just goes to Ollama"
    // from the server's perspective. The settings UI hides the Base URL field
    // for this preset.
    viaServer: true,
    model: 'deepseek-v4-flash:cloud',
  },
];

export function defaultSettings() {
  return {
    provider: 'none',          // 'openai-compatible' | 'server-proxy' | 'none'
    preset: '',                // id of the chosen PRESETS entry ('' = custom)
    apiKey: '',
    baseUrl: '',
    model: '',
    viaServer: false,          // route through the server's /api/dm proxy
    // Key persistence: when true the API key is written to localStorage;
    // when false it is kept only in memory for the current session.
    rememberKey: true,
    // Company fetch controls
    allowCompanyFetch: true,
    companyUrl: '',          // user-provided company URL (overrides scenario intro.company_url)
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const s = { ...defaultSettings(), ...JSON.parse(raw) };
    // Session-only key: pull it from memory (if set this session) so the
    // current session still works even though the key isn't persisted.
    if (!s.rememberKey) s.apiKey = sessionApiKey;
    return s;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  if (settings.rememberKey) {
    // Persist the key normally.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } else {
    // Session-only: keep the key in memory and persist everything else with
    // the key cleared so it never touches localStorage.
    sessionApiKey = settings.apiKey || '';
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, apiKey: '' }));
  }
}

/**
 * Match a settings object to a built-in preset. Prefers the stored preset id
 * (set when the user picks a dropdown entry) so presets that share a base URL
 * (e.g. local vs remote Ollama) are told apart, then falls back to base-URL
 * matching for older saved settings that predate the preset id field.
 */
function findPreset(settings) {
  if (settings.preset) {
    const byId = PRESETS.find((p) => p.id === settings.preset);
    if (byId) return byId;
  }
  // Only fall back to base-URL matching when a URL is actually set. Presets
  // with no base URL (e.g. remote Ollama, which routes via the server proxy)
  // must not match anything by URL.
  if (settings.baseUrl) {
    return PRESETS.find((p) => p.baseUrl === settings.baseUrl);
  }
  return undefined;
}

function describeSelection(settings) {
  if (settings.provider === 'openai-compatible' || settings.provider === 'server-proxy') {
    const preset = findPreset(settings);
    const viaServer = settings.provider === 'server-proxy' || settings.viaServer;
    // A server-routed preset with no base URL (e.g. remote Ollama) needs no
    // URL in the browser — the server reaches Ollama with its own OLLAMA_URL.
    const detailUrl = settings.baseUrl || (viaServer ? 'via server (Ollama)' : 'no url');
    return {
      id: settings.provider,
      label: viaServer
        ? (preset && preset.viaServer ? preset.label : 'Server proxy')
        : (preset ? preset.label : settings.baseUrl || 'Custom OpenAI-compatible'),
      detail: `${settings.model || 'model?'} @ ${detailUrl}${viaServer && settings.baseUrl ? ' (via server)' : ''}`,
    };
  }
  return { id: 'none', label: 'Not configured', detail: 'Open Settings to connect a DM.' };
}

/**
 * Build the active provider from saved settings.
 * Returns null if none is configured.
 */
export function buildProvider(settings = null) {
  const s = settings || loadSettings();

  if (s.provider === 'openai-compatible' || s.provider === 'server-proxy') {
    const viaServer = s.provider === 'server-proxy' || s.viaServer;
    // A direct (browser -> provider) connection needs an explicit base URL.
    // A server-routed connection may leave it blank: the server fills in its
    // own OLLAMA_URL default (e.g. remote Ollama, where the user never sees a
    // base URL field at all).
    if (!viaServer && !s.baseUrl) return null;
    // Route through the server's /api/dm proxy when the user picked the
    // server-local / remote-Ollama preset (or a set viaServer). This lets a
    // client reach an Ollama on/behind the server box without exposing Ollama
    // to the browser or asking the user for a URL.
    if (viaServer) {
      return new ServerProxyProvider({
        baseUrl: s.baseUrl || '',
        apiKey: s.apiKey,
        model: s.model,
      });
    }
    return new OpenAICompatibleProvider({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
    });
  }

  return null;
}

/** Human summary of the current DM configuration (for the UI). */
export function describeProvider(settings) {
  return describeSelection(settings || loadSettings());
}
