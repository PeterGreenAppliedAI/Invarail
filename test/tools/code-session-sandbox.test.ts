import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { SessionManager } from '../../src/exec/session-manager.js';
import { createCodeSessionTool } from '../../src/tools/code-session.js';

// F05/F06: with exec security = docker, a code session must run INSIDE the sandbox, never on
// the host — and it must fail closed when the sandbox cannot start.
describe('code_session in the sandbox', () => {
  let manager: SessionManager;
  afterEach(() => manager?.closeAll());
  const cfg = { maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] as Array<'python' | 'node' | 'bash'> };

  it('starts the REPL through the sandbox, not spawn() on the host', async () => {
    manager = new SessionManager(cfg);
    const hostStart = vi.spyOn(manager, 'start');
    const sandbox = { ensureRunning: vi.fn().mockResolvedValue(undefined), spawnSession: vi.fn().mockImplementation(() => spawn('bash', ['--norc'], { stdio: ['pipe', 'pipe', 'pipe'] })) };
    const tool = createCodeSessionTool(manager, sandbox);
    const out = await tool.execute({ action: 'start', session: 's1', runtime: 'bash' }, {} as any);
    expect(out).toMatch(/started/);
    expect(sandbox.ensureRunning).toHaveBeenCalledOnce();
    expect(sandbox.spawnSession).toHaveBeenCalledWith('bash');
    expect(hostStart).not.toHaveBeenCalled();
    expect(tool.description).toMatch(/inside the Docker sandbox/);
  });

  it('fails closed when the sandbox cannot start — no host fallback', async () => {
    manager = new SessionManager(cfg);
    const sandbox = { ensureRunning: vi.fn().mockRejectedValue(new Error('docker daemon down')), spawnSession: vi.fn() };
    const tool = createCodeSessionTool(manager, sandbox);
    const out = await tool.execute({ action: 'start', session: 's1', runtime: 'python' }, {} as any);
    expect(out).toMatch(/^Error: sandbox unavailable/);
    expect(sandbox.spawnSession).not.toHaveBeenCalled();
    expect(manager.list()).toHaveLength(0);
  });

  it('the runtime allowlist applies to sandboxed sessions too, and the spawned process is killed', () => {
    manager = new SessionManager({ ...cfg, allowedRuntimes: ['python'] });
    const proc = spawn('bash', ['--norc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = vi.spyOn(proc, 'kill');
    expect(manager.startFromProcess('x', 'bash', proc)).toMatch(/not allowed/);
    expect(kill).toHaveBeenCalled();
    expect(manager.list()).toHaveLength(0);
  });

  it('without a sandbox the host path is unchanged', async () => {
    manager = new SessionManager(cfg);
    const tool = createCodeSessionTool(manager);
    expect(await tool.execute({ action: 'start', session: 'h', runtime: 'bash' }, {} as any)).toMatch(/started/);
    expect(tool.description).not.toMatch(/sandbox/);
  });
});
