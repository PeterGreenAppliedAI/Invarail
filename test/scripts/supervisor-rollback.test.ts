import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Third review N06: a rollback whose `npm ci` fails must HALT with a marker, not boot the
// restored source on an unmatched dependency tree. Runs only the script's rollback() in a
// disposable repo with an `npm` shim that fails. bash-only, like the supervisor itself.
describe.skipIf(process.platform === 'win32')('supervisor rollback halts when the reinstall fails', () => {
  it('writes data/supervisor-halt.json and exits non-zero', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sup-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":1}'); git('add', '.'); git('commit', '-qm', 'old');
    const old = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":2}'); git('add', '.'); git('commit', '-qm', 'new');
    const shim = join(repo, 'shim'); mkdirSync(shim);
    writeFileSync(join(shim, 'npm'), '#!/bin/sh\necho "npm ci exploded" >&2; exit 1\n'); chmodSync(join(shim, 'npm'), 0o755);
    const script = resolve('scripts/supervisor.sh');
    const fn = readFileSync(script, 'utf-8').match(/^rollback\(\) \{[\s\S]*?^\}/m)![0];
    const r = spawnSync('bash', ['-c', `log(){ echo "$*"; }; MARKER=/nonexistent; FAILED_MARKER=/nonexistent2\n${fn}\nrollback ${old}`], { cwd: repo, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/HALTING/);
    expect(existsSync(join(repo, 'data', 'supervisor-halt.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, 'data', 'supervisor-halt.json'), 'utf-8')).reason).toMatch(/npm ci failed/);
    expect(git('rev-parse', 'HEAD')).toBe(old);   // the source WAS restored; only the boot is refused
  });
});
