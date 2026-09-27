import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocsReadTool } from '../../src/tools/docs.js';

describe('docs_read (OKF navigation)', () => {
  const v = mkdtempSync(join(tmpdir(), 'vault-read-'));
  mkdirSync(join(v, 'business'));
  writeFileSync(join(v, 'index.md'), '# vault\n\n* [business](business/index.md) - 1 concept(s)\n');
  writeFileSync(join(v, 'business', 'note.md'), '---\ntype: Note\n---\nthe note\n');
  const tool = createDocsReadTool(v);
  const ctx = {} as any;

  it('reads the root index and a concept by vault-relative path', async () => {
    expect(await tool.execute({ path: 'index.md' }, ctx)).toMatch(/\[business\]\(business\/index\.md\)/);
    expect(await tool.execute({ path: '/business/note.md' }, ctx)).toMatch(/the note/);
  });

  it('refuses paths outside the vault and explains a missing index', async () => {
    expect(await tool.execute({ path: '../../etc/passwd' }, ctx)).toMatch(/^Error: path must be inside/);
    expect(await tool.execute({ path: 'business/index.md' }, ctx)).toMatch(/no index yet/);
    expect(await tool.execute({ path: 'nope.md' }, ctx)).toMatch(/Domains: business/);
  });
});
