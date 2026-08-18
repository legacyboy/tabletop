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
  OLLAMA_MODELS,
  buildProvider,
  defaultSettings,
  loadSettings,
  saveSettings,
  describeProvider,
  loadOfflineConfig,
} from './providers/registry.js';

const $ = (id) => document.getElementById(id);
const el = {};

let current = null;

/**
 * Whether the Base URL field should be hidden for the current selection.
 * Presets with no base URL (e.g. "Ollama (remote)", which is routed through
 * the server's /api/dm proxy using the server-side OLLAMA_URL) must not show a
 * Base URL field — the user never needs to type or see a URL.
 */
function hideBaseUrl() {
  if (!current || !current.preset) return false;
  const p = PRESETS.find((x) => x.id === current.preset);
  // Hide when the selected preset carries no base URL of its own.
  return !!p && !p.baseUrl;
}

export function initSettings() {
  ['providerSelect', 'preset', 'apiKey', 'baseUrl', 'baseUrlWrap', 'model', 'modelSelect', 'allowCompanyFetch', 'companyUrl', 'rememberKey',
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
    current.preset = el.preset.value;
    if (p) {
      current.baseUrl = p.baseUrl || '';
      current.model = p.model;
      current.viaServer = !!p.viaServer;
      el.baseUrl.value = current.baseUrl;
      el.model.value = p.model;
    } else {
      // Custom preset: clear the server-route flag so a fresh URL is used.
      current.viaServer = false;
    }
    renderDynamic();
  };

  // When a model is picked from the dropdown, mirror it into the free-text
  // input (which is what saveSettings reads) and hide the free-text field.
  // Choosing "Custom…" (value "") reveals the free-text input instead.
  el.modelSelect.onchange = () => {
    const chosen = el.modelSelect.value;
    if (chosen) {
      current.model = chosen;
      el.model.value = chosen;
      el.model.style.display = 'none';
    } else {
      // "Custom…": reveal the free-text input so any model can be typed.
      el.model.style.display = '';
      el.model.focus();
    }
  };

  el.saveSettings.onclick = () => {
    current.apiKey = el.apiKey.value.trim();
    current.baseUrl = el.baseUrl.value.trim();
    current.model = el.model.value.trim();
    current.allowCompanyFetch = el.allowCompanyFetch.checked;
    current.companyUrl = el.companyUrl.value.trim();
    current.rememberKey = el.rememberKey.checked;

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
  show('model', isApi || isWebLLM);
  // Hide the Base URL field for presets that are server-routed with no client
  // URL (e.g. "Ollama (remote)"): the user never sees or types a URL.
  const showBaseUrl = isApi && !hideBaseUrl();
  show('baseUrl', showBaseUrl);
  show('baseUrlWrap', showBaseUrl);

  // Reflect the saved preset selection into the dropdown ('' = Custom).
  el.preset.value = current.preset || '';

  // For the "Ollama (remote)" preset, offer a dropdown of common models
  // instead of the free-text field. "Custom…" (value "") reveals the
  // free-text input so any model can still be typed.
  const isOllamaRemote = isApi && current.preset === 'ollama-remote';
  if (isOllamaRemote) {
    populateModelSelect();
    const known = OLLAMA_MODELS.some((m) => m.value === current.model);
    el.modelSelect.value = known ? current.model : '';
    show('modelSelect', true);
    show('model', !known);
  } else {
    show('modelSelect', false);
    show('model', isApi || isWebLLM);
  }

  // For WebLLM show a model hint and pre-fill the model from the offline
  // bundle (if present) so the field isn't blank.
  if (isWebLLM) {
    el.model.placeholder = 'gemma3-1b-it-q4f16_1-MLC';
    const offline = loadOfflineConfig();
    if (offline && offline.model_id && !el.model.value) {
      el.model.value = offline.model_id;
      current.model = offline.model_id;
    }
  }

  // Show the local-Ollama tip only when the user is pointed at a local Ollama
  // endpoint directly from the browser (where OLLAMA_ORIGINS=* matters). It's
  // irrelevant for server-routed presets (the server reaches Ollama, not the
  // browser) and for remote providers.
  const isLocalOllama = isApi && !current.viaServer && !hideBaseUrl() &&
    /(localhost|127\.0\.0\.1)[:/]/.test(current.baseUrl || '');
  show('companyFetchHint', isLocalOllama);

  el.apiKey.disabled = isNone;
  el.baseUrl.disabled = isNone;
  el.model.disabled = isNone;

  // When the preset hides the Base URL field, clear any stale value so the
  // server proxy falls back to its own OLLAMA_URL default.
  if (hideBaseUrl()) current.baseUrl = '';

  // Reflect current settings into the fields on first render.
  if (!el.baseUrl.dataset.touched) {
    el.baseUrl.value = current.baseUrl;
    el.model.value = current.model;
    el.apiKey.value = current.apiKey;
    el.allowCompanyFetch.checked = current.allowCompanyFetch;
    el.companyUrl.value = current.companyUrl;
    el.rememberKey.checked = current.rememberKey;
    el.baseUrl.dataset.touched = '1';
  }
}

/**
 * Build the model dropdown options from OLLAMA_MODELS plus a "Custom…"
 * entry (value "") that reveals the free-text input. Rebuilt on each render
 * so the list always reflects the registry constant.
 */
function populateModelSelect() {
  if (!el.modelSelect) return;
  el.modelSelect.innerHTML = '';
  for (const m of OLLAMA_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    el.modelSelect.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = 'Custom…';
  el.modelSelect.appendChild(custom);
}

function renderSummary() {
  const d = describeProvider(current);
  el.settingsSummary.textContent = d.detail || d.label;
}

document.addEventListener('DOMContentLoaded', initSettings);
