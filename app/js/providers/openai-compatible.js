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

export class OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string} config.baseUrl   e.g. https://api.openai.com/v1
   * @param {string} config.apiKey    API key (may be empty for local Ollama)
   * @param {string} config.model     e.g. gpt-4o-mini, deepseek-chat, gemma3:4b
   */
  constructor(config) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.label = config.label || this.model || 'OpenAI-compatible';
  }

  get id() {
    return 'openai-compatible';
  }

  /** @returns {Promise<string>} the model's text reply. */
  async chat(messages, opts = {}) {
    if (!this.baseUrl) throw new Error('OpenAI-compatible provider needs a base URL.');
    if (!this.model) throw new Error('OpenAI-compatible provider needs a model name.');

    const url = `${this.baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 800,
      }),
      signal: opts.signal,
    });

    // Ollama's compatible endpoint returns 404 for an unknown model name — surface it clearly.
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error?.message || (await res.text());
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Model call failed (${res.status}): ${detail}`);
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
