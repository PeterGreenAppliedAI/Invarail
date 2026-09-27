import { spawn } from 'node:child_process';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Deterministic merge gate (Phase B). ALWAYS runs from the main tree's code with cwd pointed
 * at the worktree — Pi must never author the gate that judges its own work. Green checks are
 * necessary, not sufficient: the tier + touched-file list are what the owner actually reviews.
 */

export interface GateCheck {
  name: string;
  pass: boolean;
  output: string;
  durationMs: number;
}

export type GateTier = 0 | 1 | 2 | 3;

export interface GateVerdict {
  pass: boolean;
  tier: GateTier;
  touchedFiles: string[];
  protectedTouched: string[];
  /** Diff touches the files the gate itself depends on (test/build config, CI, deps) */
  gateConfigTampered: boolean;
  depsReinstalled: boolean;
  checks: GateCheck[];
  baseSha: string;
  headSha: string;
  durationMs: number;
}

/**
 * Built-in Tier-3 protected paths — owner-confirmed merges FOREVER, no promotion path.
 * Config (`selfMod.protectedPathsExtra`) may EXTEND this list, never shrink it: the clamp is
 * structural (extras are unioned; built-ins are a const the config never touches).
 */
export const PROTECTED_PATHS: readonly string[] = [
  'src/security/',
  'src/dispatch.ts',
  'src/config/loader.ts',
  'src/config/schema.ts',
  'src/coding/self-mod.ts',
  'src/coding/merge-gate.ts',
  'src/coding/improvement-proposals.ts',   // shapes what enters the ladder — never self-modifiable below Tier 3
  'src/tools/self-merge.ts',
  'src/tools/self-improve.ts',
  'scripts/supervisor.sh',
  '.github/',
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'tsconfig.json',
  '.env',
];

/** The subset whose modification undermines the gate's own verdict. */
const GATE_CONFIG_PATHS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'tsconfig.json',
  '.github/',
];

function matches(file: string, pattern: string): boolean {
  return pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern || file.startsWith(pattern + '/') || (pattern === '.env' && file.startsWith('.env'));
}

export function classifyTier(
  touchedFiles: string[],
  protectedPathsExtra: string[] = [],
): { tier: GateTier; protectedTouched: string[]; gateConfigTampered: boolean } {
  const allProtected = [...PROTECTED_PATHS, ...protectedPathsExtra];
  const protectedTouched = touchedFiles.filter(f => allProtected.some(p => matches(f, p)));
  const gateConfigTampered = touchedFiles.some(f => GATE_CONFIG_PATHS.some(p => matches(f, p)));
  if (protectedTouched.length > 0) return { tier: 3, protectedTouched, gateConfigTampered };
  const code = touchedFiles.some(f => f.startsWith('src/') || f.startsWith('test/') || f.startsWith('scripts/'));
  if (code) return { tier: 2, protectedTouched, gateConfigTampered };
  const docsOnly = touchedFiles.every(f => f.endsWith('.md') || f.startsWith('docs/'));
  return { tier: docsOnly ? 0 : 1, protectedTouched, gateConfigTampered };
}

export type CheckRunner = (
  name: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<GateCheck>;

/**
 * Checks run with a SCRUBBED env — .env never enters the worktree and vitest executes
 * Pi-authored code, so secrets stay out of reach. VITEST=1 keeps metrics writes suppressed.
 */
export const runCheck: CheckRunner = (name, command, args, cwd, timeoutMs) =>
  new Promise(resolveCheck => {
    const start = Date.now();
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'test',
      VITEST: '1',
      CI: '1',
    };
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const CAP = 200_000;
    child.stdout.on('data', d => { if (out.length < CAP) out += d.toString(); });
    child.stderr.on('data', d => { if (out.length < CAP) out += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolveCheck({ name, pass: code === 0, output: out.slice(-10_000), durationMs: Date.now() - start });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolveCheck({ name, pass: false, output: String(err), durationMs: Date.now() - start });
    });
  });

export interface MergeGateOptions {
  worktreePath: string;
  baseSha: string;
  protectedPathsExtra?: string[];
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real scrubbed-env runner */
  checkRunner?: CheckRunner;
  /** The main repository root. When set, tsc and vitest are invoked from ITS
   *  node_modules with the worktree as project/root — never from the worktree's own
   *  copied node_modules, which the coding session can edit (re-review N02, 2026-09-27). */
  repoRoot?: string;
}

export async function runMergeGate(opts: MergeGateOptions): Promise<GateVerdict> {
  const start = Date.now();
  const run = opts.checkRunner ?? runCheck;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const gitOut = (...args: string[]): string =>
    execFileSync('git', args, { cwd: opts.worktreePath, encoding: 'utf-8' }).trim();
  const headSha = gitOut('rev-parse', 'HEAD');
  const touchedFiles = gitOut('diff', '--name-only', `${opts.baseSha}...HEAD`)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const { tier, protectedTouched, gateConfigTampered } = classifyTier(
    touchedFiles,
    opts.protectedPathsExtra ?? [],
  );

  const checks: GateCheck[] = [];
  let depsReinstalled = false;

  // Foreign objects: arena artifacts (node_modules copy) and runtime data must never enter a
  // merge, no matter how they got committed. Hard fail before spending gate time.
  const forbidden = touchedFiles.filter(f => f === 'node_modules' || f.startsWith('node_modules/') || f.startsWith('data/'));
  if (forbidden.length > 0) {
    checks.push({ name: 'foreign-files', pass: false, output: `branch touches arena/runtime paths: ${forbidden.slice(0, 10).join(', ')}`, durationMs: 0 });
    return {
      pass: false, tier, touchedFiles, protectedTouched, gateConfigTampered,
      depsReinstalled, checks, baseSha: opts.baseSha, headSha, durationMs: Date.now() - start,
    };
  }

  // Dependency changes invalidate the node_modules symlink AND must never install through it
  // (that would mutate the main tree's deps from inside the arena) — real, isolated npm ci.
  const depsTouched = touchedFiles.some(f => f === 'package.json' || f === 'package-lock.json');
  if (depsTouched) {
    const nm = join(opts.worktreePath, 'node_modules');
    if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) unlinkSync(nm);
    checks.push(await run('npm-ci', 'npm', ['ci', '--no-audit', '--no-fund'], opts.worktreePath, timeoutMs));
    depsReinstalled = true;
  }

  const trusted = opts.repoRoot && !depsReinstalled ? resolve(opts.repoRoot, 'node_modules') : null;
  if (checks.every(c => c.pass)) {
    checks.push(trusted
      ? await run('tsc', process.execPath, [join(trusted, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', opts.worktreePath], opts.worktreePath, timeoutMs)
      : await run('tsc', 'npx', ['tsc', '--noEmit'], opts.worktreePath, timeoutMs));
  }
  if (checks.every(c => c.pass)) {
    checks.push(trusted
      ? await run('vitest', process.execPath, [join(trusted, 'vitest', 'vitest.mjs'), 'run', '--root', opts.worktreePath], opts.worktreePath, timeoutMs)
      : await run('vitest', 'npx', ['vitest', 'run'], opts.worktreePath, timeoutMs));
  }

  return {
    pass: checks.length > 0 && checks.every(c => c.pass) && touchedFiles.length > 0,
    tier,
    touchedFiles,
    protectedTouched,
    gateConfigTampered,
    depsReinstalled,
    checks,
    baseSha: opts.baseSha,
    headSha,
    durationMs: Date.now() - start,
  };
}
