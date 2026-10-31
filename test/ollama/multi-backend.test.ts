import { describe, it, expect, vi } from 'vitest';
import { MultiBackendClient, createInferenceClient } from '../../src/ollama/multi-backend.js';
import { OllamaClient } from '../../src/ollama/client.js';

describe('MultiBackendClient routing', () => {
  function build() {
    return new MultiBackendClient(
      'http://gateway:11434', '30m',
      [{ url: 'http://vllm:8000', models: ['glm-5.3-flash'], supportsThink: true, thinkStyle: 'qwen-template' } as any],
      [{ url: 'http://mini:11434', models: ['gemma4:12b-mlx'] } as any],
    );
  }

  it('routes by model id: OpenAI-compat, Ollama-native host, and OpenAI fallthrough', async () => {
    const c = build();
    const seen: string[] = [];
    // Stub each destination so we can observe which one a model reaches.
    for (const [model, label] of [['glm-5.3-flash', 'vllm'], ['gemma4:12b-mlx', 'mini']] as const) {
      const route = (c as any).routes.get(model);
      route.chat = vi.fn(async () => { seen.push(label); return { message: { role: 'assistant', content: label } }; });
    }
    // Unrouted fallthrough = the first OpenAI-compatible backend, NOT the
    // inherited Ollama gateway (shim removal — see multi-backend.ts).
    const fallbackChat = vi.spyOn((c as any).fallback, 'chat').mockImplementation(async () => {
      seen.push('openai'); return { message: { role: 'assistant', content: 'openai' } } as any;
    });
    const superChat = vi.spyOn(OllamaClient.prototype, 'chat');
    const gatewayChat = vi.spyOn(OllamaClient.prototype, 'chatStream');

    await c.chat({ model: 'glm-5.3-flash', messages: [] } as any);
    await c.chat({ model: 'gemma4:12b-mlx', messages: [] } as any);
    await c.chat({ model: 'phi4:14b', messages: [] } as any);   // unrouted → OpenAI fallback
    expect(seen).toEqual(['vllm', 'mini', 'openai']);
    expect(superChat).not.toHaveBeenCalled();
    expect(gatewayChat).not.toHaveBeenCalled();
    fallbackChat.mockRestore();
    superChat.mockRestore();
    gatewayChat.mockRestore();
  });

  it('chatStream unrouted goes to the OpenAI fallback, not the Ollama gateway', async () => {
    const c = build();
    const fallbackStream = vi.spyOn((c as any).fallback, 'chatStream').mockImplementation(async () => {
      return { message: { role: 'assistant', content: 'openai-stream' } } as any;
    });
    const gatewayStream = vi.spyOn(OllamaClient.prototype, 'chatStream');
    await c.chatStream({ model: 'phi4:14b', messages: [] } as any, () => undefined);
    expect(fallbackStream).toHaveBeenCalledOnce();
    expect(gatewayStream).not.toHaveBeenCalled();
  });

  it('isAvailable/listModels probe the OpenAI fallback, not the Ollama gateway', async () => {
    const c = build();
    const fallbackAvail = vi.spyOn((c as any).fallback, 'isAvailable').mockResolvedValue(true);
    const fallbackList = vi.spyOn((c as any).fallback, 'listModels').mockResolvedValue([{ name: 'swift15-iq3s' } as any]);
    const gateway = vi.spyOn(OllamaClient.prototype, 'isAvailable');

    expect(await c.isAvailable()).toBe(true);
    const models = await c.listModels();
    expect(models.map(m => m.name)).toEqual(['swift15-iq3s']);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('an Ollama-native backend alone still builds a routing client (no OpenAI backends required)', () => {
    const c = createInferenceClient('http://gateway:11434', '30m', [], [{ url: 'http://mini:11434', models: ['gemma4:12b-mlx'] } as any]);
    expect(c).toBeInstanceOf(MultiBackendClient);
    expect((c as any).routes.get('gemma4:12b-mlx')).toBeInstanceOf(OllamaClient);
  });

  it('no backends at all → plain OllamaClient (unchanged behavior)', () => {
    const c = createInferenceClient('http://gateway:11434', '30m', [], []);
    expect(c).toBeInstanceOf(OllamaClient);
    expect(c).not.toBeInstanceOf(MultiBackendClient);
  });
});

describe('embedding routing (memory priming must not fight the router for VRAM)', () => {
  it('routes embed() by model id to an Ollama-native backend', async () => {
    const c = new MultiBackendClient('http://gateway:11434', '30m', [],
      [{ url: 'http://mini:11434', models: ['qwen3-embedding:8b'] } as any]);
    const route = (c as any).routes.get('qwen3-embedding:8b');
    route.embed = vi.fn(async () => [[1, 2, 3]]);
    const gatewayEmbed = vi.spyOn(OllamaClient.prototype, 'embed').mockResolvedValue([[9]]);

    const out = await c.embed('hello', 'qwen3-embedding:8b');
    expect(out).toEqual([[1, 2, 3]]);          // went to the Mini
    expect(gatewayEmbed).not.toHaveBeenCalled(); // not the gateway
    gatewayEmbed.mockRestore();
  });

  it('an unrouted embedding model still falls through to the gateway', async () => {
    const c = new MultiBackendClient('http://gateway:11434', '30m', [], []);
    const gatewayEmbed = vi.spyOn(OllamaClient.prototype, 'embed').mockResolvedValue([[7]]);
    expect(await c.embed('hi', 'some-other-embedder')).toEqual([[7]]);
    gatewayEmbed.mockRestore();
  });

  it('never routes embeddings to an OpenAI-compat backend (no embed endpoint there)', async () => {
    const c = new MultiBackendClient('http://gateway:11434', '30m',
      [{ url: 'http://vllm:8000', models: ['some-embed'], supportsThink: false, thinkStyle: 'native' } as any], []);
    const gatewayEmbed = vi.spyOn(OllamaClient.prototype, 'embed').mockResolvedValue([[5]]);
    expect(await c.embed('hi', 'some-embed')).toEqual([[5]]);  // fell through, did not call vLLM
    gatewayEmbed.mockRestore();
  });
});
