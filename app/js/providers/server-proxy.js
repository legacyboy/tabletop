/**
 * Server-proxy chat provider.
 *
 * Routes DM calls through the tabletop server's /api/dm endpoint instead of
 * calling the LLM directly from the browser. This is the right architecture
 * when the server and the LLM (e.g. a local Ollama) are on the same box: the
 * client only needs to reach the server, not the LLM. It also works for API
 * keys, letting the server hold the key instead of the browser.
 *
 * The client sends { base_url, api_key, model, messages } to /api/dm on the
 * same origin; the server makes the upstream call and returns { content }.
 */

export class ServerProxyProvider {
  /**
   * @param {object} config
   * @param {string} config.baseUrl   upstream LLM base URL (e.g. http://localhost:11434/v1)
   * @param {string} config.apiKey    upstream API key (may be empty for local Ollama)
   * @param {string} config.model     upstream model (e.g. gemma3:4b)
   * @param {string} config.endpoint  server proxy path (default '/api/dm')
   */
  constructor(config) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.endpoint = config.endpoint || '/api/dm';
    this.label = config.label || this.model || 'Server (local)';
  }

  get id() {
    return 'server-proxy';
  }

  /** @returns {Promise<string>} the model's text reply. */
  async chat(messages, opts = {}) {
    if (!this.baseUrl) throw new Error('Server proxy needs an upstream base URL.');
    if (!this.model) throw new Error('Server proxy needs a model name.');

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: this.baseUrl,
        api_key: this.apiKey,
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 800,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || (await res.text());
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Server proxy failed (${res.status}): ${detail}`);
    }

    const data = await res.json();
    if (data.content === undefined) throw new Error('Server proxy returned no content.');
    return data.content.trim();
  }

  /** Quick connectivity probe used by the settings panel. */
  async ping() {
    await this.chat([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10 });
    return true;
  }
}
