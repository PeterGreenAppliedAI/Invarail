import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiBuildTool } from '../../src/tools/pi-build.js';
import type { PiCodingAdapter, PiSessionRequest, PiSessionResult } from '../../src/coding/pi-session.js';
import { PiConfigSchema } from '../../src/config/schema.js';
import type { ToolContext } from '../../src/tools/types.js';

function fakeAdapter(impl: (req: PiSessionRequest) => Promise<PiSessionResult>): PiCodingAdapter {
  return { runSession: vi.fn(impl) } as unknown as PiCodingAdapter;
}

function okResult(overrides: Partial<PiSessionResult> = {}): PiSessionResult {
  return {
    ok: true,
    timedOut: false,
    sessionId: 'sess-1',
    sessionFile: '/tmp/sess-1.jsonl',
    stats: { turns: 2, toolCalls: 3, toolErrors: 0, durationMs: 1000 },
    ...overrides,
  };
}

describe('pi_build tool (adapter-driven)', () => {
  let workspace: string;
  let ctx: ToolContext;
  const config = PiConfigSchema.parse({ model: 'sglang/qwen3.8-27b' });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pi-build-test-'));
    ctx = { workspacePath: workspace } as ToolContext;
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('keeps the extractor contract: Project directory + session lines, quality standards appended', async () => {
    const adapter = fakeAdapter(async req => {
      writeFileSync(join(req.cwd, 'main.py'), 'print("hi")\n');
      return okResult();
    });
    const tool = createPiBuildTool(config, adapter);
    const out = await tool.execute({ prompt: 'build a thing', projectName: 'My App' }, ctx);

    const projectDir = join(workspace, 'builds', 'my-app');
    expect(out).toContain(`Project directory: ${projectDir}`);
    expect(out).toContain('session: my-app');
    expect(out).toContain('main.py');

    const req = (adapter.runSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as PiSessionRequest;
    expect(req.cwd).toBe(projectDir);
    expect(req.label).toBe('my-app');
    expect(req.prompt).toContain('build a thing');
    expect(req.prompt).toContain('QUALITY STANDARDS');
  });

  it('fix mode reuses the given dir and does NOT append quality standards', async () => {
    const projectDir = join(workspace, 'builds', 'existing');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'app.py'), 'x = 1\n');
    const adapter = fakeAdapter(async () => okResult());
    const tool = createPiBuildTool(config, adapter);

    const out = await tool.execute({ prompt: 'fix the bug', projectDir }, ctx);
    // The printed path may be the given one or its canonical form (Windows tmp is an 8.3 short
    // name; macOS tmp is a symlink) — same directory either way.
    const printed = out.match(/Project directory: (.+)/)?.[1]?.trim();
    expect(printed && realpathSync(printed)).toBe(realpathSync(projectDir));
    expect(out).toContain('session: existing');
    const req = (adapter.runSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as PiSessionRequest;
    expect(req.prompt).toBe('fix the bug');
    expect(req.prompt).not.toContain('QUALITY STANDARDS');
  });

  it('failure with no files written surfaces the error, still with extractor lines', async () => {
    const adapter = fakeAdapter(async () =>
      okResult({ ok: false, error: 'backend unreachable' }),
    );
    const tool = createPiBuildTool(config, adapter);
    const out = await tool.execute({ prompt: 'build', projectName: 'dead' }, ctx);

    expect(out).toContain('Pi build failed');
    expect(out).toContain('backend unreachable');
    expect(out).toContain(`Project directory: ${join(workspace, 'builds', 'dead')}`);
    expect(out).toContain('session: dead');
  });

  it('failure WITH files written is treated as success (partial-progress semantics)', async () => {
    const adapter = fakeAdapter(async req => {
      writeFileSync(join(req.cwd, 'half.py'), 'partial\n');
      return okResult({ ok: false, timedOut: true });
    });
    const tool = createPiBuildTool(config, adapter);
    const out = await tool.execute({ prompt: 'build', projectName: 'partial' }, ctx);
    expect(out).toContain('Pi build complete');
    expect(out).toContain('half.py');
  });

  it('adapter throw (e.g. CONFIG_INVALID) is caught and returned as a failure string', async () => {
    const adapter = fakeAdapter(async () => { throw new Error('pi model "x" not found'); });
    const tool = createPiBuildTool(config, adapter);
    const out = await tool.execute({ prompt: 'build', projectName: 'boom' }, ctx);
    expect(out).toContain('Pi build failed');
    expect(out).toContain('not found');
    expect(out).toContain('session: boom');
  });
});
