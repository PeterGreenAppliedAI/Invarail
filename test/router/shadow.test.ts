import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SystemOneClient, ROUTER_QUESTION_INSTRUCTIONS } from '../../src/router/systemone-client.js';
import { RouterShadow, routerShadowFor } from '../../src/router/shadow.js';
import { RouterConfigSchema } from '../../src/config/schema.js';

const testDir = '/tmp/invarail-test-shadow-' + Date.now();
const logPath = join(testDir, 'router-shadow.jsonl');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const answer = (choice: string, probs: Record<string, number>) => ({ answers: { category: { type: 'choice', choice, probabilities: probs, confidence: probs[choice] } } });
const CATS = { chat: 'talk', task: 'to-do board', memory: 'recall facts' };

beforeEach(() => { rmSync(testDir, { recursive: true, force: true }); mkdirSync(testDir, { recursive: true }); });
afterEach(() => vi.unstubAllGlobals());

describe('SystemOneClient', () => {
  it('sends the routing question with the category descriptions as option text and returns the decision', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(answer('task', { chat: 0.03, task: 0.95, memory: 0.02 })));
    vi.stubGlobal('fetch', fetchMock);
    const d = await new SystemOneClient('http://laya.test:8010/', 1000).route('add a task', CATS);
    expect(d).toMatchObject({ choice: 'task', confidence: 0.95 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://laya.test:8010/v1/systemone');
    const body = JSON.parse(init.body as string);
    expect(body.state).toEqual({ message: 'add a task' });
    expect(body.questions.category).toEqual({ type: 'choice', instructions: ROUTER_QUESTION_INSTRUCTIONS, criteria: CATS });
  });

  it('returns null, never throws, on network failure, non-2xx, and malformed answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await new SystemOneClient('http://x', 500).route('m', CATS)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'nope' }, 503)));
    expect(await new SystemOneClient('http://x', 500).route('m', CATS)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ answers: {} })));
    expect(await new SystemOneClient('http://x', 500).route('m', CATS)).toBeNull();
  });
});

describe('RouterShadow', () => {
  const config = (over: Record<string, unknown> = {}) => RouterConfigSchema.parse({
    model: 'phi4', categories: { chat: { description: 'talk' }, task: { description: 'to-do board' } },
    shadow: { enabled: true, url: 'http://laya.test:8010', logPath, ...over },
  });

  it('logs live vs shadow side by side without changing or awaiting anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(answer('task', { chat: 0.1, task: 0.9 }))));
    const shadow = new RouterShadow(config());
    const before = Date.now();
    shadow.observe('add a task for tomorrow', 'chat', 'sticky');   // returns immediately
    expect(Date.now() - before).toBeLessThan(50);
    await new Promise(r => setTimeout(r, 30));
    const row = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n').pop()!);
    expect(row).toMatchObject({ decided: 'chat', decidedBy: 'sticky', shadow: 'task', confidence: 0.9 });
    expect(row.top[0]).toBe('task:0.90');
  });

  it('sends the config descriptions verbatim as the option text', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(answer('chat', { chat: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    new RouterShadow(config()).observe('hey', 'chat', 'model');
    await new Promise(r => setTimeout(r, 30));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.questions.category.criteria).toEqual({ chat: 'talk', task: 'to-do board' });
  });

  it('is a no-op when disabled or unconfigured, and survives an unreachable server', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(routerShadowFor(config({ enabled: false }))).toBeNull();
    expect(routerShadowFor(RouterConfigSchema.parse({ model: 'phi4' }))).toBeNull();
    const shadow = routerShadowFor(config())!;
    shadow.observe('hey', 'chat', 'model'); shadow.observe('hey', 'chat', 'model');
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(existsSync(logPath)).toBe(false);
  });
});
