/**
 * DM provider registry and settings store.
 *
 * A "DM provider" is anything that can take chat messages and return the DM's
 * reply: an in-browser WebLLM model, or an OpenAI-compatible API (OpenAI,
 * DeepSeek, Anthropic-compatible, or a local Ollama endpoint). The rest of the
 * app talks only to the selected provider through a single `.chat(messages)`
 * interface, so swapping models or adding providers never touches the DM loop.
 *
 * Settings (which provider + its keys) are persisted to localStorage so the
 * app is configuration-light across sessions.
 */

import { OpenAICompatibleProvider } from './openai-compatible.js';
import { WebLLMProvider } from './webllm.js';
import { ServerProxyProvider } from './server-proxy.js';

const SETTINGS_KEY = 'tabletop.dm.settings.v1';

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
    model: 'gemma3:4b',
    viaServer: true,
  },
  {
    id: 'ollama-remote',
    label: 'Ollama (remote)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma3:4b',
    // No viaServer: a remote Ollama is reached DIRECTLY from the browser over
    // its OpenAI-compatible /v1 API (not routed through the app server). The
    // base URL host is editable — point it at the remote box, e.g.
    // http://<host>:11434/v1 — and set an API key if that Ollama requires one.
  },
];

export function defaultSettings() {
  return {
    provider: 'none',          // 'webllm' | 'openai-compatible' | 'server-proxy' | 'none'
    preset: '',                // id of the chosen PRESETS entry ('' = custom)
    apiKey: '',
    baseUrl: '',
    model: '',
    viaServer: false,          // route through the server's /api/dm proxy
    // Company fetch controls
    allowCompanyFetch: true,
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  return PRESETS.find((p) => p.baseUrl === settings.baseUrl);
}

function describeSelection(settings) {
  if (settings.provider === 'webllm') {
    return { id: 'webllm', label: 'In-browser (WebLLM)' };
  }
  if (settings.provider === 'openai-compatible' || settings.provider === 'server-proxy') {
    const preset = findPreset(settings);
    const viaServer = settings.provider === 'server-proxy' || settings.viaServer;
    return {
      id: settings.provider,
      label: viaServer
        ? (preset && preset.viaServer ? preset.label : 'Server proxy')
        : (preset ? preset.label : settings.baseUrl || 'Custom OpenAI-compatible'),
      detail: `${settings.model || 'model?'} @ ${settings.baseUrl || 'no url'}${viaServer ? ' (via server)' : ''}`,
    };
  }
  return { id: 'none', label: 'Not configured', detail: 'Open Settings to connect a DM.' };
}

/**
 * Build the active provider from saved settings.
 * Returns null if none is configured.
 *
 * For the in-browser (WebLLM) path, if a vendored offline bundle exists at
 * vendor/offline-config.json, it is used so the model loads from local files
 * (fully offline). Otherwise it falls back to the CDN + HuggingFace.
 */
export function buildProvider(settings = null) {
  const s = settings || loadSettings();

  if (s.provider === 'webllm') {
    const offline = loadOfflineConfig();
    return new WebLLMProvider({
      model: (offline && offline.model_id) || s.model || 'gemma3-1b-it-q4f16_1-MLC',
      libraryUrl: (offline && offline.library_url) || undefined,
      appConfig: (offline && offline.app_config) || undefined,
    });
  }

  if (s.provider === 'openai-compatible' || s.provider === 'server-proxy') {
    if (!s.baseUrl) return null;
    // Route through the server's /api/dm proxy when the user picked the
    // server-local preset (or explicitly set viaServer). This lets a remote
    // client reach a local Ollama on the server box without exposing Ollama.
    if (s.provider === 'server-proxy' || s.viaServer) {
      return new ServerProxyProvider({
        baseUrl: s.baseUrl,
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

/** Load the vendored offline bundle config, or null if not present. */
export function loadOfflineConfig() {
  try {
    // Synchronous fetch of a static JSON file; only works when served over
    // http(s). Returns null if the bundle isn't vendored.
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'vendor/offline-config.json', false); // sync, small file
    xhr.send();
    if (xhr.status === 200) return JSON.parse(xhr.responseText);
    return null;
  } catch {
    return null;
  }
}

export { WebLLMProvider };

/** Human summary of the current DM configuration (for the UI). */
export function describeProvider(settings) {
  return describeSelection(settings || loadSettings());
}
