import type { z } from 'zod';
import { OllamaClient, DEFAULT_EMBED_MODEL } from './client.js';
import { OpenAICompatClient } from './openai-client.js';
import type { OllamaChatParams, OllamaChatResponse, OllamaModel } from './types.js';
import type { VllmBackendSchema, OllamaBackendSchema } from '../config/schema.js';

/** Derived from the Zod schema (source of truth) — was a hand-written duplicate
 *  that silently drifted when supportsThink landed. */
export type VllmBackendConfig = z.infer<typeof VllmBackendSchema>;
export type OllamaBackendConfig = z.infer<typeof OllamaBackendSchema>;

/** The slice of the client surface used for fallback routing. Both OllamaClient
 *  and OpenAICompatClient satisfy it structurally. */
type ChatClient = Pick<OllamaClient, 'chat' | 'chatStream' | 'isAvailable' | 'listModels'>;

/**
 * Routing inference client. Extends OllamaClient so it's a drop-in replacement
 * everywhere `client: OllamaClient` is expected — purely additive.
 *
 * chat/chatStream route by model id: to an OpenAI-compatible backend (vLLM) or to
 * a second Ollama-NATIVE host (e.g. gemma4 on the .221 Mini, 2026-09-19); anything
 * unrouted falls through to the first OpenAI-compatible backend (the primary
 * inference host), NOT the legacy Ollama gateway. This lets an install run purely
 * on OpenAI-compatible llama.cpp (OpenAI `/v1/chat/completions`) with NO Ollama
 * shim in front: `ollama.url`/`super.*` are never contacted for chat or status.
 * Embeddings still route by the existing rule (Ollama-native routes only; anything
 * else falls to the gateway for backward compatibility).
 */
export class MultiBackendClient extends OllamaClient {
  private readonly routes = new Map<string, OpenAICompatClient | OllamaClient>();
  /** Fallback for anything not explicitly routed. When an OpenAI-compatible
   *  backend exists, it's the first one (the primary inference host) — this is
   *  what lets an install drop the Ollama shim entirely. With no OpenAI backends
   *  (pure Ollama-native routing), the fallback is the inherited Ollama gateway,
   *  preserving historical behavior. */
  private readonly fallback: ChatClient;

  constructor(
    ollamaUrl: string,
    keepAlive: string | undefined,
    backends: VllmBackendConfig[],
    ollamaBackends: OllamaBackendConfig[] = [],
    defaultContextSize?: number,
  ) {
    super(ollamaUrl, keepAlive, defaultContextSize);
    this.fallback = backends[0]
      ? new OpenAICompatClient(backends[0].url, backends[0].apiKey, backends[0].supportsThink, backends[0].thinkStyle)
      : this;
    for (const b of backends) {
      const client = new OpenAICompatClient(b.url, b.apiKey, b.supportsThink, b.thinkStyle);
      for (const model of b.models) {
        this.routes.set(model, client);
        console.log(`[Inference] Route: "${model}" → OpenAI-compat ${b.url}${b.supportsThink ? ` (think-capable, ${b.thinkStyle})` : ''}`);
      }
    }
    for (const b of ollamaBackends) {
      const client = new OllamaClient(b.url, b.keepAlive ?? keepAlive, b.defaultContextSize ?? defaultContextSize);
      for (const model of b.models) {
        this.routes.set(model, client);
        console.log(`[Inference] Route: "${model}" → Ollama-native ${b.url}`);
      }
    }
  }

  override async chat(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> {
    const route = this.routes.get(params.model);
    return route ? route.chat(params) : this.fallback.chat(params);
  }

  override async chatStream(
    params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>,
    onDelta: (text: string) => void,
  ): Promise<OllamaChatResponse> {
    const route = this.routes.get(params.model);
    return route ? route.chatStream(params, onDelta) : this.fallback.chatStream(params, onDelta);
  }

  override async isAvailable(): Promise<boolean> {
    return this.fallback.isAvailable();
  }

  override async listModels(): Promise<OllamaModel[]> {
    return this.fallback.listModels();
  }

  /**
   * Embeddings route by model id too (2026-09-19). Previously embed() was inherited
   * and ALWAYS hit the primary gateway, so an embedding model could not be placed on
   * its own host — it had to share VRAM with the router. That mattered: memory priming
   * embeds on EVERY message, and when the embedder and router can't both stay resident
   * the reload blows past priming's 8s cap and memory injection is silently skipped.
   * OpenAI-compat backends have no embed endpoint here, so only Ollama-native routes
   * are eligible; anything else falls through to the gateway exactly as before.
   */
  override async embed(input: string | string[], model = DEFAULT_EMBED_MODEL): Promise<number[][]> {
    const route = this.routes.get(model);
    return route instanceof OllamaClient ? route.embed(input, model) : super.embed(input, model);
  }
}

/**
 * Build the inference client from config. Returns a MultiBackendClient when
 * OpenAI-compatible backends are configured, otherwise a plain OllamaClient.
 * Both satisfy the OllamaClient type, so callers are unchanged.
 */
export function createInferenceClient(
  ollamaUrl: string,
  keepAlive: string | undefined,
  backends: VllmBackendConfig[] | undefined,
  ollamaBackends: OllamaBackendConfig[] | undefined = undefined,
  defaultContextSize?: number,
): OllamaClient {
  if (backends?.length || ollamaBackends?.length) {
    return new MultiBackendClient(ollamaUrl, keepAlive, backends ?? [], ollamaBackends ?? [], defaultContextSize);
  }
  return new OllamaClient(ollamaUrl, keepAlive, defaultContextSize);
}
