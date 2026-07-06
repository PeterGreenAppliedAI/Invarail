import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaMessage, OllamaToolCall } from '../../src/ollama/types.js';
import type { ToolExecutor, ToolDefinition, ToolContext } from '../../src/tools/types.js';

interface MockResponse {
  content: string;
  tool_calls?: OllamaToolCall[];
}

function createMockClient(responses: MockResponse[]): OllamaClient {
  let callIndex = 0;
  return {
    chat: vi.fn().mockImplementation(async () => {
      const r = responses[callIndex] ?? { content: 'done' };
      callIndex++;
      return {
        message: {
          role: 'assistant',
          content: r.content,
          tool_calls: r.tool_calls ?? null,
        },
      };
    }),
    generate: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as OllamaClient;
}

function toolCall(name: string, args: Record<string, unknown>): OllamaToolCall {
  return { function: { name, arguments: args } };
}

const testTools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web',
    parameterDescription: 'query (required)',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
];

const testContext: ToolContext = { agentId: 'test', sessionKey: 'test' };

describe('runToolLoop', () => {
  it('returns final answer when model responds with content only', async () => {
    const client = createMockClient([
      { content: 'Hello! How can I help?' },
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: [],
      executor: vi.fn(),
      toolContext: testContext,
      userMessage: 'Hi',
    });

    expect(result.answer).toBe('Hello! How can I help?');
    expect(result.iterations).toBe(1);
    expect(result.hitMaxIterations).toBe(false);
  });

  it('executes tool call then returns final answer', async () => {
    const client = createMockClient([
      { content: '', tool_calls: [toolCall('web_search', { query: 'AI news' })] },
      { content: 'Here are the latest AI news...' },
    ]);

    const executor: ToolExecutor = vi.fn().mockResolvedValue('Result 1: AI is advancing');

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'Latest AI news',
    });

    expect(executor).toHaveBeenCalledWith('web_search', { query: 'AI news' }, testContext);
    expect(result.answer).toBe('Here are the latest AI news...');
    expect(result.iterations).toBe(2);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].observation).toBe('Result 1: AI is advancing');
  });

  it('handles tool execution errors gracefully', async () => {
    const client = createMockClient([
      { content: '', tool_calls: [toolCall('web_search', { query: 'test' })] },
      { content: 'Sorry, search failed.' },
    ]);

    const executor: ToolExecutor = vi.fn().mockRejectedValue(new Error('API down'));

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'search something',
    });

    expect(result.steps[0].observation).toContain('failed');
    expect(result.answer).toBe('Sorry, search failed.');
  });

  it('respects max iterations', async () => {
    // Model keeps calling tools forever, then synthesizes on max iterations
    const responses = [
      ...Array(3).fill({ content: '', tool_calls: [toolCall('web_search', { query: 'test' })] }),
      { content: 'Here is a synthesized answer.' }, // synthesis response
    ];
    const client = createMockClient(responses);

    const executor: ToolExecutor = vi.fn().mockResolvedValue('some result');

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 3, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'infinite loop test',
    });

    expect(result.hitMaxIterations).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.steps).toHaveLength(4); // 3 tool calls + 1 synthesis
    expect(result.answer).toBe('Here is a synthesized answer.');
  });

  it('handles plain text response (no tools provided)', async () => {
    const client = createMockClient([
      { content: 'I think the answer is 42.' },
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: [],
      executor: vi.fn(),
      toolContext: testContext,
      userMessage: 'What is the meaning of life?',
    });

    expect(result.answer).toBe('I think the answer is 42.');
    expect(result.iterations).toBe(1);
  });

  it('strips ReAct scaffolding from the final answer', async () => {
    const client = createMockClient([
      { content: 'Thought: I have everything I need.\nFinal Answer: Paris is the capital of France.' },
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: [],
      executor: vi.fn(),
      toolContext: testContext,
      userMessage: 'Capital of France?',
    });

    expect(result.answer).toBe('Paris is the capital of France.');
  });

  it('retries once on empty completion instead of returning empty answer', async () => {
    const client = createMockClient([
      { content: '' },
      { content: 'Recovered answer.' },
    ]);

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: [],
      executor: vi.fn(),
      toolContext: testContext,
      userMessage: 'Hi',
    });

    expect(result.answer).toBe('Recovered answer.');
    expect(result.hitMaxIterations).toBe(false);
  });

  it('does not flag data claims as hallucination after a real tool call', async () => {
    const client = createMockClient([
      { content: '', tool_calls: [toolCall('web_search', { query: 'AAPL price' })] },
      { content: 'The current price of AAPL is $210.' },
    ]);

    const executor: ToolExecutor = vi.fn().mockResolvedValue('AAPL: $210');

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'AAPL price?',
    });

    // Answer accepted directly — no hallucination repair round-trip
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe('The current price of AAPL is $210.');
  });

  it('does not duplicate assistant messages when action dedup blocks a repeat', async () => {
    const client = createMockClient([
      { content: '', tool_calls: [toolCall('web_search', { query: 'same' })] },
      { content: '', tool_calls: [toolCall('web_search', { query: 'same' })] },
      { content: '', tool_calls: [toolCall('web_search', { query: 'same' })] }, // blocked by dedup
      { content: 'Done.' },
    ]);

    const executor: ToolExecutor = vi.fn().mockResolvedValue('result');

    await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 10, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'loop test',
    });

    const lastCallArgs = (client.chat as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const roles = lastCallArgs.messages.map((m: OllamaMessage) => m.role);
    for (let i = 1; i < roles.length; i++) {
      if (roles[i] === 'assistant') {
        expect(roles[i - 1]).not.toBe('assistant');
      }
    }
  });

  it('handles multi-step tool chain', async () => {
    const client = createMockClient([
      { content: '', tool_calls: [toolCall('web_search', { query: 'topic A' })] },
      { content: '', tool_calls: [toolCall('web_search', { query: 'topic A details' })] },
      { content: 'Topic A is about X with details Y.' },
    ]);

    const executor: ToolExecutor = vi.fn()
      .mockResolvedValueOnce('Overview of topic A')
      .mockResolvedValueOnce('Detailed info about topic A');

    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 5, temperature: 0.7, maxTokens: 1024 },
      tools: testTools,
      executor,
      toolContext: testContext,
      userMessage: 'Tell me about topic A',
    });

    expect(result.iterations).toBe(3);
    expect(result.steps).toHaveLength(3);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe('Topic A is about X with details Y.');
  });
});
