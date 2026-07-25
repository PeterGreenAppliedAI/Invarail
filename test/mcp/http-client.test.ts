import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpHttpClient } from '../../src/mcp/http-client.js';
import { SecretStore } from '../../src/security/secret-store.js';
import { getAccessToken } from '../../src/mcp/oauth.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-http-server.mjs');

function startFixture(args: string[] = []): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, ...args]);
    child.stdout!.once('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/PORT=(\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}/mcp` });
      else reject(new Error('no port'));
    });
    child.once('error', reject);
  });
}

describe('McpHttpClient (against real fixture HTTP server)', () => {
  let child: ChildProcess;
  let url: string;
  beforeAll(async () => ({ child, url } = await startFixture()));
  afterAll(() => child.kill());

  it('handshakes, carries the session id, and lists tools', async () => {
    const client = new McpHttpClient({ name: 'fh', url, timeoutMs: 3000 });
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['echo', 'sse_op']);
    expect(client.alive).toBe(true);
  });

  it('round-trips a JSON tool call', async () => {
    const client = new McpHttpClient({ name: 'fh', url, timeoutMs: 3000 });
    await client.connect();
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.content[0].text).toBe('echo:{"text":"hi"}');
  });

  it('parses SSE responses, taking the final matching event past progress events', async () => {
    const client = new McpHttpClient({ name: 'fh', url, timeoutMs: 3000 });
    await client.connect();
    const result = await client.callTool('sse_op', {});
    expect(result.content[0].text).toBe('streamed done');
  });
});

describe('McpHttpClient auth', () => {
  let child: ChildProcess;
  let url: string;
  beforeAll(async () => ({ child, url } = await startFixture(['--require-auth'])));
  afterAll(() => child.kill());

  it('401 without a token produces a clean re-auth error', async () => {
    const client = new McpHttpClient({ name: 'fh', url, timeoutMs: 3000 });
    await expect(client.connect()).rejects.toThrow(/401 unauthorized.*mcp-oauth-setup/);
  });

  it('sends the bearer token from getToken', async () => {
    const client = new McpHttpClient({ name: 'fh', url, timeoutMs: 3000, getToken: async () => 'good-token' });
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
  });
});

describe('SecretStore + token access', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'secrets-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('persists 0600 and never leaks values through status()', () => {
    const store = new SecretStore(join(dir, 'secrets.json'));
    store.set('mcp-oauth:linear', { access_token: 'SUPERSECRET', refresh_token: 'ALSOSECRET' });
    const mode = statSync(join(dir, 'secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    const status = JSON.stringify(store.status());
    expect(status).toContain('mcp-oauth:linear');
    expect(status).toContain('access_token');
    expect(status).not.toContain('SUPERSECRET');
    // raw file DOES contain it (that's the store) — but status never does
    expect(readFileSync(join(dir, 'secrets.json'), 'utf-8')).toContain('SUPERSECRET');
  });

  it('getAccessToken returns stored unexpired tokens and null when no profile exists', async () => {
    const store = new SecretStore(join(dir, 's2.json'));
    expect(await getAccessToken('nope', store)).toBeNull();
    store.set('mcp-oauth:srv', { access_token: 'tok', expires_at: Date.now() + 3_600_000 });
    expect(await getAccessToken('srv', store)).toBe('tok');
  });

  it('expired token without refresh material throws a clean re-auth error (never a browser)', async () => {
    const store = new SecretStore(join(dir, 's3.json'));
    store.set('mcp-oauth:stale', { access_token: 'tok', expires_at: Date.now() - 1000 });
    await expect(getAccessToken('stale', store)).rejects.toThrow(/re-run mcp-oauth-setup/);
  });
});
