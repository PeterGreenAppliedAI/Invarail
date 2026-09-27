import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createMemoryGetTool } from '../../src/tools/memory-get.js';
import { createDocumentTool } from '../../src/tools/document.js';

const ctxFor = (workspacePath: string, agentId = 'main') => ({ agentId, sessionKey: 's', workspacePath } as any);

describe('write_file protected-file check runs on the canonical path (review F12)', () => {
  it('SOUL.md/. cannot overwrite SOUL.md', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(ws, 'SOUL.md'), 'persona');
    const tool = createWriteFileTool();
    const out = await tool.execute({ path: 'SOUL.md/.', content: 'pwned' }, ctxFor(ws));
    expect(out).toMatch(/protected/);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('persona');
  });
  it('ordinary writes still land, traversal still refused', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wf-'));
    const tool = createWriteFileTool();
    expect(await tool.execute({ path: 'notes/a.md', content: 'hi' }, ctxFor(ws))).toMatch(/Written/);
    expect(existsSync(join(ws, 'notes', 'a.md'))).toBe(true);
    expect(await tool.execute({ path: '../escape.md', content: 'hi' }, ctxFor(ws))).toMatch(/traversal/i);
  });
});

describe('memory_get containment + active workspace (review F16)', () => {
  const base = mkdtempSync(join(tmpdir(), 'mg-'));
  const main = join(base, 'main'); const main2 = join(base, 'main2'); const other = join(base, 'other');
  for (const d of [main, main2, other]) mkdirSync(d, { recursive: true });
  writeFileSync(join(main, 'MEMORY.md'), 'main memory');
  writeFileSync(join(main2, 'sentinel.txt'), 'sibling');
  writeFileSync(join(other, 'MEMORY.md'), 'other memory');
  const tool = createMemoryGetTool(main);
  it('rejects the sibling-prefix escape', async () => {
    expect(await tool.execute({ file: '../main2/sentinel.txt' }, ctxFor(main))).toMatch(/traversal/i);
  });
  it('reads from the dispatching agent\'s workspace, not the registration-time one', async () => {
    expect(await tool.execute({ file: 'MEMORY.md' }, ctxFor(other, 'other'))).toBe('other memory');
    expect(await tool.execute({ file: 'MEMORY.md' }, ctxFor(main))).toBe('main memory');
  });
});

describe('document tool filename and convert-input policy (review F13/F14)', () => {
  const tool = createDocumentTool();
  const ws = mkdtempSync(join(tmpdir(), 'doc-ws-'));
  it('rejects a traversing or shell-significant filename before touching disk', async () => {
    for (const filename of ['../../escaped', 'a/b', 'x$(echo hi)', 'x`id`']) {
      const out = await tool.execute({ action: 'create', format: 'txt', content: 'hello', filename }, ctxFor(ws));
      expect(out, filename).toMatch(/plain name/);
    }
  });
  it('refuses to convert a file from outside the workspace/media/uploads', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'doc-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    const out = await tool.execute({ action: 'convert', format: 'pdf', inputPath: join(outside, 'secret.txt') }, ctxFor(ws));
    expect(out).toMatch(/must be inside/);
  });
});
