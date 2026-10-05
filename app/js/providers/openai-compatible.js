/**
 * OpenAI-compatible chat provider.
 *
 * Works with OpenAI, DeepSeek, and any OpenAI-compatible endpoint, INCLUDING
 * a local Ollama runner (Ollama serves an OpenAI-compatible API, so your local
 * Gemma model works by pointing at http://localhost:11434/v1).
 *
 * Talks directly from the browser via fetch (no server required). Browsers
 * allow cross-origin fetch to these APIs; local Ollama needs
 * OLLAMA_ORIGINS='*' (or the app origin) set so it permits the request.
 */

/**
 * Strip characters that make a browser fetch() THROW before any request is
 * even sent. Keys pasted from chat apps / password managers / PDFs often carry
 * embedded line wraps (newlines), zero-width characters, or non-breaking
 * spaces. String.trim() only removes OUTER whitespace, so an embedded newline
 * survives into the Authorization header — and an invalid header value makes
 * fetch() itself reject with a generic TypeError that is impossible for a
 * user to diagnose (and indistinguishable from a network failure).
 */
const API_KEY_JUNK = /[\u0000-\u0020\u007f-\u009f\u00a0\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g;

export function sanitizeApiKey(key) {
  return String(key || '').replace(API_KEY_JUNK, '').trim();
}

/**
 * Read the best error text from a non-2xx response WITHOUT double-consuming
 * the body (json() then text() on the same response throws "body stream
 * already read" and silently loses the API's message).
 */
async function errorDetail(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return j?.error?.message || j?.error || j?.message || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return '';
  }
}

export class OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string} config.baseUrl   e.g. https://api.openai.com/v1
   * @param {string} config.apiKey    API key (may be empty for local Ollama)
   * @param {string} config.model     e.g. gpt-4o-mini, deepseek-chat, deepseek-v4-flash:cloud
   */
  constructor(config) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = sanitizeApiKey(config.apiKey || '');
    this.model = config.model || '';
    this.label = config.label || this.model || 'OpenAI-compatible';
  }

  get id() {
    return 'openai-compatible';
  }

  /** True when the base URL points at an Ollama server (native API available). */
  _isOllama() {
    return /:(11434)(\/|$)/.test(this.baseUrl) || /ollama/i.test(this.baseUrl);
  }

  /**
   * Ollama's OpenAI-compatible endpoint (/v1/chat/completions) IGNORES
   * options.num_ctx and clips the prompt to the model's loaded context
   * (default 4096). The DM system prompt is ~4-5k tokens, so that endpoint
   * silently truncates the reply mid-sentence. Ollama's NATIVE endpoint
   * (/api/chat) honours options.num_ctx, so we use it when the target is
   * Ollama. 16384 is used by default: the system prompt (~4.3k) plus the
   * JSON turn envelope needs headroom, and smaller windows (4096) make the
   * model return EMPTY content while 8192 runs out of output budget
   * (done_reason=length). Returns the model's text reply.
   */
  async _chatOllama(messages, opts = {}) {
    const url = `${this.baseUrl.replace(/\/v1$/, '')}/api/chat`;
    const options = {
      temperature: opts.temperature ?? 0.8,
      num_ctx: opts.numCtx || 16384,
    };
    if (opts.maxTokens) options.num_predict = opts.maxTokens;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false, options }),
        signal: opts.signal,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || opts.signal?.aborted)) throw err;
      throw new Error(`Could not reach Ollama at ${url} (${err?.message || 'network error'}).`);
    }
    if (!res.ok) {
      throw new Error(`Model call failed (${res.status}): ${await errorDetail(res)}`);
    }
    const data = await res.json();
    const text = data?.message?.content;
    if (text === undefined) throw new Error('Model returned no content.');
    return String(text).trim();
  }

  /** @returns {Promise<string>} the model's text reply. */
  async chat(messages, opts = {}) {
    if (!this.baseUrl) throw new Error('OpenAI-compatible provider needs a base URL.');
    if (!this.model) throw new Error('OpenAI-compatible provider needs a model name.');

    // Route Ollama to its native API so num_ctx is honoured (see _chatOllama).
    if (this._isOllama()) return this._chatOllama(messages, opts);

    const url = `${this.baseUrl}/chat/completions`;

    // A paste artifact (e.g. a visible non-ASCII character) that survives
    // sanitization would make fetch() throw a useless TypeError before any
    // request is sent. Catch it here with a message a human can act on.
    if (/[^ -~]/.test(this.apiKey)) {
      throw new Error(
        'API key contains unsupported characters — re-copy the key from the provider dashboard.'
      );
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    // Non-Ollama OpenAI-compatible servers ignore unknown fields, so sending
    // max_tokens is safe. numCtx is Ollama-specific and handled above.
    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 8192,
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      // Propagate deliberate aborts untouched.
      if (err && (err.name === 'AbortError' || opts.signal?.aborted)) throw err;
      // fetch() throws (Chrome: "TypeError: Failed to fetch") when the
      // request never completes: offline, DNS/ad-blocker blocking, CORS
      // preflight refusal, or an invalid header. Surface the exact URL and
      // the likely causes instead of the browser's useless generic message.
      throw new Error(
        `Could not reach ${url} (${err?.message || 'network error'}). ` +
        'The request was blocked before it reached the API — check you are online, ' +
        'the base URL is correct, and that an ad blocker, DNS filter (some block ' +
        'AI domains like api.deepseek.com), or corporate proxy is not blocking it.'
      );
    }

    if (!res.ok) {
      throw new Error(`Model call failed (${res.status}): ${await errorDetail(res)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (text === undefined) throw new Error('Model returned no content.');
    return text.trim();
  }

  /** Quick connectivity probe used by the settings panel. */
  async ping() {
    await this.chat([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10 });
    return true;
  }
}
