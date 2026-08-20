import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse } from '../../src/ollama/types.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'write_file',
    description: 'Write a file',
    parameterDescription: '{"path", "content"}',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' }, content: { type: 'string', description: 'c' } }, required: ['path', 'content'] },
  },
];

function mockClient(script: Array<(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => OllamaChatResponse>) {
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

const answer = (content: string): OllamaChatResponse => ({ model: 't', message: { role: 'assistant', content }, done: true });
const toolCall = (name: string, args: Record<string, unknown>): OllamaChatResponse => ({
  model: 't',
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] },
  done: true,
});

const ctx = { agentId: 't', sessionKey: 't' } as ToolContext;

describe('onFinalAnswer turn-stopping checkpoint', () => {
  it('reject at natural stop injects feedback and the loop continues to an accepted answer', async () => {
    const { client, calls } = mockClient([
      () => toolCall('write_file', { path: 'x.md', content: 'stub' }),   // step 1: work (avoids refusal repair)
      () => answer('Done, I wrote the file.'),                            // step 2: premature completion
      () => toolCall('write_file', { path: 'x.md', content: 'real content now' }),  // post-feedback fix
      () => answer('Done for real this time.'),
    ]);
    let checks = 0;
    const result = await runToolLoop({
      client,
      config: {
        model: 't', maxIterations: 6, temperature: 0.3, maxTokens: 256, toolStyle: 'native',
        onFinalAnswer: async () => {
          checks++;
          return checks === 1
            ? { accept: false, feedback: 'VERIFICATION FAILED — x.md lacks required content.', grantIterations: 3 }
            : { accept: true };
        },
      },
      tools: TOOLS,
      executor: async () => 'written',
      toolContext: ctx,
      userMessage: 'Write x.md with real content.',
    });

    expect(checks).toBe(2);
    expect(result.answer).toContain('for real');
    expect(result.hitMaxIterations).toBe(false);
    // The rejection feedback arrived as a user message
    const feedbackMsg = calls.flatMap(c => c.messages).find(m => m.role === 'user' && String(m.content).includes('VERIFICATION FAILED'));
    expect(feedbackMsg).toBeTruthy();
  });

  it('reject at the iteration cap REPLACES the answer with honest feedback (no loop)', async () => {
    const { client } = mockClient([
      () => toolCall('write_file', { path: 'x.md', content: 'a' }),      // burns iterations
      () => toolCall('write_file', { path: 'x.md', content: 'aa' }),
      () => answer('I definitely finished everything.'),                  // hitMax synthesis
    ]);
    const hook = vi.fn(async () => ({ accept: false as const, feedback: '⚠️ I could not verify completion — x.md is placeholder junk.' }));
    const result = await runToolLoop({
      client,
      config: { model: 't', maxIterations: 2, temperature: 0.3, maxTokens: 256, toolStyle: 'native', onFinalAnswer: hook },
      tools: TOOLS,
      executor: async () => 'written',
      toolContext: ctx,
      userMessage: 'Write x.md.',
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.answer).toContain('could not verify completion');
    expect(result.answer).not.toContain('definitely finished');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('engine belt: at most 3 checkpoint invocations at natural stops', async () => {
    const { client } = mockClient([
      () => toolCall('write_file', { path: 'x.md', content: 's' }),
      () => answer('done 1'), () => answer('done 2'), () => answer('done 3'), () => answer('done 4'),
    ]);
    const hook = vi.fn(async () => ({ accept: false as const, feedback: 'nope', grantIterations: 2 }));
    const result = await runToolLoop({
      client,
      config: { model: 't', maxIterations: 12, temperature: 0.3, maxTokens: 256, toolStyle: 'native', onFinalAnswer: hook },
      tools: TOOLS,
      executor: async () => 'ok',
      toolContext: ctx,
      userMessage: 'Write x.md.',
    });
    expect(hook.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.answer).toBeTruthy(); // fourth natural stop is accepted without the hook
  });

  it('hook errors are swallowed — the answer is accepted (contracts must never break the loop)', async () => {
    const { client } = mockClient([
      () => toolCall('write_file', { path: 'x.md', content: 's' }),
      () => answer('all done'),
    ]);
    const result = await runToolLoop({
      client,
      config: {
        model: 't', maxIterations: 4, temperature: 0.3, maxTokens: 256, toolStyle: 'native',
        onFinalAnswer: async () => { throw new Error('checker exploded'); },
      },
      tools: TOOLS,
      executor: async () => 'ok',
      toolContext: ctx,
      userMessage: 'Write x.md.',
    });
    expect(result.answer).toContain('all done');
  });

  it('no hook = byte-identical legacy behavior', async () => {
    const { client, calls } = mockClient([
      () => toolCall('write_file', { path: 'x.md', content: 's' }),
      () => answer('legacy path answer'),
    ]);
    const result = await runToolLoop({
      client,
      config: { model: 't', maxIterations: 4, temperature: 0.3, maxTokens: 256, toolStyle: 'native' },
      tools: TOOLS,
      executor: async () => 'ok',
      toolContext: ctx,
      userMessage: 'Write x.md.',
    });
    expect(result.answer).toContain('legacy path answer');
    expect(calls.length).toBe(2);
  });
});
