import { ollamaUnreachable, ollamaInferenceError } from '../errors.js';
import { inferenceAbortSignal } from './abort.js';
import type {
  OllamaChatParams,
  OllamaChatResponse,
  OllamaGenerateParams,
  OllamaGenerateResponse,
  OllamaModel,
  OllamaEmbedParams,
  OllamaEmbedResponse,
} from './types.js';

// Client-side pacing for embedding calls: the gateway now rate-limits
// /api/embed inbound, so we serialize all embed requests process-wide and
// space them out instead of relying on 429-backoff after the fact.
// Env-overridable for callers that legitimately wait longer than production
// dispatch ever should (eval harnesses with reasoning-sized budgets).
// LAZY reads (functions, not module consts): .env is loaded by loadConfig() at
// RUNTIME, after the import graph has already evaluated — a module-scope const
// captures the default before .env exists (2026-08-16: production ran 300s while
// .env said 600s; only tmux-exported eval runs ever saw the overrides).
const defaultRequestTimeoutMs = (): number => Number(process.env.OLLAMA_CHAT_TIMEOUT_MS) || 300_000;

// Embeds are seconds-scale operations — they must NEVER inherit the chat
// timeout (a 600s wait on a wedged embedding box froze every dispatch behind
// memory priming, 2026-08-16). Fail fast; callers degrade gracefully.
// 45s, not 30: the gateway's embedding queue (a17a0d8 their side) can hold a
// request up to max_wait_seconds=30 BEFORE inference starts — 30s here would
// hang up on a maximally-queued embed that was about to succeed, then retry
// it and add load. Our patience must exceed their queue bound + inference.
const embedTimeoutMs = (): number => Number(process.env.OLLAMA_EMBED_TIMEOUT_MS) || 45_000;

// Matched to the gateway's inbound embed cap (100 req/min, observed 2026-08-16):
// 650ms ≈ 92/min with margin. 250ms allowed ~240/min and turned every recovery
// backfill into a 429 storm the backoff had to absorb.
const embedMinIntervalMs = (): number => Number(process.env.EMBED_MIN_INTERVAL_MS) || 650;
let embedChain: Promise<void> = Promise.resolve();
let lastEmbedAt = 0;

function embedThrottle(): Promise<void> {
  const next = embedChain.then(async () => {
    const wait = lastEmbedAt + embedMinIntervalMs() - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastEmbedAt = Date.now();
  });
  embedChain = next.catch(() => {});
  return next;
}

/** 429 (rate limit) and transient 5xx (bad gateway / unavailable / gateway timeout). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Jittered exponential backoff (600ms base, ×2, ±30%), honoring a sane Retry-After. */
export function retryDelayMs(res: { headers?: { get(name: string): string | null } }, attempt: number, capMs = 8_000): number {
  const retryAfter = Number(res.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter * 1000 <= capMs) return retryAfter * 1000;
  const base = Math.min(600 * 2 ** attempt, capMs);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

/** Last-resort fallback when a caller has no config in scope. The configured value
 *  (config.memory.embeddingModel) must win everywhere it is reachable — this literal
 *  exists in exactly ONE place so a swap can't leave a stale copy behind. */
export const DEFAULT_EMBED_MODEL = 'qwen3-embedding:8b';

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keepAlive: string = '30m',
    /** num_ctx for calls that don't set one. Foreground calls always do; utility
     *  calls (NER, contradiction, consolidation) never did, so the SERVER's default
     *  decided — 32K on the A5000, which loaded phi4-mini at 7GB and evicted the
     *  27B (2026-09-25). Config: ollama.defaultContextSize / per-host on backends. */
    private readonly defaultContextSize?: number,
  ) {}

  /** Apply the default num_ctx only where the caller left it unset. */
  private withDefaultCtx<T extends { options?: Record<string, unknown> }>(params: T): T {
    if (this.defaultContextSize === undefined || params.options?.num_ctx !== undefined) return params;
    return { ...params, options: { ...(params.options ?? {}), num_ctx: this.defaultContextSize } };
  }

  async chat(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> {
    // Long completions MUST stream (2026-09-19; the same fix OpenAICompatClient got
    // on 2026-08-26, applied here once Ollama became the foreground path). A
    // non-streaming request sends NO response headers until the whole generation is
    // done, so a request queued behind other work on a busy host trips undici's
    // 5-minute headers deadline (UND_ERR_HEADERS_TIMEOUT) and each blind retry
    // restarts the same doomed generation. Streaming sends headers immediately;
    // the only clock left is our own budget. Caught live: four cron catch-ups
    // serialized on one Mac Mini killed a meal-plan run mid-repair.
    return this.chatStream(params, () => undefined);
  }

  /**
   * Streaming chat — yields text deltas via callback, returns final response.
   * If the model calls tools, falls back to collecting the full response (no streaming).
   */
  async chatStream(
    params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>,
    onDelta: (text: string) => void,
  ): Promise<OllamaChatResponse> {
    const body: OllamaChatParams = {
      ...this.withDefaultCtx(params),
      stream: true,
      keep_alive: this.keepAlive,
    };

    const MAX_ATTEMPTS = 4;
    let res: Response | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(300_000), inferenceAbortSignal()]),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw ollamaInferenceError('Stream request timed out');
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn('[Ollama] Stream connection failed, retrying in 2s...');
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
        throw ollamaUnreachable(this.baseUrl, err);
      }
      // 429 + transient 5xx — back off and retry (stream not yet started, safe to redo).
      if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
        const delay = retryDelayMs(res, attempt);
        console.warn(`[Ollama] ${res.status} on stream, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
    if (!res) throw ollamaUnreachable(this.baseUrl, new Error('Connection failed after retry'));

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw ollamaInferenceError('No response body for streaming');

    const decoder = new TextDecoder();
    let fullContent = '';
    // Separated thinking must survive the stream path: vision.ts/browser visual fall
    // back to `message.thinking` when content is empty, and chat() now routes through
    // here — dropping it would silently break those callers.
    let fullThinking = '';
    // Tool calls arrive in a MIDDLE chunk; the final `done:true` chunk carries only
    // token stats and an empty message. Reading them off the last chunk (as this did
    // until 2026-09-20) returned undefined for every native tool call the moment
    // chat() started routing through here — the engine saw "empty completion" three
    // times on a task_add the model had answered correctly. Accumulate, like the
    // OpenAI-compat client does with its deltas.
    const toolCalls: NonNullable<OllamaChatResponse['message']['tool_calls']> = [];
    let lastChunk: OllamaChatResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const chunk = JSON.parse(line) as OllamaChatResponse;
          lastChunk = chunk;

          // Thinking accumulates but is NEVER sent to onDelta — stream previews stay
          // clean by construction (same rule as the OpenAI-compat path).
          if (chunk.message?.thinking) fullThinking += chunk.message.thinking;
          if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
          if (chunk.message?.content) {
            fullContent += chunk.message.content;
            onDelta(chunk.message.content);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Build final response — preserve token counts from the last chunk
    return {
      model: lastChunk?.model ?? params.model,
      message: {
        role: 'assistant',
        content: fullContent,
        ...(fullThinking ? { thinking: fullThinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      done: true,
      eval_count: lastChunk?.eval_count,
      prompt_eval_count: lastChunk?.prompt_eval_count,
      total_duration: lastChunk?.total_duration,
      load_duration: lastChunk?.load_duration,
      prompt_eval_duration: lastChunk?.prompt_eval_duration,
      eval_duration: lastChunk?.eval_duration,
    } as OllamaChatResponse;
  }

  async generate(params: Omit<OllamaGenerateParams, 'stream' | 'keep_alive'>): Promise<OllamaGenerateResponse> {
    const body: OllamaGenerateParams = {
      ...this.withDefaultCtx(params),
      stream: false,
      keep_alive: this.keepAlive,
    };
    return this.post<OllamaGenerateResponse>('/api/generate', body);
  }

  /** Callers should pass the configured embedding model (config.memory.embeddingModel).
   *  DEFAULT_EMBED_MODEL is a last-resort fallback only — a mismatch here silently
   *  produces vectors of the wrong width for the index (2026-09-19). */
  async embed(input: string | string[], model = DEFAULT_EMBED_MODEL): Promise<number[][]> {
    // Try /api/embed first (standard Ollama), fall back to /api/embeddings (gateway compat)
    await embedThrottle();
    try {
      const body: OllamaEmbedParams = { model, input, keep_alive: this.keepAlive };
      const res = await this.post<OllamaEmbedResponse>('/api/embed', body, embedTimeoutMs());
      return res.embeddings;
    } catch {
      // Fallback: /api/embeddings with single-prompt format
      const texts = Array.isArray(input) ? input : [input];
      const results: number[][] = [];
      for (const text of texts) {
        await embedThrottle();
        const res = await this.post<{ embedding: number[] }>('/api/embeddings', { model, prompt: text }, embedTimeoutMs());
        results.push(res.embedding);
      }
      return results;
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    const data = await this.get<{ models: OllamaModel[] }>('/api/tags');
    return data.models ?? [];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post<T>(path: string, body: unknown, timeoutMs = defaultRequestTimeoutMs(), abortSignal?: AbortSignal): Promise<T> {
    const jsonBody = JSON.stringify(body);
    const MAX_ATTEMPTS = 4;
    let lastErr: unknown;

    // Retry on connection failure (transient network drops) AND on 429 rate limits
    // (gateway caps req/min; the window resets quickly, so back off and retry rather
    // than failing the call — a dropped router classification falls back to keywords).
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonBody,
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), inferenceAbortSignal(), ...(abortSignal ? [abortSignal] : [])]),
        });
      } catch (err) {
        if (abortSignal?.aborted) {
          throw ollamaInferenceError(`Request to ${path} aborted by caller`);
        }
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw ollamaInferenceError(`Request to ${path} timed out after ${timeoutMs}ms`);
        }
        lastErr = err;
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[Ollama] Connection failed (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err}), retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
        throw ollamaUnreachable(this.baseUrl, err);
      }

      // 429 + transient 5xx (dsh audit, 2026-08-23): a gateway blip (502/503/504) or
      // rate limit retries with jittered exponential backoff, honoring Retry-After.
      if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
        const delay = retryDelayMs(res, attempt);
        console.warn(`[Ollama] ${res.status} on ${path}, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
      }

      return res.json() as Promise<T>;
    }

    throw ollamaUnreachable(this.baseUrl, lastErr);
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw ollamaUnreachable(this.baseUrl, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }

    return res.json() as Promise<T>;
  }
}
