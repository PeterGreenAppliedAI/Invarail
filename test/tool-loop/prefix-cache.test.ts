import { describe, it, expect, vi } from 'vitest';
import { buildReActSystemPrompt, buildVolatileContext } from '../../src/tool-loop/prompt-builder.js';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaChatParams } from '../../src/ollama/types.js';
import type { ToolContext } from '../../src/tools/types.js';

/**
 * PREFIX-CACHE CONTRACT. Every backend caches the KV state of a shared prompt
 * prefix; volatile content near the front re-prefills everything after it,
 * conversation history included (measured: 61s vs 0.3s at 8K tokens on a Mini).
 * These tests fail if per-turn content creeps back into the cached head.
 */
describe('prefix-cache contract', () => {
  const ctxA = { statePreamble: 'turn=1, topic="alpha"', userPriming: 'User facts: A' };
  const ctxB = { statePreamble: 'turn=2, topic="beta"', userPriming: 'User facts: B' };

  it('the system prompt is byte-identical across turns despite changing state/memory', () => {
    const a = buildReActSystemPrompt('You are a helper.', [], 'SOUL.md contents', ctxA);
    const b = buildReActSystemPrompt('You are a helper.', [], 'SOUL.md contents', ctxB);
    expect(a).toBe(b);
    // and it must not leak the volatile values at all
    expect(a).not.toContain('topic="alpha"');
    expect(a).not.toContain('User facts: A');
  });

  it('volatile content is carried by buildVolatileContext, or null when empty', () => {
    expect(buildVolatileContext(ctxA)).toContain('topic="alpha"');
    expect(buildVolatileContext(ctxA)).toContain('User facts: A');
    expect(buildVolatileContext({})).toBeNull();
    expect(buildVolatileContext(undefined)).toBeNull();
  });

  it('message order: [system][history][volatile][user] — prefix grows only at the tail', async () => {
    let captured: Omit<OllamaChatParams, 'stream' | 'keep_alive'> | undefined;
    const client = {
      chat: async (p: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => {
        captured = p;
        return { model: 't', message: { role: 'assistant', content: 'done' }, done: true } as never;
      },
    } as unknown as OllamaClient;

    await runToolLoop({
      client,
      config: { model: 'm', maxIterations: 1, temperature: 0.3, maxTokens: 64, systemPrompt: 'sys', toolStyle: 'native' },
      tools: [],
      executor: async () => '',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'hello',
      history: [{ role: 'user', content: 'older turn' }, { role: 'assistant', content: 'older reply' }],
      promptContext: ctxA,
    });

    const roles = captured!.messages.map(m => m.role);
    const contents = captured!.messages.map(m => m.content ?? '');
    expect(roles[0]).toBe('system');
    expect(contents[1]).toBe('older turn');       // history follows the static head
    expect(contents[2]).toBe('older reply');
    expect(contents[3]).toContain('topic="alpha"'); // volatile tail, AFTER history
    expect(contents[4]).toBe('hello');              // user message last
    // the cached head must be free of per-turn content
    expect(contents[0]).not.toContain('topic="alpha"');
  });

  it('no volatile content → no extra message (nothing to invalidate)', async () => {
    let captured: Omit<OllamaChatParams, 'stream' | 'keep_alive'> | undefined;
    const client = {
      chat: async (p: Omit<OllamaChatParams, 'stream' | 'keep_alive'>) => {
        captured = p;
        return { model: 't', message: { role: 'assistant', content: 'done' }, done: true } as never;
      },
    } as unknown as OllamaClient;
    await runToolLoop({
      client,
      config: { model: 'm', maxIterations: 1, temperature: 0.3, maxTokens: 64, systemPrompt: 'sys', toolStyle: 'native' },
      tools: [], executor: async () => '',
      toolContext: { agentId: 't', sessionKey: 't' } as ToolContext,
      userMessage: 'hello',
    });
    expect(captured!.messages.map(m => m.role)).toEqual(['system', 'user']);
  });
});
