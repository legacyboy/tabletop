/**
 * In-browser model provider using WebLLM.
 *
 * This is the "portable, standalone" path: a small Gemma/Llama-class model
 * runs entirely in the browser via WebGPU. No server, no API key, no external
 * calls — the whole app can live in one folder and work offline.
 *
 * Requirements & caveats:
 *  - A WebGPU-capable browser (current Chrome/Edge; Firefox behind a flag).
 *  - The model is downloaded once (roughly 1-2 GB) into the browser's cache.
 *  - WebLLM is lazy-loaded only when this provider is selected, so the app
 *    boots fast and the user isn't forced to download a model to try others.
 *
 * WebLLM is loaded from a CDN. For a fully-offline deployment the library
 * files and the model weights must be vendored locally; the provider is
 * written so the load URL is configurable.
 */

const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

export class WebLLMProvider {
  /**
   * @param {object} config
   * @param {string} config.model     WebLLM model id, e.g. 'gemma-3-4b-it-q4f16_1-MLC'
   * @param {string} [config.libraryUrl] CDN or local URL for @mlc-ai/web-llm
   * @param {Function} [config.onProgress]  ({phase, loadedBytes, totalBytes}) => void
   */
  constructor(config = {}) {
    this.model = config.model || 'gemma-3-4b-it-q4f16_1-MLC';
    this.libraryUrl = config.libraryUrl || WEBLLM_CDN;
    this.onProgress = config.onProgress || (() => {});
    this.engine = null;
    this.status = 'idle'; // idle | loading | ready | error
  }

  get id() {
    return 'webllm';
  }

  get label() {
    return 'In-browser (WebLLM)';
  }

  /** Whether the current browser can run WebGPU models at all. */
  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  async _ensureLoaded() {
    if (this.engine) return this.engine;

    if (!WebLLMProvider.supported()) {
      throw new Error(
        'In-browser models need WebGPU. Use Chrome/Edge, or switch to an API key / local Ollama in Settings.'
      );
    }

    this.status = 'loading';
    let { CreateMLCEngine } = await import(this.libraryUrl);

    this.engine = await CreateMLCEngine(this.model, {
      initProgressCallback: (report) => {
        this.onProgress({
          phase: report.text,
          loadedBytes: report.loadedBytes,
          totalBytes: report.totalBytes,
        });
      },
    });

    this.status = 'ready';
    return this.engine;
  }

  async chat(messages, opts = {}) {
    const engine = await this._ensureLoaded();
    const reply = await engine.chat.completions.create({
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 800,
    });
    const text = reply?.choices?.[0]?.message?.content;
    return (text || '').trim();
  }

  async ping() {
    await this.chat([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10 });
    return true;
  }
}
