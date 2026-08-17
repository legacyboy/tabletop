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
];

export function defaultSettings() {
  return {
    provider: 'none',          // 'webllm' | 'openai-compatible' | 'none'
    apiKey: '',
    baseUrl: '',
    model: '',
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

function describeSelection(settings) {
  if (settings.provider === 'webllm') {
    return { id: 'webllm', label: 'In-browser (WebLLM)' };
  }
  if (settings.provider === 'openai-compatible') {
    const preset = PRESETS.find((p) => p.baseUrl === settings.baseUrl);
    return {
      id: 'openai-compatible',
      label: preset ? preset.label : settings.baseUrl || 'Custom OpenAI-compatible',
      detail: `${settings.model || 'model?'} @ ${settings.baseUrl || 'no url'}`,
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
      model: (offline && offline.model_id) || s.model || 'gemma-3-4b-it-q4f16_1-MLC',
      libraryUrl: (offline && offline.library_url) || undefined,
      appConfig: (offline && offline.app_config) || undefined,
    });
  }

  if (s.provider === 'openai-compatible') {
    if (!s.baseUrl) return null;
    return new OpenAICompatibleProvider({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
    });
  }

  return null;
}

/** Load the vendored offline bundle config, or null if not present. */
function loadOfflineConfig() {
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
