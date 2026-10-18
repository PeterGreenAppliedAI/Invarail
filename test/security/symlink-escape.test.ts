import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, containedPath } from '../../src/security/paths.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import type { ToolContext } from '../../src/tools/types.js';

// Third review T01: a DANGLING symlink read as "absent" through existsSync, so the walk skipped
// it, rebuilt a path inside the workspace, and writeFileSync followed the link OUT.
describe('dangling symlinks and workspace containment', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'symlink-')));
  const ws = join(base, 'workspace'); mkdirSync(ws);
  const outside = join(base, 'outside'); mkdirSync(outside);
  symlinkSync(join(outside, 'not-yet.txt'), join(ws, 'alias.txt'));          // → outside, target absent
  symlinkSync(join(ws, 'inner-target.txt'), join(ws, 'inner-alias.txt'));    // → inside, target absent

  it('canonicalPath resolves a dangling link to its destination', () => {
    expect(canonicalPath(join(ws, 'alias.txt'))).toBe(join(outside, 'not-yet.txt'));
    expect(canonicalPath(join(ws, 'inner-alias.txt'))).toBe(join(ws, 'inner-target.txt'));
  });

  it('containment judges the destination: outside → null, inside → allowed', () => {
    expect(containedPath(ws, 'alias.txt')).toBeNull();
    expect(containedPath(ws, 'inner-alias.txt')).toBe(join(ws, 'inner-target.txt'));
  });

  it('write_file refuses the outside link and nothing lands outside; the inside link still works', async () => {
    const tool = createWriteFileTool();
    const ctx = { agentId: 't', sessionKey: 't', workspacePath: ws } as ToolContext;
    const out = await tool.execute({ path: 'alias.txt', content: 'DUMMY_SYMLINK_WRITE' }, ctx);
    expect(out).toMatch(/^Error/);
    expect(existsSync(join(outside, 'not-yet.txt'))).toBe(false);
    const ok = await tool.execute({ path: 'inner-alias.txt', content: 'fine' }, ctx);
    expect(ok).not.toMatch(/^Error/);
    expect(readFileSync(join(ws, 'inner-target.txt'), 'utf-8')).toBe('fine');
  });
});

// 2026-10-18: read_file checked the path lexically, so a symlink inside the workspace pointing at
// an EXISTING file outside it was read. It now goes through containedPath like write_file.
describe('read_file follows the shared canonical containment', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'symlink-read-')));
  const ws = join(base, 'workspace'); mkdirSync(ws);
  const outside = join(base, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'DUMMY_OUTSIDE_SECRET');
  writeFileSync(join(ws, 'real.txt'), 'inside');
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'leak.txt'));    // → existing file outside
  symlinkSync(join(ws, 'real.txt'), join(ws, 'inner.txt'));          // → inside
  const ctx = { agentId: 't', sessionKey: 't', workspacePath: ws } as ToolContext;

  it('refuses a link that points outside, without reading it', async () => {
    const out = await createReadFileTool().execute({ path: 'leak.txt' }, ctx);
    expect(out).toMatch(/^Error/);
    expect(out).not.toContain('DUMMY_OUTSIDE_SECRET');
  });

  it('still refuses plain traversal and reads ordinary and inside-linked files', async () => {
    const tool = createReadFileTool();
    expect(await tool.execute({ path: '../outside/secret.txt' }, ctx)).toMatch(/^Error/);
    expect(await tool.execute({ path: 'real.txt' }, ctx)).toBe('inside');
    expect(await tool.execute({ path: 'inner.txt' }, ctx)).toBe('inside');
  });
});
