import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedPath, containedInAny, safeBasename, canonicalPath } from '../../src/security/paths.js';

// One containment policy for every path-taking tool (outside review F12/F13/F16, 2026-09-27).
describe('containedPath', () => {
  const base = mkdtempSync(join(tmpdir(), 'paths-'));
  const main = join(base, 'main'); const main2 = join(base, 'main2'); const outside = join(base, 'outside');
  for (const d of [main, main2, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(main2, 'sentinel.txt'), 'x');
  writeFileSync(join(outside, 'secret'), 'x');
  symlinkSync(join(outside, 'secret'), join(main, 'link'));

  it('accepts a relative child and an absolute child', () => {
    expect(containedPath(main, 'notes/a.md')).toBe(join(canonicalPath(main), 'notes', 'a.md'));
    expect(containedPath(main, join(main, 'a.md'))).toBe(join(canonicalPath(main), 'a.md'));
  });
  it('rejects the sibling-prefix escape that startsWith accepted', () => {
    expect(containedPath(main, '../main2/sentinel.txt')).toBeNull();
    expect(containedPath(main, join(main2, 'sentinel.txt'))).toBeNull();
  });
  it('rejects traversal, absolute-outside, and the root itself', () => {
    expect(containedPath(main, '../outside/secret')).toBeNull();
    expect(containedPath(main, '/etc/passwd')).toBeNull();
    expect(containedPath(main, '.')).toBeNull();
  });
  it('decides on the canonical path: a symlink inside pointing outside is rejected', () => {
    expect(containedPath(main, 'link')).toBeNull();
  });
  it('normalizes dot segments before deciding (SOUL.md/. → SOUL.md)', () => {
    expect(containedPath(main, 'SOUL.md/.')).toBe(join(canonicalPath(main), 'SOUL.md'));
  });
  it('containedInAny finds the first matching root', () => {
    expect(containedInAny([main, main2], join(main2, 'sentinel.txt'))).toBe(join(canonicalPath(main2), 'sentinel.txt'));
    expect(containedInAny([main, main2], join(outside, 'secret'))).toBeNull();
  });
});

describe('safeBasename', () => {
  it('accepts plain names and rejects paths, dots, and shell characters', () => {
    expect(safeBasename('report')).toBe('report');
    expect(safeBasename(' q3 report v2 ')).toBe('q3 report v2');
    for (const bad of ['../x', 'a/b', 'a\\b', '.', '..', '', 'x$(echo hi)', 'x`id`', "a'b", 'a"b', 'a;b', 'a|b', 'a\nb', 'a\0b']) {
      expect(safeBasename(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
