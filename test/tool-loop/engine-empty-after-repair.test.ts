import { describe, it, expect } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse } from '../../src/ollama/types.js';
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
const empty = () => answer('');
const ctx = { agentId: 't', sessionKey: 't' } as ToolContext;
const config = { model: 't', maxIterations: 6, temperature: 0.3, maxTokens: 256, toolStyle: 'native' as const };

// Live shape, 2026-09-20: step 1 empty (a dropped tool call), step 2 a correct
// direct answer from injected memory, the premature-answer repair sends it back,
// step 3 empty again. The loop used to return the empty step 3.
describe('empty answer after a behavioral repair', () => {
  it('returns the answer the repair rejected rather than nothing', async () => {
    const { client } = mockClient([
      empty,
      () => answer('i know a fair bit about you, peter.'),
      empty,
    ]);
    const result = await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'What do you know about me' });
    expect(result.answer).toBe('i know a fair bit about you, peter.');
  });

  it('prefers a non-empty restatement when the retry does answer', async () => {
    const { client } = mockClient([
      empty,
      () => answer('first version'),
      () => answer('restated, and better'),
    ]);
    const result = await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'What do you know about me' });
    expect(result.answer).toBe('restated, and better');
  });

  it('still returns empty-ish honestly when nothing was ever produced', async () => {
    const { client } = mockClient([empty, empty, empty]);
    const result = await runToolLoop({ client, config, tools: TOOLS, executor: async () => '', toolContext: ctx, userMessage: 'hi' });
    expect(result.answer.trim()).toBe('');
  });
});
