/**
 * Direct OpenAI-compatible provider request mechanics.
 *
 * Covers the browser-side fetch the DeepSeek preset makes:
 *   - URL construction (baseUrl + /chat/completions)
 *   - API key sanitization (paste artifacts that made fetch() throw
 *     "Failed to fetch" before any request was sent)
 *   - network-level fetch failures surfaced as actionable diagnostics
 *   - non-2xx responses surfacing the API's own error message (no
 *     double-consumed body)
 *   - abort passthrough
 * Also covers the server-proxy network failure diagnostic.
 * No network required: global fetch is stubbed.
 */
import { OpenAICompatibleProvider, sanitizeApiKey } from '../app/js/providers/openai-compatible.js';
import { ServerProxyProvider } from '../app/js/providers/server-proxy.js';

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name); }
};

const realFetch = globalThis.fetch;
const calls = [];
function stubFetch(handler) {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}
function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async json() { return JSON.parse(body); },
    async text() { return body; },
  };
}
async function main() {
  try {
  // 1. URL construction: trailing slash stripped, /chat/completions appended once.
  stubFetch(() => response(200, JSON.stringify({ choices: [{ message: { content: ' ok ' } }] })));
  const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-x', model: 'deepseek-v4-flash' });
  await p.chat([{ role: 'user', content: 'hi' }]);
    check('URL is baseUrl (trailing slash stripped) + /chat/completions',
      calls[0].url === 'https://api.deepseek.com/v1/chat/completions');
    check('HTTP method is POST', calls[0].init.method === 'POST');
    check('Authorization header is Bearer <key>', calls[0].init.headers.Authorization === 'Bearer sk-x');
    check('Content-Type is application/json', calls[0].init.headers['Content-Type'] === 'application/json');
    const sent = JSON.parse(calls[0].init.body);
    check('request body carries the model', sent.model === 'deepseek-v4-flash');
    check('request body carries the messages', Array.isArray(sent.messages) && sent.messages[0].content === 'hi');
    check('request body carries temperature', typeof sent.temperature === 'number');
    check('request body carries max_tokens', typeof sent.max_tokens === 'number');
    check('reply content is returned trimmed', await p.chat([{ role: 'user', content: 'hi' }]) === 'ok');

    // 2. sanitizeApiKey: embedded paste artifacts are stripped.
    check('sanitize strips an embedded newline (line-wrapped paste)',
      sanitizeApiKey('sk-abc\ndef') === 'sk-abcdef');
    check('sanitize strips zero-width space (chat-app copy artifact)',
      sanitizeApiKey('sk-abc\u200bdef') === 'sk-abcdef');
    check('sanitize strips non-breaking spaces',
      sanitizeApiKey('sk-abc\u00a0def') === 'sk-abcdef');
    check('sanitize strips carriage returns / tabs',
      sanitizeApiKey('sk-abc\r\tdef') === 'sk-abcdef');
    check('sanitize strips surrounding whitespace',
      sanitizeApiKey('  sk-abc  ') === 'sk-abc');
    check('sanitize leaves a clean key untouched',
      sanitizeApiKey('sk-0123456789abcdef') === 'sk-0123456789abcdef');
    check('sanitize tolerates null/undefined', sanitizeApiKey(null) === '' && sanitizeApiKey(undefined) === '');
    check('constructor sanitizes the key',
      new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-abc\ndef', model: 'm' }).apiKey === 'sk-abcdef');

    // 3. A key with a visible non-ASCII character fails FAST with a clear
    //    message (before fetch is even attempted).
    stubFetch(() => response(200, '{}'));
    const badKey = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ab\u00e9c', model: 'm' });
    let msg = '';
    try { await badKey.chat([{ role: 'user', content: 'x' }]); } catch (e) { msg = e.message; }
    check('non-ASCII key throws a clear re-copy message', msg.includes('re-copy') && calls.length === 0);

    // 4. Network-level fetch failure (Chrome's "TypeError: Failed to fetch")
    //    is surfaced as a diagnostic naming the URL and likely causes.
    stubFetch(() => { const e = new TypeError('Failed to fetch'); throw e; });
    msg = '';
    try {
      await new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'm' })
        .chat([{ role: 'user', content: 'x' }]);
    } catch (e) { msg = e.message; }
    check('network failure names the exact URL', msg.includes('https://api.deepseek.com/v1/chat/completions'));
    check('network failure explains it was blocked before reaching the API', msg.includes('Could not reach'));
    check('network failure mentions ad blocker / DNS filtering guidance', msg.includes('ad blocker'));

    // 5. Non-2xx: the API's own error message survives (no double-consumed body).
    stubFetch(() => response(401, JSON.stringify({ error: { message: 'Authentication Fails, Your api key: ****lder is invalid', type: 'authentication_error' } })));
    msg = '';
    try {
      await new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-bad', model: 'deepseek-v4-flash' })
        .chat([{ role: 'user', content: 'x' }]);
    } catch (e) { msg = e.message; }
    check('401 surfaces the status', msg.includes('Model call failed (401)'));
    check("401 surfaces the API's own message", msg.includes('Authentication Fails'));
    check('401 message is not empty (double-consume bug fixed)', msg.includes('invalid'));

    // 5b. Non-JSON error body (e.g. an HTML 405 page) is truncated, not lost.
    stubFetch(() => response(405, '<html><body>405 Not Allowed</body></html>'));
    msg = '';
    try {
      await new OpenAICompatibleProvider({ baseUrl: 'https://x.example/v1', apiKey: 'sk-x', model: 'm' })
        .chat([{ role: 'user', content: 'x' }]);
    } catch (e) { msg = e.message; }
    check('non-JSON error body is surfaced (truncated)', msg.includes('(405)') && msg.includes('405 Not Allowed'));

    // 6. Abort errors pass through untouched (callers' timeouts keep working).
    stubFetch(() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; });
    const ctrl = new AbortController();
    ctrl.abort();
    let aborted = false;
    try {
      await new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'm' })
        .chat([{ role: 'user', content: 'x' }], { signal: ctrl.signal });
    } catch (e) { aborted = e.name === 'AbortError'; }
    check('AbortError passes through unchanged', aborted);

    // 7. Server proxy network failure diagnostic (static hosts have no /api/dm).
    stubFetch(() => { const e = new TypeError('Failed to fetch'); throw e; });
    msg = '';
    try {
      await new ServerProxyProvider({ baseUrl: '', apiKey: '', model: 'm' }).chat([{ role: 'user', content: 'x' }]);
    } catch (e) { msg = e.message; }
    check('server-proxy network failure names /api/dm', msg.includes('/api/dm'));
    check('server-proxy failure suggests a direct preset on static hosts', msg.includes('GitHub Pages'));

    // 8. Provider construction guards still work.
    let guard = '';
    try { await new OpenAICompatibleProvider({ baseUrl: '', apiKey: '', model: '' }).chat([]); }
    catch (e) { guard = e.message; }
    check('missing baseUrl throws a clear error', guard.includes('base URL'));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    globalThis.fetch = realFetch;
    console.error('TEST CRASH:', e);
    process.exit(1);
  }
}

main();