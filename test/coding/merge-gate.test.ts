import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyTier, runMergeGate, PROTECTED_PATHS, type CheckRunner } from '../../src/coding/merge-gate.js';

describe('classifyTier', () => {
  it('protected paths are Tier 3', () => {
    for (const f of ['src/security/grants.ts', 'src/dispatch.ts', 'src/config/loader.ts', 'scripts/supervisor.sh', 'package-lock.json', '.env.local', '.github/workflows/ci.yml']) {
      expect(classifyTier([f]).tier, f).toBe(3);
    }
  });

  it('gate-config tampering is flagged and Tier 3', () => {
    for (const f of ['vitest.config.ts', 'tsconfig.json', 'package.json']) {
      const r = classifyTier([f]);
      expect(r.tier, f).toBe(3);
      expect(r.gateConfigTampered, f).toBe(true);
    }
    expect(classifyTier(['src/tools/web-search.ts']).gateConfigTampered).toBe(false);
  });

  it('config may extend but never shrink the built-ins', () => {
    const r = classifyTier(['src/memory/graph-store.ts'], ['src/memory/']);
    expect(r.tier).toBe(3);
    expect(r.protectedTouched).toContain('src/memory/graph-store.ts');
    // Built-ins hold regardless of what extras are passed — there is no removal input
    expect(classifyTier(['src/security/grants.ts'], []).tier).toBe(3);
    expect(PROTECTED_PATHS).toContain('src/security/');
  });

  it('ordinary code is Tier 2, docs-only Tier 0', () => {
    expect(classifyTier(['src/tools/web-search.ts', 'test/tools/x.test.ts']).tier).toBe(2);
    expect(classifyTier(['README.md', 'docs/guide.md']).tier).toBe(0);
    expect(classifyTier(['FEATURES.md']).tier).toBe(0);
  });
});

describe('runMergeGate', () => {
  let repo: string;
  let worktree: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gate-test-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    worktree = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'self-mod/x', worktree, 'HEAD');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const passingRunner: CheckRunner = vi.fn(async name => ({ name, pass: true, output: 'ok', durationMs: 1 }));

  function commitChange(file: string, content: string): string {
    const full = join(worktree, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', `change ${file}`);
    return git(repo, 'rev-parse', 'HEAD');
  }

  it('computes touched files three-dot from baseSha and passes on green checks', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    commitChange('src/feature.ts', 'export const f = 2;\n');
    const v = await runMergeGate({ worktreePath: worktree, baseSha, checkRunner: passingRunner });
    expect(v.touchedFiles).toEqual(['src/feature.ts']);
    expect(v.tier).toBe(2);
    expect(v.pass).toBe(true);
    expect(v.checks.map(c => c.name)).toEqual(['tsc', 'vitest']);
  });

  it('empty diff fails the gate (nothing to merge)', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    const v = await runMergeGate({ worktreePath: worktree, baseSha, checkRunner: passingRunner });
    expect(v.touchedFiles).toEqual([]);
    expect(v.pass).toBe(false);
  });

  it('failing check fails the gate and skips later checks', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    commitChange('src/broken.ts', 'nope\n');
    const failTsc: CheckRunner = async (name) =>
      name === 'tsc' ? { name, pass: false, output: 'TS2304', durationMs: 1 } : { name, pass: true, output: 'ok', durationMs: 1 };
    const v = await runMergeGate({ worktreePath: worktree, baseSha, checkRunner: failTsc });
    expect(v.pass).toBe(false);
    expect(v.checks.map(c => c.name)).toEqual(['tsc']);
  });

  it('forbidden files: a branch touching node_modules or data/ hard-fails before checks', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    commitChange('node_modules', 'i am a committed symlink artifact\n');
    const recorder: CheckRunner = vi.fn(async name => ({ name, pass: true, output: 'ok', durationMs: 1 }));
    const v = await runMergeGate({ worktreePath: worktree, baseSha, checkRunner: recorder });
    expect(v.pass).toBe(false);
    expect(v.checks[0].name).toBe('foreign-files');
    expect(v.checks[0].output).toContain('node_modules');
    expect(recorder).not.toHaveBeenCalled(); // fails before spending gate time
  });

  it('deps change: removes node_modules symlink, runs npm ci first, Tier 3', async () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(worktree, 'package.json'), '{"name":"x"}\n');
    git(worktree, 'add', 'package.json'); // explicit path — add -A would sweep the symlink (the forbidden-files case)
    git(worktree, 'commit', '-q', '-m', 'deps change');
    const calls: string[] = [];
    const recorder: CheckRunner = async (name) => { calls.push(name); return { name, pass: true, output: 'ok', durationMs: 1 }; };
    const v = await runMergeGate({ worktreePath: worktree, baseSha, checkRunner: recorder });
    expect(v.depsReinstalled).toBe(true);
    expect(v.tier).toBe(3);
    expect(v.gateConfigTampered).toBe(true);
    expect(calls[0]).toBe('npm-ci');
    expect(() => lstatSync(join(worktree, 'node_modules'))).toThrow(); // symlink removed
  });
});
