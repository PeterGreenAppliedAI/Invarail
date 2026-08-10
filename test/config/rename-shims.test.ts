import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';

// TEMPORARY-shim behavior pins (see DECISIONS: shims removed at v0.2.0/60d).
// These tests DELETE alongside the shims — they exist to keep the migration
// window honest, not as permanent architecture.

const legacyName = 'local' + 'claw.config.json5';

function inTempCwd<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(dir); } finally { process.chdir(prev); }
}

afterEach(() => vi.restoreAllMocks());

describe('config discovery shim', () => {
  it('falls back to the legacy config ONLY when the new one is absent (ENOENT)', () => {
    inTempCwd((dir) => {
      writeFileSync(join(dir, legacyName), '{ timezone: "America/Chicago" }');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig();
      expect(config.timezone).toBe('America/Chicago');
      expect(warn.mock.calls.some(c => String(c[0]).includes('DEPRECATED'))).toBe(true);
    });
  });

  it('FAILS on a malformed new config — never silently loads the legacy one', () => {
    inTempCwd((dir) => {
      writeFileSync(join(dir, 'invarail.config.json5'), '{ this is not valid json5 ::: }');
      writeFileSync(join(dir, legacyName), '{ timezone: "America/Chicago" }');
      expect(() => loadConfig()).toThrow();
    });
  });

  it('prefers the new config when both exist', () => {
    inTempCwd((dir) => {
      writeFileSync(join(dir, 'invarail.config.json5'), '{ timezone: "America/New_York" }');
      writeFileSync(join(dir, legacyName), '{ timezone: "America/Chicago" }');
      const config = loadConfig();
      expect(config.timezone).toBe('America/New_York');
    });
  });
});

describe('plugin precedence shim', () => {
  it('same plugin name in invarail + legacy dirs → loads once from invarail, skips legacy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const mkPlugin = (base: string, reply: string) => {
      const d = join(base, 'plugins', 'dupe');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'dupe', version: '1.0', type: 'tool', main: 'index.mjs' }));
      writeFileSync(join(d, 'index.mjs'),
        `export const tool = { name: 'dupe_tool', description: '${reply}', parameterDescription: '', category: 'plugin', execute: async () => '${reply}' };`);
    };
    mkPlugin(join(home, '.invarail'), 'new');
    mkPlugin(join(home, '.local' + 'claw'), 'legacy');

    vi.stubEnv('HOME', home);
    vi.resetModules();
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const registered: string[] = [];
    const fakeRegistry = { register: (t: { description: string }) => registered.push(t.description) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Run from an empty cwd so the repo's project-level plugins/ dir is out of
    // scope — chdir must bracket the AWAIT, not just the call
    const emptyCwd = mkdtempSync(join(tmpdir(), 'cwd-'));
    const prevCwd = process.cwd();
    process.chdir(emptyCwd);
    let count: number;
    try { count = await loadPlugins(fakeRegistry as never); }
    finally { process.chdir(prevCwd); }
    expect(count).toBe(1);
    expect(registered).toEqual(['new']);
    expect(log.mock.calls.some(c => String(c[0]).includes('Skipping duplicate'))).toBe(true);
    vi.unstubAllEnvs();
  });
});
