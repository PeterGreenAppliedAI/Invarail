import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspaceWriteTool } from '../../src/tools/workspace-write.js';
import type { ToolContext } from '../../src/tools/types.js';

const testDir = '/tmp/invarail-test-wswrite-' + Date.now();
const ctx = { workspacePath: testDir } as ToolContext;

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
});

describe('workspace_write', () => {
  it('still writes the operational files', async () => {
    const tool = createWorkspaceWriteTool();
    const out = await tool.execute({ file: 'TOOLS.md', content: '# Tools' }, ctx);
    expect(out).toBe('Updated TOOLS.md');
    expect(readFileSync(join(testDir, 'TOOLS.md'), 'utf-8')).toBe('# Tools');
  });

  // The authority inversion: the owner's identity card is theirs. The agent used
  // to be able to overwrite the whole file, which put identity one bad model
  // turn from erasure and created two stores of the same facts with no rule for
  // which wins.
  it('refuses USER.md and redirects to memory_save', async () => {
    const tool = createWorkspaceWriteTool();
    const out = await tool.execute({ file: 'USER.md', content: '# nope' }, ctx);
    expect(out).toMatch(/not writable/);
    expect(out).toMatch(/memory_save/);
    expect(existsSync(join(testDir, 'USER.md'))).toBe(false);
  });

  it('does not advertise USER.md as writable in its schema', () => {
    const tool = createWorkspaceWriteTool();
    const allowed = (tool.parameters?.properties?.file as { enum?: string[] })?.enum ?? [];
    expect(allowed).not.toContain('USER.md');
    expect(tool.description).toMatch(/memory_save/);
  });

  it('still refuses the other protected files', async () => {
    const tool = createWorkspaceWriteTool();
    for (const f of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'BOOTSTRAP.md']) {
      expect(await tool.execute({ file: f, content: 'x' }, ctx)).toMatch(/not writable/);
    }
  });

  it('still blocks path traversal', async () => {
    const tool = createWorkspaceWriteTool();
    // The enum check fires first for a non-listed name; use a listed name with traversal prefix.
    const out = await tool.execute({ file: '../TOOLS.md', content: 'x' }, ctx);
    expect(out).toMatch(/not writable|traversal/);
  });
});
