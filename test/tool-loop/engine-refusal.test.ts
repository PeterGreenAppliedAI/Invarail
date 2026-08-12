import { describe, it, expect } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse } from '../../src/ollama/types.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web',
    parameterDescription: '{"query": "..."}',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'query' } }, required: ['query'] },
  },
];

function mockClient(script: Array<(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => OllamaChatResponse>): { client: OllamaClient; calls: Array<Omit<OllamaChatParams, 'stream' | 'keep_alive'>> } {
  const calls: Array<Omit<OllamaChatParams, 'stream' | 'keep_alive'>> = [];
  const client = {
    chat: async (params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => {
      calls.push(params);
      const responder = script[Math.min(calls.length - 1, script.length - 1)];
      return responder(params);
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

const answerResponse = (content: string): OllamaChatResponse => ({
  model: 'test',
  message: { role: 'assistant', content },
  done: true,
});

describe('premature-refusal repair prompt', () => {
  it('offers a no-tool exit instead of commanding tool use, and accepts a restated answer', async () => {
    const { client, calls } = mockClient([
      () => answerResponse('5 kilometers is about 3.11 miles.'),
      () => answerResponse('5 kilometers is approximately 3.11 miles.'),
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 4, temperature: 0.3, maxTokens: 256, toolStyle: 'native' },
      tools: TOOLS,
      executor: async () => 'unused',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'Convert 5 kilometers to miles.',
    });

    // Repair fired exactly once, then the restated answer was accepted
    expect(calls.length).toBe(2);
    const repairMsg = calls[1].messages[calls[1].messages.length - 1];
    expect(repairMsg.role).toBe('user');
    expect(repairMsg.content).toContain('If NO tool is relevant');
    expect(repairMsg.content).toContain('restate your answer directly');
    // The old unconditional order must be gone — it caused tool-call spirals
    expect(repairMsg.content).not.toContain('MUST use your available tools');
    expect(repairMsg.content).not.toContain('Start by calling the most relevant tool');

    expect(result.answer).toContain('3.11 miles');
    expect(result.hitMaxIterations).toBe(false);
  });

  it('still repairs only once — a second no-tool answer ends the loop', async () => {
    const { client, calls } = mockClient([
      () => answerResponse('The answer is 42.'),
      () => answerResponse('The answer is 42.'),
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 4, temperature: 0.3, maxTokens: 256, toolStyle: 'native' },
      tools: TOOLS,
      executor: async () => 'unused',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'What is the answer?',
    });

    expect(calls.length).toBe(2);
    expect(result.answer).toContain('42');
  });
});
