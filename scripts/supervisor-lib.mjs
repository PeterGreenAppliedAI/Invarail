/**
 * Invarail supervisor library — Node port of scripts/supervisor.sh, for machines without bash
 * (Windows) and for one implementation to keep. Same contract:
 *
 *   - boots `npx tsx src/index.ts`, health-checks /health (or process-alive when the web
 *     channel is off), restarts on crash with backoff, stops LOUD after 3 crashes in 5 min;
 *   - exit 42 = a deploy restart requested by the self-mod rail: reads the deploy marker,
 *     reinstalls when the lockfile changed, runs the gates (tsc + vitest), then boots with
 *     rollback ARMED — a failed health check resets to the previous sha;
 *   - rollback reinstalls dependencies when the restored lockfile differs, and HALTS with
 *     data/supervisor-halt.json (the doctor reads it; `npm start` blocks) when that install
 *     fails — never boots restored source on an unmatched dependency tree (third review N06).
 *
 *   node scripts/supervisor.mjs          INVARAIL_PORT overrides the health port (3100)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INVARAIL_PORT ?? 3100);
const MARKER = join(REPO, 'data', 'self-mod', 'deploy.json');
const FAILED_MARKER = join(REPO, 'data', 'self-mod', 'deploy-failed.json');
const FAILED = join(REPO, 'data', 'self-mod', 'FAILED');
export const HALT = join(REPO, 'data', 'supervisor-halt.json');
const WIN = process.platform === 'win32';

const log = (...a) => console.log(`[supervisor ${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Run a command to completion; returns { status, stdout }. `npm`/`npx` need a shell on Windows (.cmd). */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf-8', shell: WIN && /^(npm|npx)$/.test(cmd), env: opts.env ?? process.env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}
const git = (args, cwd = REPO) => run('git', args, { cwd, quiet: true }).stdout.trim();
const lockfileDiffers = (a, b, cwd = REPO) => run('git', ['diff', '--quiet', a, b, '--', 'package-lock.json'], { cwd, quiet: true }).status !== 0;

function markerField(name) {
  try { return String(JSON.parse(readFileSync(MARKER, 'utf-8'))[name] ?? ''); } catch { return ''; }
}

/**
 * Restore `sha`. Preserves the deploy marker as deploy-failed.json (the app's boot sweep
 * consumes it). Reinstalls when the lockfile changed; HALTS if that fails.
 * Returns true when the tree is restored and bootable; on halt it writes the marker and
 * returns false (the caller exits non-zero).
 */
export function rollback(sha, cwd = REPO, env = process.env) {
  log(`ROLLBACK: git reset --hard ${sha.slice(0, 8)}`);
  const marker = join(cwd, 'data', 'self-mod', 'deploy.json');
  if (existsSync(marker)) renameSync(marker, join(cwd, 'data', 'self-mod', 'deploy-failed.json'));
  const from = git(['rev-parse', 'HEAD'], cwd);
  run('git', ['reset', '--hard', sha], { cwd, quiet: true });
  if (lockfileDiffers(from, sha, cwd)) {
    log('rollback: lockfile differs — npm ci to match the restored source');
    const r = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd, env });
    if (r.status !== 0) {
      mkdirSync(join(cwd, 'data'), { recursive: true });
      writeFileSync(join(cwd, 'data', 'supervisor-halt.json'), JSON.stringify({ reason: 'npm ci failed during rollback — dependencies do not match the restored lockfile', sha: git(['rev-parse', 'HEAD'], cwd), at: new Date().toISOString() }) + '\n');
      log('rollback: npm ci FAILED — HALTING. data/supervisor-halt.json written; fix, verify, delete the marker, restart the supervisor');
      return false;
    }
  }
  return true;
}

const gatesOk = () => { log('gates: tsc + vitest'); return run('npx', ['tsc', '--noEmit']).status === 0 && run('npx', ['vitest', 'run']).status === 0; };

async function healthOk(child) {
  for (let i = 0; i < 30; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) }); if (res.ok) return true; } catch { /* not yet */ }
    if (child.exitCode !== null) return false;   // child died — definitely unhealthy
    await sleep(2000);
  }
  if (child.exitCode === null) { log('no /health but child alive — treating as healthy'); return true; }
  return false;
}

export async function main() {
  process.chdir(REPO);
  if (existsSync(HALT)) { log(`halt marker present (${HALT}) — refusing to start until it is removed`); process.exit(1); }
  let rollbackSha = '';   // non-empty = this boot is a deploy attempt
  let crashes = 0, windowStart = Date.now();
  let child = null;
  const stop = () => { if (child && child.exitCode === null) child.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  for (;;) {
    child = spawn(WIN ? 'npx.cmd' : 'npx', ['tsx', 'src/index.ts'], { stdio: 'inherit', shell: WIN });
    const exited = new Promise(r => child.on('exit', code => r(code ?? 1)));
    if (!(await healthOk(child))) {
      log('health check FAILED');
      if (child.exitCode === null) child.kill();
      await exited;
      if (rollbackSha) {
        const ok = rollback(rollbackSha); rollbackSha = '';
        if (!ok) process.exit(1);
        continue;   // boot the rolled-back tree once
      }
      mkdirSync(dirname(FAILED), { recursive: true }); writeFileSync(FAILED, new Date().toISOString() + '\n');
      log(`unhealthy with no rollback available — stopping LOUD (${FAILED})`); process.exit(1);
    }
    rollbackSha = '';   // healthy boot ends deploy mode
    const code = await exited;
    if (code === 0) { log('clean exit — stopping'); process.exit(0); }
    if (code === 42) {
      log('deploy restart requested');
      const prev = markerField('prevSha'), merge = markerField('mergeSha'), head = git(['rev-parse', 'HEAD']);
      if (!prev || merge !== head) { log(`marker missing/stale (merge=${merge} head=${head}) — plain restart`); try { renameSync(MARKER, FAILED_MARKER); } catch { /* absent */ } continue; }
      if (lockfileDiffers(prev, head)) { log('lockfile changed — npm ci'); if (run('npm', ['ci', '--no-audit', '--no-fund']).status !== 0) { if (!rollback(prev)) process.exit(1); continue; } }
      if (!gatesOk()) { if (!rollback(prev)) process.exit(1); continue; }
      rollbackSha = prev;   // next boot health-checks with rollback armed
      continue;
    }
    const now = Date.now();
    if (now - windowStart > 300_000) { crashes = 0; windowStart = now; }
    crashes++;
    if (crashes >= 3) { mkdirSync(dirname(FAILED), { recursive: true }); writeFileSync(FAILED, new Date().toISOString() + '\n'); log(`crash loop (3 in 5min) — stopping LOUD (${FAILED})`); process.exit(1); }
    log(`crash (exit ${code}) — restarting in ${crashes * 5}s`); await sleep(crashes * 5000);
  }
}

