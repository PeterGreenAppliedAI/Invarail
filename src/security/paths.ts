import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * ONE filesystem containment policy for every tool that reads or writes by path.
 *
 * Before 2026-09-27 five tools each did their own check, three of them with
 * `fullPath.startsWith(root)` — which accepts `<root>2/…` (the sibling-prefix bug
 * read_file had already fixed) and never resolves symlinks — and one checked the
 * protected-file list on the RAW input, so `SOUL.md/.` slipped past (outside review
 * F12/F13/F16). Canonicalize first, decide on the canonical path, one function.
 */

/** Does this path component exist AS ITSELF — file, directory, or symlink (dangling included)? */
function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * realpath of the deepest EXISTING ancestor, plus the not-yet-created tail.
 *
 * Existence is tested with lstat, not stat: a DANGLING symlink exists as a link even though
 * its target does not, and `existsSync` follows links and says "absent" — which let the walk
 * skip the link, rebuild a path inside the root, and hand `writeFileSync` a name the kernel
 * then followed OUT of the root (third review T01, 2026-09-28). A dangling link is resolved
 * to its target path and canonicalized in turn, so containment judges the destination.
 */
export function canonicalPath(absolute: string, depth = 0): string {
  let cur = absolute;
  const tail: string[] = [];
  while (!lexists(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    // exists per lstat but realpath fails: a dangling symlink (or a loop) — follow the link
    // text ourselves, bounded, so the destination is what gets judged.
    let target: string | null = null;
    try { target = readlinkSync(cur); } catch { target = null; }
    if (target !== null && depth < 8) {
      const dest = resolve(dirname(cur), target);
      return canonicalPath(tail.length ? join(dest, ...tail) : dest, depth + 1);
    }
    real = cur;
  }
  return tail.length ? join(real, ...tail) : real;
}

/**
 * Resolve `target` (absolute, or relative to `root`) and require the canonical result
 * to sit strictly inside `root`. Returns the canonical absolute path, or null.
 * The root itself is not "inside" — callers expect a file or subpath.
 */
export function containedPath(root: string, target: string): string | null {
  const rootReal = canonicalPath(resolve(root));
  const real = canonicalPath(resolve(root, target));
  const rel = relative(rootReal, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return real;
}

/** True when `target` is inside ANY of `roots` (canonical). */
export function containedInAny(roots: string[], target: string): string | null {
  for (const root of roots) {
    const hit = containedPath(root, target);
    if (hit) return hit;
  }
  return null;
}

/**
 * A single, plain path component for a server-side filename: no separators, no `.`/`..`,
 * no NUL, no shell-significant characters. Returns the trimmed name or null.
 */
export function safeBasename(name: string): string | null {
  const n = name.trim();
  if (!n || n === '.' || n === '..') return null;
  if (/[\\/\0]/.test(n)) return null;
  if (basename(n) !== n) return null;
  if (/[`$"'|;&<>(){}\r\n]/.test(n)) return null;
  return n;
}
