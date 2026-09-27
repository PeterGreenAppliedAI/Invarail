import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchQuota } from '../../src/tools/search-quota.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';

describe('SearchQuota', () => {
  it('counts per local day, refuses at the ceiling, resets on the next day', () => {
    const q = new SearchQuota(join(mkdtempSync(join(tmpdir(), 'quota-')), 'q.json'), 2);
    const d1 = new Date('2026-09-27T10:00:00'); const d2 = new Date('2026-09-28T00:00:01');
    expect(q.tryConsume(d1)).toEqual({ ok: true, used: 1 });
    expect(q.tryConsume(d1)).toEqual({ ok: true, used: 2 });
    expect(q.tryConsume(d1)).toEqual({ ok: false, used: 2, ceiling: 2 });
    expect(q.used(d1)).toBe(2);
    expect(q.tryConsume(d2)).toEqual({ ok: true, used: 1 });
  });

  it('ceiling 0 is unlimited', () => {
    const q = new SearchQuota(join(mkdtempSync(join(tmpdir(), 'quota-')), 'q.json'), 0);
    for (let i = 0; i < 50; i++) expect(q.tryConsume().ok).toBe(true);
  });

  it('web_search refuses past the ceiling without calling the provider, and a cache hit is free', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 't', url: 'https://e.example/a', content: 'c' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const quota = new SearchQuota(join(mkdtempSync(join(tmpdir(), 'quota-')), 'q.json'), 1);
    const tool = createWebSearchTool({ provider: 'searxng', baseUrl: 'http://searx.test', cacheTtlMs: 60_000, dailyQueryCeiling: 1 } as any, { quota });
    const ctx = {} as any;
    expect(await tool.execute({ query: 'first' }, ctx)).toMatch(/e\.example/);
    expect(await tool.execute({ query: 'first' }, ctx)).toMatch(/e\.example/);        // cache hit: no quota
    expect(await tool.execute({ query: 'second' }, ctx)).toMatch(/Search paused/);   // ceiling
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
