import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDocumentTool } from '../../src/tools/document.js';
import { InvarailError } from '../../src/errors.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Check if LibreOffice is available
let libreOfficeAvailable = false;
try {
  execSync('/opt/homebrew/bin/soffice --headless --version', { stdio: 'pipe' });
  libreOfficeAvailable = true;
} catch { /* not installed */ }

const tool = createDocumentTool();
const ctx = { agentId: 'test', sessionKey: 'test', workspacePath: 'test/_tmp_doc' };

describe('document tool', () => {
  beforeEach(() => {
    mkdirSync('data/media/documents', { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    for (const f of ['test_doc.pdf', 'test_doc_src.html', 'test_csv.xlsx', 'test_csv_src.csv']) {
      try { rmSync(join('data/media/documents', f)); } catch { /* ignore */ }
    }
  });

  it('has correct tool interface', () => {
    expect(tool.name).toBe('document');
    expect(tool.category).toBe('exec');
    expect(tool.parameters?.properties.action).toBeDefined();
    expect(tool.parameters?.properties.format).toBeDefined();
    expect(tool.parameters?.required).toContain('action');
    expect(tool.parameters?.required).toContain('format');
  });

  it('rejects unsupported formats', async () => {
    const result = await tool.execute({ action: 'create', content: 'test', format: 'zip' }, ctx);
    expect(result).toContain('Unsupported format');
  });

  it('requires content for create action', async () => {
    const result = await tool.execute({ action: 'create', format: 'pdf' }, ctx);
    expect(result).toContain('Missing "content"');
  });

  it('requires inputPath for convert action', async () => {
    const result = await tool.execute({ action: 'convert', format: 'pdf' }, ctx);
    expect(result).toContain('Missing "inputPath"');
  });

  it('reports file not found for convert', async () => {
    // Workspace-relative: an absolute path outside the workspace is now a policy refusal (F13)
    const result = await tool.execute({ action: 'convert', inputPath: 'nonexistent/file.html', format: 'pdf' }, ctx);
    expect(result).toContain('File not found');
  });

  it('rejects unknown actions', async () => {
    const result = await tool.execute({ action: 'delete', format: 'pdf' }, ctx);
    expect(result).toContain('Unknown action');
  });

  it.skipIf(!libreOfficeAvailable)('creates HTML → PDF', async () => {
    const result = await tool.execute({
      action: 'create',
      content: '<h1>Test</h1><p>Hello world</p>',
      format: 'pdf',
      filename: 'test_doc',
    }, ctx);

    expect(result).toContain('Document created');
    expect(result).toContain('[FILE:');
    expect(existsSync('data/media/documents/test_doc.pdf')).toBe(true);
  });

  it.skipIf(!libreOfficeAvailable)('creates CSV → XLSX', async () => {
    const result = await tool.execute({
      action: 'create',
      content: 'Name,Value\nAlpha,100\nBeta,200',
      format: 'xlsx',
      filename: 'test_csv',
    }, ctx);

    expect(result).toContain('Document created');
    expect(result).toContain('[FILE:');
    expect(existsSync('data/media/documents/test_csv.xlsx')).toBe(true);
  });

  it('creates same-format file without conversion', async () => {
    const result = await tool.execute({
      action: 'create',
      content: '<h1>Test</h1>',
      format: 'html',
      filename: 'test_html',
    }, ctx);

    expect(result).toContain('Document created');
    expect(existsSync('data/media/documents/test_html.html')).toBe(true);

    // Cleanup
    try { rmSync('data/media/documents/test_html.html'); } catch { /* ignore */ }
  });
});

describe('document tool conversion error logging', () => {
  // Inside ctx.workspacePath: convert only accepts inputs from the workspace, data/media
  // or data/uploads (review F13, 2026-09-27); absolute so the fake soffice path is too.
  const TMP_DIR = resolve('test', '_tmp_doc', '_errs');
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** Write an executable fake soffice that behaves per `body`. */
  function fakeSoffice(body: string): string {
    const binDir = join(TMP_DIR, 'bin');
    mkdirSync(binDir, { recursive: true });
    const p = join(binDir, `soffice-${Math.random().toString(36).slice(2)}`);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  /** Stub the soffice binary (document tool reads SOFFICE_PATH at call time). */
  function useSoffice(sofficePath: string) {
    vi.stubEnv('SOFFICE_PATH', sofficePath);
    return tool;
  }

  async function runConvert(input: string): Promise<unknown> {
    try {
      await tool.execute({ action: 'convert', inputPath: input, format: 'pdf' }, ctx);
      return undefined; // resolved — caller asserts failure
    } catch (err) {
      return err;
    }
  }

  function warnOutput(): string {
    return warnSpy.mock.calls.map(c => String(c[0])).join('\n');
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('throws CONVERSION_ERROR and logs input path + stderr when LibreOffice exits non-zero', async () => {
    useSoffice(fakeSoffice('echo "fake converter exploded" >&2\nexit 3'));
    const input = join(TMP_DIR, `input-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(input, 'hello');

    const err = await runConvert(input);

    expect(err).toBeInstanceOf(InvarailError);
    expect(err).toMatchObject({ code: 'CONVERSION_ERROR' });
    expect((err as Error).message).toContain(input);
    expect((err as Error).message).toContain('pdf');
    // Detailed log carries the input path and the converter's stderr/exit
    expect(warnOutput()).toContain(`input="${input}"`);
    expect(warnOutput()).toContain('fake converter exploded');
    expect(warnOutput()).toContain('exit=3');
  });

  it('logs input path when LibreOffice exits 0 but produces no output file', async () => {
    useSoffice(fakeSoffice('exit 0'));
    const input = join(TMP_DIR, `quiet-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(input, 'hello');

    const err = await runConvert(input);

    expect(err).toBeInstanceOf(InvarailError);
    expect(err).toMatchObject({ code: 'CONVERSION_ERROR' });
    expect((err as Error).message).toContain(input);
    expect(warnOutput()).toContain(`input="${input}"`);
    expect(warnOutput()).toContain('exited successfully');
  });

  it('logs spawn failure details when the soffice binary is missing', async () => {
    useSoffice(join(TMP_DIR, 'no-such-soffice'));
    const input = join(TMP_DIR, `missing-${Math.random().toString(36).slice(2)}.txt`);
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(input, 'hello');

    const err = await runConvert(input);

    expect(err).toBeInstanceOf(InvarailError);
    expect(err).toMatchObject({ code: 'CONVERSION_ERROR' });
    expect((err as Error).message).toContain(input);
    expect(warnOutput()).toContain(`input="${input}"`);
    // macOS sh says "No such file or directory"; Ubuntu dash (GitHub runners) says "not found".
    // Deterministic ENOENT needs execFile instead of a shell string (review F14).
    expect(warnOutput()).toMatch(/ENOENT|no such file|not found|spawn/i);
  });
});
