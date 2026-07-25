import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { McpManager } from '../../src/mcp/manager.js';
import { McpServerConfigSchema } from '../../src/config/schema.js';
import type { McpServerConfig } from '../../src/config/types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.mjs');

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return McpServerConfigSchema.parse({
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: 2000,
    ...overrides,
  });
}

describe('McpManager', () => {
  let manager: McpManager;
  afterEach(async () => manager?.stop());

  it('connects configured servers and builds prefixed tools', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const tools = manager.buildTools();
    expect(tools.map(t => t.name)).toEqual(['fake_get_info', 'fake_mutate_thing']);
    expect(tools.every(t => t.category === 'mcp:fake')).toBe(true);
  });

  it('a failing server is skipped without blocking others', async () => {
    manager = new McpManager([
      serverConfig({ name: 'broken', command: '/nonexistent/binary' }),
      serverConfig(),
    ]);
    await manager.start();
    const tools = manager.buildTools();
    expect(tools.map(t => t.name)).toEqual(['fake_get_info', 'fake_mutate_thing']);
  });

  it('disabled servers are not started', async () => {
    manager = new McpManager([serverConfig({ enabled: false })]);
    await manager.start();
    expect(manager.buildTools()).toEqual([]);
  });

  it('executes a tool end-to-end through the registry-facing execute()', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const tool = manager.buildTools().find(t => t.name === 'fake_get_info')!;
    const result = await tool.execute({ detail: 'high' }, {} as never);
    expect(result).toBe('echo:{"detail":"high"}');
  });

  it('maps isError results to model-visible Error strings', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const result = await manager.callTool('fake', 'boom', {});
    expect(result).toBe('Error: thing exploded');
  });

  it('returns an error string (not a throw) for unknown servers', async () => {
    manager = new McpManager([]);
    await manager.start();
    const result = await manager.callTool('ghost', 'x', {});
    expect(result).toContain('not connected');
  });

  it('lazily respawns a crashed server on the next call', async () => {
    manager = new McpManager([serverConfig({ args: [FIXTURE, '--crash-after-init'] })]);
    await manager.start();
    await new Promise(r => setTimeout(r, 200)); // let the child crash
    // Respawn also uses --crash-after-init, but the handshake + call complete
    // within its 50ms crash delay often enough to be flaky — instead verify the
    // respawn path by pointing the config at a healthy server before the call.
    const state = (manager as unknown as { servers: Map<string, { config: McpServerConfig }> }).servers.get('fake')!;
    state.config = serverConfig();
    const result = await manager.callTool('fake', 'get_info', {});
    expect(result).toContain('echo:');
  }, 15000);
});
