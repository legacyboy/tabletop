/**
 * DM Settings UI.
 *
 * Lets the moderator configure which LLM runs the DM:
 *   - In-browser model (WebLLM) for the portable, standalone path
 *   - An OpenAI-compatible API (OpenAI / DeepSeek / Anthropic-compatible /
 *     custom), including a local Ollama endpoint for a fast free Gemma.
 *
 * The "API keys" section supports plugging a key for any OpenAI-compatible
 * provider; nothing is stored server-side, only in the browser's localStorage.
 * Keys are never sent to this app's origin, only straight to the chosen LLM
 * provider.
 */

import {
  PRESETS,
  buildProvider,
  defaultSettings,
  loadSettings,
  saveSettings,
  describeProvider,
} from './providers/registry.js';

const $ = (id) => document.getElementById(id);
const el = {};

let current = null;

export function initSettings() {
  ['providerSelect', 'preset', 'apiKey', 'baseUrl', 'model', 'allowCompanyFetch',
   'saveSettings', 'testConnection', 'settingsStatus', 'settingsSummary',
   'settingsBack', 'companyFetchHint',
  ].forEach((id) => { el[id] = $(id); });

  if (!el.providerSelect) return; // phase not in DOM

  current = loadSettings();
  renderForm();

  el.providerSelect.onchange = () => {
    current.provider = el.providerSelect.value;
    renderDynamic();
  };

  el.preset.onchange = () => {
    const p = PRESETS.find((x) => x.id === el.preset.value);
    if (p) {
      current.baseUrl = p.baseUrl;
      current.model = p.model;
      el.baseUrl.value = p.baseUrl;
      el.model.value = p.model;
    }
  };

  el.saveSettings.onclick = () => {
    current.apiKey = el.apiKey.value.trim();
    current.baseUrl = el.baseUrl.value.trim();
    current.model = el.model.value.trim();
    current.allowCompanyFetch = el.allowCompanyFetch.checked;

    const check = buildProvider(current);
    if (current.provider !== 'none' && !check) {
      el.settingsStatus.textContent = 'Cannot save: missing base URL or model for this provider.';
      return;
    }

    saveSettings(current);
    el.settingsStatus.textContent = 'Saved. Detected DM: ' + describeProvider(current).label + '.';
  };

  el.testConnection.onclick = async () => {
    const provider = buildProvider(current);
    if (!provider) {
      el.settingsStatus.textContent = 'Choose a provider first.';
      return;
    }
    el.settingsStatus.textContent = 'Testing connection...';
    try {
      await provider.ping();
      el.settingsStatus.textContent = 'Connection OK. DM is ready.';
    } catch (err) {
      el.settingsStatus.textContent = 'Connection failed: ' + err.message;
    }
  };

  el.settingsBack.onclick = () => {
    // Go back to intro of the currently loaded scenario.
    window.dispatchEvent(new CustomEvent('tabletop:goback'));
  };

  // Re-read saved settings whenever the panel is opened.
  window.addEventListener('tabletop:refreshsettings', () => {
    current = loadSettings();
    delete el.baseUrl.dataset.touched; // force re-fill of fields
    renderForm();
    renderSummary();
  });

  renderSummary();
}

function renderForm() {
  el.providerSelect.value = current.provider;
  renderDynamic();
}

function renderDynamic() {
  const isWebLLM = current.provider === 'webllm';
  const isApi = current.provider === 'openai-compatible' || current.provider === 'server-proxy';
  const isNone = current.provider === 'none';

  const show = (sel, on) => { if (el[sel]) el[sel].style.display = on ? '' : 'none'; };
  show('preset', isApi);
  show('apiKey', isApi);
  show('baseUrl', isApi);
  show('model', isApi || isWebLLM);

  // For WebLLM show a model hint.
  if (isWebLLM) el.model.placeholder = 'gemma3-1b-it-q4f16_1-MLC';

  el.apiKey.disabled = isNone;
  el.baseUrl.disabled = isNone;
  el.model.disabled = isNone;

  // Reflect current settings into the fields on first render.
  if (!el.baseUrl.dataset.touched) {
    el.baseUrl.value = current.baseUrl;
    el.model.value = current.model;
    el.apiKey.value = current.apiKey;
    el.allowCompanyFetch.checked = current.allowCompanyFetch;
    el.baseUrl.dataset.touched = '1';
  }
}

function renderSummary() {
  const d = describeProvider(current);
  el.settingsSummary.textContent = d.detail || d.label;
}

document.addEventListener('DOMContentLoaded', initSettings);
