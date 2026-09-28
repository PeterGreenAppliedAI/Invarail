import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third review F05: a config that asks for the Docker sandbox and cannot get it must not run
// model-authored commands on the host instead. It boots WITHOUT exec and code sessions.
vi.mock('../../src/exec/docker-backend.js', async (orig) => {
  const mod = await orig<typeof import('../../src/exec/docker-backend.js')>();
  return { ...mod, DockerBackend: Object.assign(class extends mod.DockerBackend {}, { isAvailable: vi.fn().mockResolvedValue(false) }) };
});

describe('exec.security docker without Docker', () => {
  it('registers neither exec nor code_session, and says so', async () => {
    const { registerAllTools } = await import('../../src/tools/register-all.js');
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { loadConfig } = await import('../../src/config/loader.js');
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.tools = { ...(config.tools ?? {}), exec: { ...(config.tools?.exec ?? {}), security: 'docker' } } as typeof config.tools;
    config.agents = { default: 'main', list: [{ id: 'main', name: 'x', workspace: mkdtempSync(join(tmpdir(), 'ws-')) }], bindings: [] } as typeof config.agents;
    const errors: string[] = [];
    const orig = console.error; console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    const registry = new ToolRegistry();
    try { await registerAllTools(registry, config, {}); } finally { console.error = orig; }
    expect(registry.get('exec')).toBeUndefined();
    expect(registry.get('code_session')).toBeUndefined();
    expect(registry.get('read_file')).toBeDefined();   // workspace file ops are not code execution
    expect(errors.some(e => /NOT registered/.test(e))).toBe(true);
  });
});
