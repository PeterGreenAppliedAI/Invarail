import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The Node supervisor's rollback, on every OS: a failed reinstall HALTS with the marker and
// returns false; the source is still restored. `npm` is shimmed to fail (a .cmd on Windows).
describe('supervisor.mjs rollback', () => {
  it('halts with data/supervisor-halt.json when npm ci fails, and restores the source', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sup-node-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":1}'); git('add', '.'); git('commit', '-qm', 'old');
    const old = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":2}'); git('add', '.'); git('commit', '-qm', 'new');
    const shim = join(repo, 'shim'); mkdirSync(shim);
    if (process.platform === 'win32') writeFileSync(join(shim, 'npm.cmd'), '@echo npm ci exploded 1>&2\r\n@exit /b 1\r\n');
    else { writeFileSync(join(shim, 'npm'), '#!/bin/sh\necho "npm ci exploded" >&2; exit 1\n'); chmodSync(join(shim, 'npm'), 0o755); }
    const { rollback } = await import(pathToFileURL(resolve('scripts/supervisor-lib.mjs')).href) as { rollback: (sha: string, cwd: string, env: NodeJS.ProcessEnv) => boolean };
    const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    let ok: boolean;
    try { ok = rollback(old, repo, { ...process.env, PATH: `${shim}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` }); }
    finally { console.log = orig; }
    expect(ok).toBe(false);
    expect(logs.some(l => /HALTING/.test(l))).toBe(true);
    expect(existsSync(join(repo, 'data', 'supervisor-halt.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, 'data', 'supervisor-halt.json'), 'utf-8')).reason).toMatch(/npm ci failed/);
    expect(git('rev-parse', 'HEAD')).toBe(old);
  });

  it('a rollback whose lockfile did not change needs no reinstall and returns true', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sup-node-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":1}'); writeFileSync(join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'old');
    const old = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), '2'); git('add', '.'); git('commit', '-qm', 'new');
    const { rollback } = await import(pathToFileURL(resolve('scripts/supervisor-lib.mjs')).href) as { rollback: (sha: string, cwd: string, env: NodeJS.ProcessEnv) => boolean };
    const orig = console.log; console.log = () => {};
    try { expect(rollback(old, repo, process.env)).toBe(true); } finally { console.log = orig; }
    expect(git('rev-parse', 'HEAD')).toBe(old);
    expect(existsSync(join(repo, 'data', 'supervisor-halt.json'))).toBe(false);
  });
});
