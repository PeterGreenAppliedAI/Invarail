import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerBackend } from '../../src/exec/docker-backend.js';
import { registerAllTools } from '../../src/tools/register-all.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { loadConfig } from '../../src/config/loader.js';

// Third review F05: a config that asks for the Docker sandbox and cannot get it must not run
// model-authored commands on the host instead. It boots WITHOUT exec and code sessions.
// (A spy on the static method, not vi.mock: the module mock did not apply on Windows CI and
// the real `docker info` ran into the test timeout.)
describe('exec.security docker without Docker', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers neither exec nor code_session, and says so', async () => {
    vi.spyOn(DockerBackend, 'isAvailable').mockResolvedValue(false);
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
  }, 30_000);
});
