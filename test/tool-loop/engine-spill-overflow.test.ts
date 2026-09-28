import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams, OllamaChatResponse } from '../../src/ollama/types.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'dump',
    description: 'Dump data',
    parameterDescription: '{}',
    parameters: { type: 'object', properties: {}, required: [] },
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
const toolCall = (name: string): OllamaChatResponse => ({
  model: 't',
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: {} } }] },
  done: true,
});

const baseConfig = {
  model: 'test-model',
  maxIterations: 5,
  temperature: 0.3,
  maxTokens: 512,
  systemPrompt: 'test',
  toolStyle: 'native' as const,
};

describe('observation spill (dsh borrow)', () => {
  it('spills the FULL oversized observation to .spill/ and hints the path', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'spill-'));
    const big = 'X'.repeat(30_000) + 'NEEDLE_AT_THE_END';
    const { client } = mockClient([
      () => toolCall('dump'),
      () => answer('done'),
    ]);
    const result = await runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => big,
      toolContext: { agentId: 't', sessionKey: 't', workspacePath: ws } as ToolContext,
      userMessage: 'dump it',
    });
    const obs = result.steps[0].observation;
    expect(obs).toContain('FULL output saved to');
    expect(obs).toMatch(/\.spill[\\/]/);   // the hint is an OS path
    const spillDir = join(ws, '.spill');
    const files = readdirSync(spillDir);
    expect(files).toHaveLength(1);
    // The spill file holds the WHOLE observation, including the tail the budget cut
    expect(readFileSync(join(spillDir, files[0]), 'utf-8')).toContain('NEEDLE_AT_THE_END');
    rmSync(ws, { recursive: true, force: true });
  });

  it('no workspace → truncates without spilling and without crashing', async () => {
    const { client } = mockClient([
      () => toolCall('dump'),
      () => answer('done'),
    ]);
    const result = await runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => 'Y'.repeat(30_000),
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'dump it',
    });
    expect(result.steps[0].observation).toContain('truncated from');
    expect(result.steps[0].observation).not.toContain('FULL output saved');
  });
});

describe('mid-run cancellation (!stop)', () => {
  it('stops at the next iteration boundary with an honest partial answer', async () => {
    let cancelled = false;
    const { client } = mockClient([
      () => toolCall('dump'),
      () => answer('should never be reached'),
    ]);
    const result = await runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => { cancelled = true; return 'step one done'; },
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'go',
      isCancelled: () => cancelled,
    });
    expect(result.cancelled).toBe(true);
    expect(result.answer).toContain('Stopped on request after 1 tool step');
    expect(result.answer).toContain('did NOT complete');
  });

  it('never-cancelled runs are unaffected', async () => {
    const { client } = mockClient([
      () => toolCall('dump'),
      () => answer('done normally'),
    ]);
    const result = await runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => 'ok',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'go',
      isCancelled: () => false,
    });
    expect(result.cancelled).toBeUndefined();
    expect(result.answer).toBe('done normally');
  });
});

describe('server-reported context overflow (dsh borrow)', () => {
  it('hard-compacts old tool observations and retries once', async () => {
    let threw = false;
    const calls: Array<Omit<OllamaChatParams, 'stream' | 'keep_alive'>> = [];
    const client = {
      chat: async (params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => {
        calls.push(params);
        if (calls.length === 1) return toolCall('dump');
        if (calls.length === 2 && !threw) {
          threw = true;
          throw new Error('This model\'s maximum context length is 32768 tokens');
        }
        return answer('recovered');
      },
    } as unknown as OllamaClient;

    const result = await runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => 'observation '.repeat(100),
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'go',
    });
    expect(result.answer).toBe('recovered');
    expect(threw).toBe(true);
  });

  it('a second overflow is a real failure — no retry loop', async () => {
    const client = {
      chat: async () => { throw new Error('context length exceeded'); },
    } as unknown as OllamaClient;
    await expect(runToolLoop({
      client,
      config: baseConfig,
      tools: TOOLS,
      executor: async () => 'x',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'go',
    })).rejects.toThrow(/context length/);
  });
});
