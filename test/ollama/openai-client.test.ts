import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatClient } from '../../src/ollama/openai-client.js';

function mockFetchOnce(body: unknown) {
  const captured: { url?: string; init?: RequestInit } = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return captured;
}

function parseBody(captured: { init?: RequestInit }): any {
  return JSON.parse(captured.init?.body as string);
}

const OK_RESPONSE = {
  model: 'deepseek-v4-flash',
  choices: [{ message: { role: 'assistant', content: 'yes' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

describe('OpenAICompatClient think handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omits think and warns once when the backend is not declared think-capable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://openai-compat.local');
    await client.chat({
      model: 'some-model',
      messages: [{ role: 'user', content: 'hi' }],
      think: false,
    });
    expect(parseBody(captured).think).toBeUndefined();
    const thinkWarnings = warn.mock.calls.filter(c => String(c[0]).includes('think'));
    expect(thinkWarnings.length).toBe(1);
    warn.mockRestore();
  });

  it('forwards think when the backend declares supportsThink (ds4)', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://ds4.local', undefined, true);
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      think: false,
    });
    expect(parseBody(captured).think).toBe(false);
  });
});

describe('OpenAICompatClient max_tokens reasoning headroom', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds reasoning headroom to a small num_predict so reasoning cannot starve the answer', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'does the source support this claim?' }],
      options: { num_predict: 400 },
    });
    expect(parseBody(captured).max_tokens).toBe(400 + 16384);
  });

  it('still adds headroom on top of large answer budgets', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write the report' }],
      options: { num_predict: 8192 },
    });
    expect(parseBody(captured).max_tokens).toBe(8192 + 16384);
  });

  it('gives an HONEST max_tokens (no headroom) when think is explicitly false', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://sglang.local', undefined, true, 'qwen-template');
    await client.chat({
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'quick answer' }],
      think: false,
      options: { num_predict: 400 },
    });
    expect(parseBody(captured).max_tokens).toBe(400);
    expect(parseBody(captured).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('omits max_tokens entirely when no num_predict is given', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      options: { temperature: 0.2 },
    });
    expect(parseBody(captured).max_tokens).toBeUndefined();
  });
});

describe('qwen-template effort levels', () => {
  it('translates effort strings to chat_template_kwargs.reasoning_effort, high -> xhigh', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://sglang.local', undefined, true, 'qwen-template');
    await client.chat({
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hard problem' }],
      think: 'low',
      options: { num_predict: 400 },
    });
    expect(parseBody(captured).chat_template_kwargs).toEqual({ reasoning_effort: 'low' });

    const captured2 = mockFetchOnce(OK_RESPONSE);
    await client.chat({
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hard problem' }],
      think: 'high',
      options: { num_predict: 400 },
    });
    expect(parseBody(captured2).chat_template_kwargs).toEqual({ reasoning_effort: 'xhigh' });
  });
});
