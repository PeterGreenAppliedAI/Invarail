/**
 * Pi duel — two models drive the SAME autonomous coding agent (Pi/picoder)
 * on the SAME real ticket in isolated workspaces. This is the robust test:
 * planning, multi-file coherence, running tests, reading tracebacks,
 * self-repair, knowing when done — a full engineering session, not a completion.
 *
 * Scoring (separate --score pass, local):
 *   - hidden acceptance suite (12 checks, validated against a reference impl)
 *   - their own unittest suite: does it run, does it pass
 *   - telemetry: wall clock, files created
 *
 * Usage: npx tsx scripts/pi-duel.ts            (run sessions — lab tmux, LAN)
 *        npx tsx scripts/pi-duel.ts --score    (Docker scoring, local)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DUEL_DIR = 'data/model-eval/pi-duel-2026-08-15';
const CONTESTANTS = [
  { id: 'deepseek', model: 'vllm/deepseek-v4-flash' },
  { id: 'qwen38', model: 'gateway/qwen3.8:27b' },
];
const SESSION_TIMEOUT_MS = 45 * 60_000;
const PI_TOOLS = 'read,write,edit,ls,grep,find,bash';

function piCliPath(): string {
  const mainUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
  return join(dirname(fileURLToPath(mainUrl)), 'cli.js');
}

function runPi(cliPath: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(res => {
    const child = spawn('node', [cliPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const CAP = 16 * 1024 * 1024;
    child.stdout.on('data', d => { if (stdout.length < CAP) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < CAP) stderr += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('close', code => { clearTimeout(timer); res({ code: code ?? 1, stdout, stderr, timedOut }); });
    child.on('error', err => { clearTimeout(timer); res({ code: 1, stdout, stderr: stderr + String(err), timedOut }); });
  });
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === '__pycache__') continue;
      const full = join(dir, f);
      const rel = prefix ? `${prefix}/${f}` : f;
      if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
      else out.push(rel);
    }
  } catch { /* best-effort */ }
  return out;
}

async function runSessions(): Promise<void> {
  const ticket = readFileSync(join(DUEL_DIR, 'TICKET.md'), 'utf-8');
  const cli = piCliPath();
  for (const c of CONTESTANTS) {
    const ws = join(DUEL_DIR, `workspace-${c.id}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'TICKET.md'), ticket);
    console.log(`\n================ ${c.id} (${c.model}) ================`);
    const start = Date.now();
    const prompt = `${ticket}\n\nImplement this ticket completely in the current directory. Run your tests with python3 and iterate until they pass. When everything passes, stop.`;
    const r = await runPi(cli, ['-p', '--no-context-files', '--model', c.model, '--api-key', 'duel', '--tools', PI_TOOLS, '-a', prompt], ws, SESSION_TIMEOUT_MS);
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    const files = listFiles(ws);
    writeFileSync(join(DUEL_DIR, `session-${c.id}.log`), `exit=${r.code} timedOut=${r.timedOut} wall=${secs}s\n\n--- stdout ---\n${r.stdout}\n\n--- stderr ---\n${r.stderr}`);
    console.log(`  ${c.id}: exit=${r.code}${r.timedOut ? ' TIMED OUT' : ''}, ${secs}s, ${files.length} files: ${files.join(', ').slice(0, 300)}`);
  }
  console.log('\nPI DUEL SESSIONS COMPLETE');
}

function score(): void {
  for (const c of CONTESTANTS) {
    const ws = resolve(join(DUEL_DIR, `workspace-${c.id}`));
    const hidden = resolve(join(DUEL_DIR, 'hidden'));
    console.log(`\n================ scoring ${c.id} ================`);
    if (!existsSync(join(ws, 'jobqueue'))) { console.log('  NO jobqueue package — score 0'); continue; }
    const docker = (cmd: string[]): { out: string; code: number } => {
      const r = spawnSync('docker', ['run', '--rm', '--network=none', '-m', '512m', '--cpus', '2',
        '-v', `${ws}:/w`, '-v', `${hidden}:/hidden:ro`, '-w', '/w', 'python:3.11-alpine', ...cmd],
      { timeout: 300_000, encoding: 'utf8' });
      return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status ?? 1 };
    };
    const acc = docker(['python3', '/hidden/acceptance.py']);
    console.log(acc.out.trim().split('\n').map(l => `  ${l}`).join('\n'));
    const own = docker(['python3', '-m', 'unittest', 'discover', '-s', '.', '-v']);
    const ownSummary = own.out.trim().split('\n').slice(-3).join(' | ');
    console.log(`  own tests (exit ${own.code}): ${ownSummary.slice(0, 220)}`);
    writeFileSync(join(DUEL_DIR, `score-${c.id}.txt`), `ACCEPTANCE:\n${acc.out}\n\nOWN TESTS (exit ${own.code}):\n${own.out.slice(0, 8000)}`);
  }
}

if (process.argv.includes('--score')) score();
else runSessions().catch(e => { console.error(e); process.exit(1); });
