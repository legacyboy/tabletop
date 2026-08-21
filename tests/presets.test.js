/**
 * Provider preset + routing tests.
 *
 * Verifies the built-in DM presets (especially the new "Ollama (remote)"
 * preset) and that buildProvider routes the direct (browser -> remote Ollama)
 * and proxy (browser -> server -> local Ollama) paths to the right provider
 * classes. No network or DOM required.
 */
import { PRESETS, OLLAMA_MODELS, buildProvider, describeProvider, defaultSettings } from '../app/js/providers/registry.js';
import { OpenAICompatibleProvider } from '../app/js/providers/openai-compatible.js';
import { ServerProxyProvider } from '../app/js/providers/server-proxy.js';

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name); }
};

// 1. The full preset list is present and ids are unique.
const ids = PRESETS.map((p) => p.id);
check('presets include openai/deepseek/anthropic', ['openai', 'deepseek', 'anthropic'].every((id) => ids.includes(id)));
check('presets include server-local', ids.includes('server-local'));
check('presets include ollama-remote', ids.includes('ollama-remote'));
check('preset ids are unique', new Set(ids).size === ids.length);

// 2. Ollama (remote) preset routes via the server proxy and exposes NO base URL.
const remote = PRESETS.find((p) => p.id === 'ollama-remote');
check('ollama-remote exists', !!remote);
check('ollama-remote model is deepseek-v4-flash:cloud', remote && remote.model === 'deepseek-v4-flash:cloud');
check('ollama-remote routes via the server (viaServer)', remote && remote.viaServer === true);
check('ollama-remote has NO client base URL (server reaches Ollama)', remote && !remote.baseUrl);

// 3. Server (local) preset remains the PROXY path.
const local = PRESETS.find((p) => p.id === 'server-local');
check('server-local uses viaServer (proxy path)', local && local.viaServer === true);
check('server-local baseUrl stays localhost', local && local.baseUrl === 'http://localhost:11434/v1');

// 4. Routing: remote Ollama -> server-proxy provider (NOT direct), even with a URL.
const direct = buildProvider({
  provider: 'openai-compatible',
  preset: 'ollama-remote',
  viaServer: true,
  baseUrl: 'http://10.0.0.5:11434/v1',
  apiKey: 'sekret',
  model: 'deepseek-v4-flash:cloud',
});
check('remote ollama builds a ServerProxyProvider', direct instanceof ServerProxyProvider);
check('remote ollama keeps the remote base URL', direct && direct.baseUrl === 'http://10.0.0.5:11434/v1');
check('remote ollama keeps the API key', direct && direct.apiKey === 'sekret');

// 4b. Remote Ollama with NO base URL still builds a server-proxy provider
// (server fills in its OLLAMA_URL default), so the UI can hide the URL field.
const blankRemote = buildProvider({
  provider: 'server-proxy',
  preset: 'ollama-remote',
  viaServer: true,
  baseUrl: '',
  model: 'deepseek-v4-flash:cloud',
});
check('remote ollama with empty baseUrl builds a ServerProxyProvider (no URL needed)', blankRemote instanceof ServerProxyProvider);
check('remote ollama empty baseUrl stays empty (server uses its own default)', blankRemote && blankRemote.baseUrl === '');

// A direct (browser) provider still REQUIRES a base URL.
check('direct openai-compatible with empty baseUrl builds null (URL required)', buildProvider({
  provider: 'openai-compatible',
  baseUrl: '',
  model: 'deepseek-v4-flash:cloud',
}) === null);

// 5. Routing: server-local -> server-proxy provider (NOT direct).
const proxy = buildProvider({
  provider: 'server-proxy',
  preset: 'server-local',
  baseUrl: 'http://localhost:11434/v1',
  model: 'deepseek-v4-flash:cloud',
});
check('server-local builds a ServerProxyProvider', proxy instanceof ServerProxyProvider);

// 6. Labels distinguish the two Ollama presets.
const remoteDesc = describeProvider({ provider: 'server-proxy', preset: 'ollama-remote', viaServer: true, baseUrl: '', model: 'deepseek-v4-flash:cloud' });
const localDesc = describeProvider({ provider: 'server-proxy', preset: 'server-local', baseUrl: 'http://localhost:11434/v1', model: 'deepseek-v4-flash:cloud' });
check('remote ollama labeled "Ollama (remote)"', remoteDesc.label === 'Ollama (remote)');
check('server-local labeled "Server (local Ollama)"', localDesc.label === 'Server (local Ollama)');
check('server-local detail notes "via server"', localDesc.detail.includes('(via server)'));
check('remote ollama (no URL) detail notes it is server-routed', remoteDesc.detail.includes('via server (Ollama)'));

// 7. Company URL field is persisted in defaultSettings (for DM context fetch).
const def = defaultSettings();
check('defaultSettings includes companyUrl', 'companyUrl' in def);
check('defaultSettings companyUrl defaults to empty string', def.companyUrl === '');
check('defaultSettings allowCompanyFetch defaults true', def.allowCompanyFetch === true);
check('defaultSettings rememberKey defaults true (key persisted)', def.rememberKey === true);

// 8. OLLAMA_MODELS dropdown list is exported and well-formed.
check('OLLAMA_MODELS is exported as an array', Array.isArray(OLLAMA_MODELS));
const modelValues = OLLAMA_MODELS.map((m) => m.value);
check('OLLAMA_MODELS does NOT include gemma3:4b', !modelValues.includes('gemma3:4b'));
check('OLLAMA_MODELS includes glm-5.2:cloud', modelValues.includes('glm-5.2:cloud'));
check('OLLAMA_MODELS includes deepseek-v4-flash:cloud', modelValues.includes('deepseek-v4-flash:cloud'));
check('OLLAMA_MODELS includes qwen3.5:397b-cloud', modelValues.includes('qwen3.5:397b-cloud'));
check('OLLAMA_MODELS ids are unique', new Set(modelValues).size === modelValues.length);
check('OLLAMA_MODELS entries have value + label', OLLAMA_MODELS.every((m) => typeof m.value === 'string' && typeof m.label === 'string' && m.value && m.label));
check('OLLAMA_MODELS default (first) is deepseek-v4-flash:cloud', OLLAMA_MODELS[0] && OLLAMA_MODELS[0].value === 'deepseek-v4-flash:cloud');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
