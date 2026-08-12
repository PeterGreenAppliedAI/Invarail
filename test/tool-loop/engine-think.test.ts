import { describe, it, expect } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse } from '../../src/ollama/types.js';
import type { ToolContext } from '../../src/tools/types.js';

function mockClient(): { client: OllamaClient; calls: Array<Omit<OllamaChatParams, 'stream' | 'keep_alive'>> } {
  const calls: Array<Omit<OllamaChatParams, 'stream' | 'keep_alive'>> = [];
  const client = {
    chat: async (params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> => {
      calls.push(params);
      return { model: 'test', message: { role: 'assistant', content: 'done' }, done: true };
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

const base = { maxIterations: 3, temperature: 0.3, maxTokens: 256, toolStyle: 'native' as const, model: 'test' };
const ctx = { agentId: 't', sessionKey: 't' } as ToolContext;

describe('think passthrough in tool loop', () => {
  it('forwards think:false to every chat call', async () => {
    const { client, calls } = mockClient();
    await runToolLoop({ client, config: { ...base, think: false }, tools: [], executor: async () => '', toolContext: ctx, userMessage: 'hi' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.think).toBe(false);
  });

  it('omits think entirely when unset (model default — prod behavior today)', async () => {
    const { client, calls } = mockClient();
    await runToolLoop({ client, config: base, tools: [], executor: async () => '', toolContext: ctx, userMessage: 'hi' });
    for (const c of calls) expect('think' in c).toBe(false);
  });
});
