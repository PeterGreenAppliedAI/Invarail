import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaClient } from '../../src/ollama/client.js';

/** An NDJSON body the way Ollama streams /api/chat. */
function ndjson(chunks: object[]): Response {
  const body = chunks.map(c => JSON.stringify(c)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('OllamaClient stream accumulation', () => {
  // The 2026-09-20 regression: chat() started routing through chatStream to fix
  // the headers timeout, and chatStream read tool_calls off the LAST chunk — which
  // is the stats-only `done:true` chunk. Every native tool call became an "empty
  // completion". The model had answered correctly the whole time.
  it('returns a tool call that arrived in a middle chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([
      { model: 'm', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'task_add', arguments: { title: 'Take the garbage out' } } }] }, done: false },
      { model: 'm', message: { role: 'assistant', content: '' }, done: true, eval_count: 104, prompt_eval_count: 900 },
    ])));
    const client = new OllamaClient('http://ollama.test', '5m');
    const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls![0].function.name).toBe('task_add');
    expect(res.message.content).toBe('');
    expect(res.eval_count).toBe(104);
  });

  it('accumulates several tool calls across chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a', arguments: {} } }] }, done: false },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'b', arguments: {} } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true },
    ])));
    const res = await new OllamaClient('http://ollama.test').chat({ model: 'm', messages: [] });
    expect(res.message.tool_calls!.map(t => t.function.name)).toEqual(['a', 'b']);
  });

  it('accumulates content and thinking, sends only content to onDelta, omits tool_calls when none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([
      { message: { role: 'assistant', thinking: 'let me ' }, done: false },
      { message: { role: 'assistant', thinking: 'think' }, done: false },
      { message: { role: 'assistant', content: 'hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: true, eval_count: 5 },
    ])));
    const deltas: string[] = [];
    const res = await new OllamaClient('http://ollama.test').chatStream({ model: 'm', messages: [] }, d => deltas.push(d));
    expect(res.message.content).toBe('hello');
    expect(res.message.thinking).toBe('let me think');
    expect(deltas).toEqual(['hel', 'lo']);
    expect(res.message.tool_calls).toBeUndefined();
  });
});

// A utility call that omits num_ctx used to inherit the SERVER's default — 32K on
// the A5000 — and a 3.8B model at 32K is 7GB, enough to evict the foreground 27B.
describe('OllamaClient default num_ctx', () => {
  const body = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));

  it('fills num_ctx when the caller leaves it unset', async () => {
    const fetchMock = vi.fn(async () => ndjson([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaClient('http://ollama.test', '5m', 8192).chat({ model: 'phi4-mini', messages: [], options: { temperature: 0.1 } });
    expect(body(fetchMock).options).toEqual({ temperature: 0.1, num_ctx: 8192 });
  });

  it('never overrides a num_ctx the caller set (foreground passes its own)', async () => {
    const fetchMock = vi.fn(async () => ndjson([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaClient('http://ollama.test', '5m', 8192).chat({ model: 'qwen3.8:27B', messages: [], options: { num_ctx: 32768 } });
    expect(body(fetchMock).options.num_ctx).toBe(32768);
  });

  it('leaves options untouched when no default is configured', async () => {
    const fetchMock = vi.fn(async () => ndjson([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaClient('http://ollama.test').chat({ model: 'm', messages: [] });
    expect(body(fetchMock).options).toBeUndefined();
  });
});
