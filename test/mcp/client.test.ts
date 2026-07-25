import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { McpStdioClient } from '../../src/mcp/client.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.mjs');

function makeClient(args: string[] = [], timeoutMs = 2000): McpStdioClient {
  return new McpStdioClient({ name: 'fake', command: process.execPath, args: [FIXTURE, ...args], timeoutMs });
}

describe('McpStdioClient', () => {
  let client: McpStdioClient;
  afterEach(() => client?.close());

  it('completes the handshake and lists tools', async () => {
    client = makeClient();
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['get_info', 'mutate_thing']);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    expect(tools[1].inputSchema?.required).toEqual(['name']);
  });

  it('round-trips a tool call', async () => {
    client = makeClient();
    await client.connect();
    const result = await client.callTool('get_info', { detail: 'low' });
    expect(result.content[0].text).toBe('echo:{"detail":"low"}');
  });

  it('surfaces JSON-RPC errors as MCP_SERVER_ERROR', async () => {
    client = makeClient();
    await client.connect();
    await expect(client.callTool('rpc_error', {})).rejects.toThrow(/bad params/);
  });

  it('times out unanswered requests', async () => {
    client = makeClient([], 300);
    await client.connect();
    await expect(client.callTool('slow_op', {})).rejects.toThrow(/timed out after 300ms/);
  });

  it('ignores non-JSON stdout lines instead of crashing', async () => {
    client = makeClient(['--log-noise']);
    await client.connect();
    const result = await client.callTool('get_info', {});
    expect(result.content[0].text).toContain('echo:');
  });

  it('rejects in-flight requests when the server dies', async () => {
    client = makeClient(['--crash-after-init'], 5000);
    await client.connect();
    await new Promise(r => setTimeout(r, 200)); // let it crash
    expect(client.alive).toBe(false);
    await expect(client.callTool('get_info', {})).rejects.toThrow(/not running/);
  });

  it('close() rejects pending requests', async () => {
    client = makeClient([], 5000);
    await client.connect();
    const pending = client.callTool('slow_op', {});
    client.close();
    await expect(pending).rejects.toThrow(/client closed/);
  });
});
