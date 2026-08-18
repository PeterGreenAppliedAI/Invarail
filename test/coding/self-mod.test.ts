import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfModWorktrees } from '../../src/coding/self-mod.js';
import { InvarailError } from '../../src/errors.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'selfmod-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'v1\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndata/\n'); // mirrors the real repo's dir patterns
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'data', 'training'), { recursive: true });
  writeFileSync(join(dir, 'data', 'training', 'pairs.jsonl'), '{}\n');
  git(dir, 'add', 'file.txt', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('SelfModWorktrees', () => {
  let repo: string;
  let wt: SelfModWorktrees;

  beforeEach(() => {
    repo = makeRepo();
    wt = new SelfModWorktrees(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('creates a worktree on a self-mod branch with COPIED node_modules and symlinked data/training', () => {
    writeFileSync(join(repo, 'node_modules', 'probe.txt'), 'dep\n');
    const active = wt.create('add-widget');
    expect(active.branch).toBe('self-mod/add-widget');
    expect(active.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(active.worktreePath, 'file.txt'))).toBe(true);
    // node_modules must be a real copy — symlinks break tsc realpath resolution (TS2742)
    // and evade .gitignore's dir-only "node_modules/" pattern
    expect(lstatSync(join(active.worktreePath, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(active.worktreePath, 'node_modules', 'probe.txt'))).toBe(true);
    expect(lstatSync(join(active.worktreePath, 'data', 'training')).isSymbolicLink()).toBe(true);
    expect(git(active.worktreePath, 'branch', '--show-current')).toBe('self-mod/add-widget');
    expect(wt.getState().active?.slug).toBe('add-widget');
    expect(git(active.worktreePath, 'status', '--porcelain')).not.toContain('node_modules');
  });

  it('creates a worktree when data/training is TRACKED (checked out, not symlinked)', () => {
    // Regression: data/ is gitignored EXCEPT data/training/routing-eval.jsonl which is
    // committed — a fresh worktree checks it out and the symlink must not EEXIST-crash.
    git(repo, 'add', '-f', 'data/training/pairs.jsonl');
    git(repo, 'commit', '-q', '-m', 'track training data');
    const active = wt.create('tracked-training');
    expect(existsSync(join(active.worktreePath, 'data', 'training', 'pairs.jsonl'))).toBe(true);
    expect(lstatSync(join(active.worktreePath, 'data', 'training')).isSymbolicLink()).toBe(false);
    expect(wt.getState().active?.slug).toBe('tracked-training');
  });

  it('enforces one active worktree at a time', () => {
    wt.create('first');
    expect(() => wt.create('second')).toThrow(InvarailError);
    try {
      wt.create('second');
    } catch (err) {
      expect((err as InvarailError).code).toBe('SELF_MOD_ERROR');
      expect((err as InvarailError).message).toContain('first');
    }
  });

  it('checkpoints tracked changes before creating (dirty running tree)', () => {
    writeFileSync(join(repo, 'file.txt'), 'v2 dirty\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const active = wt.create('checkpointed');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(head).not.toBe(before);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('wip: pre-selfmod checkpoint');
    expect(active.baseSha).toBe(head);
    expect(git(repo, 'status', '--porcelain').split('\n').filter(l => l.trim() && !l.startsWith('??'))).toHaveLength(0);
  });

  it('does not checkpoint untracked files', () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    wt.create('untouched');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  });

  it('remove tears down worktree, branch, and state', () => {
    const active = wt.create('doomed');
    wt.remove();
    expect(existsSync(active.worktreePath)).toBe(false);
    expect(() => git(repo, 'rev-parse', '--verify', 'self-mod/doomed')).toThrow();
    expect(wt.getState().active).toBeUndefined();
  });

  it('sweep removes orphaned worktrees but keeps the active one', () => {
    wt.create('keeper');
    // Orphan: a directory in worktrees/ not tracked by state (simulates a crashed run)
    mkdirSync(join(repo, 'data', 'self-mod', 'worktrees', 'orphan'), { recursive: true });
    const swept = wt.sweep();
    expect(swept).toContain('worktree:orphan');
    expect(existsSync(join(repo, 'data', 'self-mod', 'worktrees', 'orphan'))).toBe(false);
    expect(existsSync(join(repo, 'data', 'self-mod', 'worktrees', 'keeper'))).toBe(true);
  });

  it('deploy marker: atomic write, read back, swept when not matching HEAD', () => {
    wt.writeDeployMarker({ prevSha: 'aaa', mergeSha: 'not-head', slug: 's', ts: new Date().toISOString() });
    expect(wt.readDeployMarker()?.mergeSha).toBe('not-head');
    const swept = wt.sweep();
    expect(swept).toContain('marker:s');
    expect(wt.readDeployMarker()).toBeNull();
  });

  it('deploy marker matching HEAD and fresh survives sweep', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    wt.writeDeployMarker({ prevSha: 'aaa', mergeSha: head, slug: 's', ts: new Date().toISOString() });
    wt.sweep();
    expect(wt.readDeployMarker()?.mergeSha).toBe(head);
  });

  it('stale marker (old ts) is swept even when matching HEAD', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    wt.writeDeployMarker({ prevSha: 'aaa', mergeSha: head, slug: 'old', ts: new Date(Date.now() - 20 * 60_000).toISOString() });
    const swept = wt.sweep();
    expect(swept).toContain('marker:old');
  });
});
