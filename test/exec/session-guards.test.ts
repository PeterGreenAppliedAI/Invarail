import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { SessionManager } from '../../src/exec/session-manager.js';
import { createCodeSessionTool } from '../../src/tools/code-session.js';
import type { ToolContext } from '../../src/tools/types.js';

const cfg = { maxSessions: 4, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] as Array<'python' | 'node' | 'bash'> };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('F22 — a missing interpreter is a tool error, not a process crash', () => {
  let manager: SessionManager;
  afterEach(() => manager?.closeAll());

  it('spawn ENOENT after "started" removes the session and the next run explains why', async () => {
    manager = new SessionManager(cfg);
    const proc = spawn('definitely-not-a-binary-invarail-xyz', ['--norc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    expect(manager.startFromProcess('ghost', 'bash', proc)).toMatch(/started/);
    await wait(150);   // the 'error' event is asynchronous
    expect(manager.list()).toHaveLength(0);
    const out = await manager.run('ghost', 'echo hi');
    expect(out).toMatch(/not found — it failed to start: spawn definitely-not-a-binary-invarail-xyz ENOENT/);
  });
});

describe('F23 — output trimming never invalidates the command cursor', () => {
  let manager: SessionManager;
  afterEach(() => manager?.closeAll());

  it('a command after the buffer cap still returns its own output', async () => {
    manager = new SessionManager({ ...cfg, maxOutputBytes: 2000 });
    manager.start('big', 'bash');
    // blow past the cap several times over
    const flood = await manager.run('big', 'for i in $(seq 1 400); do echo "line-$i-xxxxxxxxxxxxxxxxxxxx"; done');
    expect(flood).toMatch(/line-400/);
    const after = await manager.run('big', 'echo AFTER_CAP_OK');
    expect(after).toBe('AFTER_CAP_OK');
    const again = await manager.run('big', 'echo SECOND_OK');
    expect(again).toBe('SECOND_OK');
  }, 20_000);
});

describe('F18 — a REPL belongs to the principal + agent that started it', () => {
  let manager: SessionManager;
  afterEach(() => manager?.closeAll());
  const owner = { agentId: 'main', sessionKey: 'o', senderId: 'peter' } as ToolContext;
  const guest = { agentId: 'main', sessionKey: 'g', senderId: 'guest' } as ToolContext;

  it('the same session name is a different session per principal; a guest cannot run, read, close or list the owner\'s', async () => {
    manager = new SessionManager(cfg);
    const tool = createCodeSessionTool(manager);
    expect(await tool.execute({ action: 'start', session: 'work', runtime: 'bash' }, owner)).toBe('Session "work" started (bash)');
    expect(await tool.execute({ action: 'run', session: 'work', code: 'SECRET=42; echo set' }, owner)).toBe('set');
    expect(await tool.execute({ action: 'run', session: 'work', code: 'echo $SECRET' }, guest)).toMatch(/^Error: Session "work" not found/);
    expect(await tool.execute({ action: 'output', session: 'work' }, guest)).toMatch(/not found/);
    expect(await tool.execute({ action: 'close', session: 'work' }, guest)).toMatch(/not found/);
    expect(await tool.execute({ action: 'list' }, guest)).toBe('No active sessions');
    expect(await tool.execute({ action: 'list' }, owner)).toMatch(/^- work \(bash/);
    expect(await tool.execute({ action: 'run', session: 'work', code: 'echo $SECRET' }, owner)).toBe('42');
    // the manager's real keys are scoped; the model never sees them
    expect(manager.list().map(s => s.id)).toEqual(['main/peter/work']);
  }, 20_000);
});
