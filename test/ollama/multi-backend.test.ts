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

  it('routes by model id: OpenAI-compat, Ollama-native host, and gateway fallthrough', async () => {
    const c = build();
    const seen: string[] = [];
    // Stub each destination so we can observe which one a model reaches.
    for (const [model, label] of [['glm-5.3-flash', 'vllm'], ['gemma4:12b-mlx', 'mini']] as const) {
      const route = (c as any).routes.get(model);
      route.chat = vi.fn(async () => { seen.push(label); return { message: { role: 'assistant', content: label } }; });
    }
    // Gateway fallthrough = the inherited OllamaClient.chat
    const superChat = vi.spyOn(OllamaClient.prototype, 'chat').mockImplementation(async () => {
      seen.push('gateway'); return { message: { role: 'assistant', content: 'gateway' } } as any;
    });

    await c.chat({ model: 'glm-5.3-flash', messages: [] } as any);
    await c.chat({ model: 'gemma4:12b-mlx', messages: [] } as any);
    await c.chat({ model: 'phi4:14b', messages: [] } as any);   // utility tier → gateway
    expect(seen).toEqual(['vllm', 'mini', 'gateway']);
    superChat.mockRestore();
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
