import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWebsiteQueryTool } from '../../src/tools/website-query.js';

afterEach(() => vi.unstubAllGlobals());
const ctx = { agentId: 'main', sessionKey: 's', workspacePath: '/tmp' } as any;

// Outside review F10 (2026-09-27): `new URL(endpoint, base)` accepted an absolute URL or a
// network-path reference, and the configured bearer key went to that origin.
describe('website_query stays on its configured origin', () => {
  const tool = createWebsiteQueryTool({ baseUrl: 'https://site.example', apiKey: 'DUMMY_KEY' } as any);

  it('refuses an absolute endpoint on another origin and a //host reference, before any fetch', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const endpoint of ['http://127.0.0.1:9/steal', 'https://evil.example/x', '//evil.example/x']) {
      expect(await tool.execute({ endpoint }, ctx), endpoint).toMatch(/must be a path on the configured site/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a relative endpoint to the configured origin with the key, and never follows redirects', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await tool.execute({ endpoint: '/api/courses' }, ctx);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/site\.example\/api\/courses/);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer DUMMY_KEY');
    expect(init.redirect).toBe('error');
  });
});
