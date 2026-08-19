import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelfModService } from '../../src/coding/self-mod-service.js';
import { SelfModWorktrees } from '../../src/coding/self-mod.js';
import { runMergeGate, type CheckRunner } from '../../src/coding/merge-gate.js';
import type { PiCodingAdapter, PiSessionResult } from '../../src/coding/pi-session.js';
import { PendingActionStore } from '../../src/security/pending-actions.js';
import type { InvarailConfig } from '../../src/config/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'selfmod-svc-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const okSession: PiSessionResult = {
  ok: true, timedOut: false, sessionId: 's1', sessionFile: '/tmp/s1.jsonl',
  stats: { turns: 1, toolCalls: 1, toolErrors: 0, durationMs: 10 },
};

function fakeAdapter(impl: (cwd: string) => void, result: PiSessionResult = okSession): PiCodingAdapter {
  return {
    runSession: vi.fn(async (req: { cwd: string }) => { impl(req.cwd); return result; }),
  } as unknown as PiCodingAdapter;
}

const passingChecks: CheckRunner = async name => ({ name, pass: true, output: 'ok', durationMs: 1 });
const failingChecks: CheckRunner = async name => ({ name, pass: name !== 'vitest', output: name === 'vitest' ? '1 failed' : 'ok', durationMs: 1 });

function config(overrides: Partial<{ selfModEnabled: boolean; piEnabled: boolean }> = {}): InvarailConfig {
  return {
    selfMod: { enabled: overrides.selfModEnabled ?? true, protectedPathsExtra: [], gateTimeoutMs: 5000 },
    pi: { enabled: overrides.piEnabled ?? true, model: 'sglang/qwen3.8-27b', apiKey: 'x', tools: ['read'], timeout: 5000, maxFixIterations: 3, git: { commitLocal: true, pushRemote: false, visibility: 'private' } },
  } as unknown as InvarailConfig;
}

describe('SelfModService', () => {
  let repo: string;
  let pendingStore: PendingActionStore;
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = makeRepo();
    pendingStore = new PendingActionStore(join(repo, 'pending.json'));
    restart = vi.fn();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function makeService(opts: {
    adapter: PiCodingAdapter;
    checks?: CheckRunner;
    cfg?: InvarailConfig;
  }): SelfModService {
    return new SelfModService({
      config: opts.cfg ?? config(),
      repoRoot: repo,
      adapter: opts.adapter,
      pendingStore,
      onRestartRequested: restart,
      gateRunner: gateOpts => runMergeGate({ ...gateOpts, checkRunner: opts.checks ?? passingChecks }),
    });
  }

  function committingAdapter(file = 'src/new.ts'): PiCodingAdapter {
    return fakeAdapter(cwd => {
      mkdirSync(join(cwd, file, '..'), { recursive: true });
      writeFileSync(join(cwd, file), 'export const x = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'implement change');
    });
  }

  it('propose: green gate → pending self_merge action with gate-judged headSha', async () => {
    const svc = makeService({ adapter: committingAdapter() });
    const res = await svc.propose('add a widget', 'peter', 'discord');
    expect(res.ok).toBe(true);
    expect(res.pendingId).toBeTruthy();
    expect(res.reply).toContain('confirm ' + res.pendingId);
    const pending = pendingStore.findById(res.pendingId!, 'peter');
    expect(pending?.tool).toBe('self_merge');
    expect(pending?.params.slug).toBe(res.slug);
    expect(String(pending?.params.headSha)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('propose: failing gate → no pending action, worktree kept for inspection', async () => {
    const svc = makeService({ adapter: committingAdapter(), checks: failingChecks });
    const res = await svc.propose('break stuff', 'peter', 'discord');
    expect(res.ok).toBe(false);
    expect(res.reply).toContain('FAILED');
    expect(pendingStore.listFor('peter')).toHaveLength(0);
    expect(existsSync(join(repo, 'data', 'self-mod', 'worktrees'))).toBe(true);
    expect(svc.status()).toContain('Active self-mod');
  });

  it('propose: disabled selfMod or pi → refusal without side effects', async () => {
    const off = makeService({ adapter: committingAdapter(), cfg: config({ selfModEnabled: false }) });
    expect((await off.propose('x', 'peter', 'discord')).reply).toContain('disabled');
    const noPi = makeService({ adapter: committingAdapter(), cfg: config({ piEnabled: false }) });
    expect((await noPi.propose('x', 'peter', 'discord')).reply).toContain('Pi is disabled');
  });

  it('propose: uncommitted Pi output is auto-committed before the gate', async () => {
    const adapter = fakeAdapter(cwd => {
      writeFileSync(join(cwd, 'left-dirty.ts'), 'export const d = 1;\n'); // no commit
    });
    const svc = makeService({ adapter });
    const res = await svc.propose('leave it dirty', 'peter', 'discord');
    expect(res.ok).toBe(true);
    const wt = join(repo, 'data', 'self-mod', 'worktrees', res.slug!);
    expect(git(wt, 'log', '-1', '--format=%s')).toContain('auto-commit');
  });

  it('propose: Tier 3 protected paths produce a loud warning', async () => {
    const svc = makeService({ adapter: committingAdapter('src/security/grants.ts') });
    const res = await svc.propose('touch security', 'peter', 'discord');
    expect(res.ok).toBe(true);
    expect(res.reply).toContain('TIER 3');
    expect(res.reply).toContain('src/security/grants.ts');
  });

  it('executeMerge: merges to main, writes marker, cleans worktree, requests restart', async () => {
    const svc = makeService({ adapter: committingAdapter() });
    const res = await svc.propose('add a widget', 'peter', 'discord');
    const pending = pendingStore.findById(res.pendingId!, 'peter')!;
    const prevSha = git(repo, 'rev-parse', 'HEAD');

    const reply = await svc.executeMerge(pending.params);
    expect(reply).toContain('Merged');
    expect(existsSync(join(repo, 'src', 'new.ts'))).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`self-mod: ${res.slug}`);
    const marker = new SelfModWorktrees(repo).readDeployMarker()!;
    expect(marker.prevSha).toBe(prevSha);
    expect(marker.mergeSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(repo, 'data', 'self-mod', 'worktrees', res.slug!))).toBe(false);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('executeMerge: branch changed after the gate → refuses (verdict voided)', async () => {
    const svc = makeService({ adapter: committingAdapter() });
    const res = await svc.propose('add a widget', 'peter', 'discord');
    const pending = pendingStore.findById(res.pendingId!, 'peter')!;
    const wt = join(repo, 'data', 'self-mod', 'worktrees', res.slug!);
    writeFileSync(join(wt, 'sneaky.ts'), 'export const s = 1;\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'post-gate commit');

    await expect(svc.executeMerge(pending.params)).rejects.toThrow(/changed after the gate/);
    expect(restart).not.toHaveBeenCalled();
  });

  it('executeMerge: verified experience written, id lands IN THE MARKER (recovery state), turn precedes save', async () => {
    const calls: string[] = [];
    const experienceStore = {
      save: vi.fn(async () => { calls.push('save'); return { id: 'exp_123', action: 'created' as const }; }),
    };
    const graphMemory = {
      addTurn: vi.fn(async () => { calls.push('turn'); }),
    };
    const svc = new SelfModService({
      config: config(), repoRoot: repo, adapter: committingAdapter(), pendingStore,
      onRestartRequested: () => { calls.push('restart'); restart(); },
      gateRunner: gateOpts => runMergeGate({ ...gateOpts, checkRunner: passingChecks }),
      experienceStore: experienceStore as never, graphMemory: graphMemory as never,
    });
    const res = await svc.propose('add a widget', 'peter', 'discord');
    const pending = pendingStore.findById(res.pendingId!, 'peter')!;
    await svc.executeMerge(pending.params);

    expect(calls).toEqual(['turn', 'save', 'restart']); // turn first (provenance), save awaited BEFORE restart
    const marker = new SelfModWorktrees(repo).readDeployMarker()!;
    expect(marker.experienceId).toBe('exp_123');
    const saveArg = experienceStore.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saveArg.verified).toBe(true);
    expect(saveArg.outcome).toBe('worked');
    expect(saveArg.commit).toBe(marker.mergeSha);
    const turnArgs = graphMemory.addTurn.mock.calls[0] as unknown[];
    expect(turnArgs[1]).toBe('pi');
    expect((turnArgs[4] as Record<string, string>).source).toBe('pi');
    expect((turnArgs[4] as Record<string, string>).commit).toBe(marker.mergeSha);
  });

  it('executeMerge: memory down degrades — deploy proceeds, marker has no experienceId', async () => {
    const experienceStore = { save: vi.fn(async () => { throw new Error('falkor unreachable'); }) };
    const svc = new SelfModService({
      config: config(), repoRoot: repo, adapter: committingAdapter(), pendingStore,
      onRestartRequested: restart,
      gateRunner: gateOpts => runMergeGate({ ...gateOpts, checkRunner: passingChecks }),
      experienceStore: experienceStore as never,
    });
    const res = await svc.propose('add a widget', 'peter', 'discord');
    const pending = pendingStore.findById(res.pendingId!, 'peter')!;
    const reply = await svc.executeMerge(pending.params);
    expect(reply).toContain('Merged');
    expect(restart).toHaveBeenCalledOnce();
    expect(new SelfModWorktrees(repo).readDeployMarker()!.experienceId).toBeUndefined();
  });

  it('executeMerge: no active worktree → refuses', async () => {
    const svc = makeService({ adapter: committingAdapter() });
    await expect(svc.executeMerge({ slug: 'ghost', branch: 'self-mod/ghost', headSha: 'x' }))
      .rejects.toThrow(/no active worktree/);
  });
});
