import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { selfModError } from '../errors.js';

/**
 * Self-modification worktree manager (Phase B). Pi implements changes to Invarail's OWN repo
 * here — always in an isolated git worktree on a self-mod/<slug> branch, never the running
 * tree, never main. One active worktree at a time (no chaining unvalidated changes).
 */

export interface ActiveWorktree {
  slug: string;
  branch: string;
  worktreePath: string;
  /** main HEAD at worktree creation — the gate diffs three-dot against this */
  baseSha: string;
  createdAt: string;
}

interface SelfModState {
  active?: ActiveWorktree;
}

export interface DeployMarker {
  prevSha: string;
  mergeSha: string;
  slug: string;
  ts: string;
}

const STALE_MARKER_MS = 15 * 60_000;

export class SelfModWorktrees {
  private readonly dataDir: string;
  private readonly worktreesDir: string;
  private readonly statePath: string;
  private readonly markerPath: string;

  constructor(private readonly repoRoot: string) {
    this.dataDir = join(repoRoot, 'data', 'self-mod');
    this.worktreesDir = join(this.dataDir, 'worktrees');
    this.statePath = join(this.dataDir, 'state.json');
    this.markerPath = join(this.dataDir, 'deploy.json');
  }

  private git(args: string[], cwd?: string): string {
    const r = spawnSync('git', args, { cwd: cwd ?? this.repoRoot, encoding: 'utf-8', timeout: 60_000 });
    if (r.status !== 0) {
      throw selfModError(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
    return r.stdout.trim();
  }

  getState(): SelfModState {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf-8')) as SelfModState;
    } catch {
      return {};
    }
  }

  private writeState(state: SelfModState): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  /** Tracked-file changes only — untracked files never block and are never committed. */
  hasTrackedChanges(): boolean {
    const out = this.git(['status', '--porcelain']);
    return out.split('\n').some(l => l.trim() && !l.startsWith('??'));
  }

  /** Commit tracked changes so the running tree has a clean, rollback-able SHA. */
  checkpointIfDirty(): string | null {
    if (!this.hasTrackedChanges()) return null;
    this.git(['add', '-u']);
    this.git(['commit', '-q', '-m', 'wip: pre-selfmod checkpoint']);
    return this.git(['rev-parse', 'HEAD']);
  }

  create(slug: string): ActiveWorktree {
    const state = this.getState();
    if (state.active) {
      throw selfModError(
        `a self-mod worktree is already active ("${state.active.slug}") — one change at a time; use abandon first`,
      );
    }
    this.checkpointIfDirty();
    const baseSha = this.git(['rev-parse', 'HEAD']);
    const branch = `self-mod/${slug}`;
    const worktreePath = join(this.worktreesDir, slug);
    mkdirSync(this.worktreesDir, { recursive: true });
    this.git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);

    // node_modules is gitignored — absent in a fresh worktree; tsc/vitest need it. Symlink from
    // main (safe while package-lock is unchanged; the gate forces real npm ci + Tier 3 when the
    // diff touches package files). data/ is gitignored too, and the routing-eval test reads
    // data/training cwd-relative — symlink just that allowlisted subdir, nothing else.
    const mainNodeModules = join(this.repoRoot, 'node_modules');
    const wtNodeModules = join(worktreePath, 'node_modules');
    if (existsSync(mainNodeModules) && !existsSync(wtNodeModules)) {
      symlinkSync(mainNodeModules, wtNodeModules, 'dir');
    }
    // data/ is gitignored EXCEPT tracked files (data/training/routing-eval.jsonl is committed),
    // so a fresh worktree may already have this path checked out — symlink only when absent.
    const mainTraining = join(this.repoRoot, 'data', 'training');
    const wtTraining = join(worktreePath, 'data', 'training');
    if (existsSync(mainTraining) && !existsSync(wtTraining)) {
      mkdirSync(join(worktreePath, 'data'), { recursive: true });
      symlinkSync(mainTraining, wtTraining, 'dir');
    }

    const active: ActiveWorktree = {
      slug,
      branch,
      worktreePath,
      baseSha,
      createdAt: new Date().toISOString(),
    };
    this.writeState({ active });
    return active;
  }

  remove(): void {
    const state = this.getState();
    if (!state.active) return;
    const { worktreePath, branch } = state.active;
    try {
      this.git(['worktree', 'remove', '--force', worktreePath]);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
      this.git(['branch', '-D', branch]);
    } catch { /* merged branches or already-gone branches are fine */ }
    try {
      this.git(['worktree', 'prune']);
    } catch { /* best-effort */ }
    this.writeState({});
  }

  /** Atomic (tmp + rename) — the supervisor reads this on exit-42. */
  writeDeployMarker(marker: DeployMarker): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.markerPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(marker, null, 2));
    renameSync(tmp, this.markerPath);
  }

  readDeployMarker(): DeployMarker | null {
    try {
      return JSON.parse(readFileSync(this.markerPath, 'utf-8')) as DeployMarker;
    } catch {
      return null;
    }
  }

  /**
   * Boot sweep: remove worktree dirs that aren't the active one (crashed runs), prune git's
   * bookkeeping, and delete stale deploy markers (not matching HEAD, or too old — a marker
   * that survived a supervisor cycle is garbage, never a pending instruction).
   */
  sweep(): string[] {
    const swept: string[] = [];
    const activeSlug = this.getState().active?.slug;
    try {
      for (const d of readdirSync(this.worktreesDir)) {
        if (d === activeSlug) continue;
        const p = join(this.worktreesDir, d);
        try {
          this.git(['worktree', 'remove', '--force', p]);
        } catch {
          rmSync(p, { recursive: true, force: true });
        }
        try {
          this.git(['branch', '-D', `self-mod/${d}`]);
        } catch { /* may not exist */ }
        swept.push(`worktree:${d}`);
      }
    } catch { /* no worktrees dir yet */ }
    try {
      this.git(['worktree', 'prune']);
    } catch { /* best-effort */ }

    const marker = this.readDeployMarker();
    if (marker) {
      const head = this.git(['rev-parse', 'HEAD']);
      const age = Date.now() - Date.parse(marker.ts);
      if (marker.mergeSha !== head || !(age < STALE_MARKER_MS)) {
        unlinkSync(this.markerPath);
        swept.push(`marker:${marker.slug}`);
      }
    }
    return swept;
  }

  resolveRepoRoot(): string {
    return resolve(this.repoRoot);
  }
}
