import { describe, it, expect } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse, OllamaMessage } from '../../src/ollama/types.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'memory_search',
    description: 'Search memory',
    parameterDescription: '{"query"}',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'q' } }, required: ['query'] },
  },
];

function mockClient(script: Array<() => OllamaChatResponse>) {
  let n = 0;
  const client = {
    chat: async (_p: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => script[Math.min(n++, script.length - 1)](),
  } as unknown as OllamaClient;
  return { client, calls: () => n };
}

const answer = (content: string): OllamaChatResponse => ({ model: 't', message: { role: 'assistant', content }, done: true });
const ctx = { agentId: 't', sessionKey: 't' } as ToolContext;
const config = { model: 't', maxIterations: 6, temperature: 0.3, maxTokens: 256, toolStyle: 'native' as const };
const history: OllamaMessage[] = [
  { role: 'user', content: 'What do you know about me' },
  { role: 'assistant', content: "here's what i've got on you: ..." },
];

describe('premature-answer guard on short follow-ups', () => {
  it('does not repair a direct reply to a short follow-up mid-session', async () => {
    const { client, calls } = mockClient([() => answer("cool. that's the picture then.")]);
    const result = await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'Awesome', history });
    expect(result.answer).toBe("cool. that's the picture then.");
    expect(calls()).toBe(1);
  });

  it('still repairs a no-tool answer on a real first-turn request', async () => {
    const { client, calls } = mockClient([
      () => answer("i can't search memory."),
      () => answer("i can't search memory."),
    ]);
    await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'Search my memory for everything about the A5000 purchase' });
    expect(calls()).toBe(2);
  });

  it('a short message with NO history is still guarded', async () => {
    const { client, calls } = mockClient([() => answer('nope'), () => answer('nope')]);
    await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'Awesome' });
    expect(calls()).toBe(2);
  });
});
