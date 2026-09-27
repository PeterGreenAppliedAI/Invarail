import { mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExecTool } from '../../src/tools/exec.js';
import type { ExecConfig } from '../../src/config/types.js';
import type { ToolContext } from '../../src/tools/types.js';

const config = { security: 'allowlist', allowlist: ['node'], timeout: 15000 } as unknown as ExecConfig;

describe('exec code param with RELATIVE workspacePath', () => {
  // Production workspacePath is relative (data/workspaces/main) — the live 2026-08-20
  // failure: tmp file joined against relative cwd, then passed as a relative arg to a
  // child already IN that cwd → double resolution → "can't open file".
  let wsAbs: string;
  let wsRel: string;

  beforeEach(() => {
    wsAbs = join(process.cwd(), 'data', 'exec-code-test-ws');
    wsRel = relative(process.cwd(), wsAbs);
    mkdirSync(wsAbs, { recursive: true });
  });
  afterEach(() => rmSync(wsAbs, { recursive: true, force: true }));

  it('runs inline code when workspacePath is relative', async () => {
    const tool = createExecTool(config, undefined);
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: wsRel } as ToolContext;
    const out = await tool.execute({ command: 'node', code: 'console.log(6765)' }, ctx);
    expect(out.trim()).toBe('6765');
  });

  it('accepts a whole command line in `command` (binary + args split, quotes kept)', async () => {
    const tool = createExecTool(config, undefined);
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: wsAbs } as ToolContext;
    const out = await tool.execute({ command: 'node -e "console.log(2+2)"' }, ctx);
    expect(out.trim()).toBe('4');
  });

  it('refuses shell operators with the reason, instead of a spawn ENOENT on the whole line', async () => {
    const tool = createExecTool(config, undefined);
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: wsAbs } as ToolContext;
    const out = await tool.execute({ command: 'node fib.js > fib.txt' }, ctx);
    expect(out).toMatch(/^Error: shell operators/);
    expect(out).toMatch(/write_file/);
    expect(out).not.toMatch(/ENOENT/);
  });

  it('still refuses a binary outside the allowlist when given as a command line', async () => {
    const tool = createExecTool(config, undefined);
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: wsAbs } as ToolContext;
    expect(await tool.execute({ command: 'rm -rf x' }, ctx)).toMatch(/not in the allowlist/);
  });

  it('runs inline code when workspacePath is absolute (unchanged behavior)', async () => {
    const tool = createExecTool(config, undefined);
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: wsAbs } as ToolContext;
    const out = await tool.execute({ command: 'node', code: 'console.log("ok-abs")' }, ctx);
    expect(out.trim()).toBe('ok-abs');
  });
});
