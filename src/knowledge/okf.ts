/**
 * Open Knowledge Format (OKF v0.2) — a directory of markdown with YAML front matter.
 * https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
 *
 * What we use of it, and only that:
 *   - every concept document has front matter with a `type` (the one required field);
 *     `title`, `description`, `tags` are the recommended queryables;
 *   - `index.md` per directory is the progressive-disclosure listing — a bulleted list of
 *     links with one-line descriptions — which a small model reads INSTEAD of the files;
 *   - `log.md` is the newest-first change history under ISO-date headings;
 *   - the trust/lifecycle families map onto Invarail's provenance: `verified: human:<id>`
 *     for a STATED fact, `generated: {by, at}` for an observed/inferred one, `status`,
 *     and `stale_after` from the importance TTL.
 *
 * Parsing is deliberately tolerant (§11: consumers must not reject for missing optional
 * fields, unknown types, unknown keys, broken links or missing index.md). The front
 * matter subset we read is flat scalars, `[a, b]` lists and one level of `{k: v}`
 * mappings — enough for OKF's queryable fields without a YAML dependency.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

export const OKF_VERSION = '0.2';
export const RESERVED_FILES = new Set(['index.md', 'log.md']);

export interface FrontMatter { [key: string]: unknown }
export interface ParsedDoc { data: FrontMatter; body: string; hasFrontMatter: boolean }

export function isReservedName(name: string): boolean {
  return RESERVED_FILES.has(basename(name).toLowerCase());
}

/** Tolerant front-matter parse: `---\n…\n---\n` at the top, else no front matter. */
export function parseFrontMatter(text: string): ParsedDoc {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text, hasFrontMatter: false };
  const data: FrontMatter = {};
  let currentKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const nested = raw.match(/^\s+-\s+(.*)$/);
    if (nested && currentKey) {
      // list item under a key (`sources:` entries) — keep the raw item text
      const arr = Array.isArray(data[currentKey]) ? (data[currentKey] as unknown[]) : [];
      arr.push(scalarOrMap(nested[1]));
      data[currentKey] = arr;
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    currentKey = key;
    data[key] = value === '' ? [] : scalarOrMap(value);
  }
  return { data, body: text.slice(m[0].length), hasFrontMatter: true };
}

function scalarOrMap(v: string): unknown {
  const s = v.trim();
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map(x => unquote(x.trim())).filter(Boolean);
  if (/^\{.*\}$/.test(s)) {
    const out: Record<string, unknown> = {};
    for (const part of s.slice(1, -1).split(',')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim()] = unquote(part.slice(i + 1).trim());
    }
    return out;
  }
  return unquote(s);
}
const unquote = (s: string): string => s.replace(/^(["'])(.*)\1$/, '$2');

export function serializeFrontMatter(data: FrontMatter, body: string): string {
  const lines: string[] = ['---'];
  const emit = (k: string, v: unknown, indent = ''): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      if (v.every(x => typeof x !== 'object')) { lines.push(`${indent}${k}: [${v.map(x => quoteIfNeeded(String(x))).join(', ')}]`); return; }
      lines.push(`${indent}${k}:`);
      for (const item of v) lines.push(`${indent}  - ${inlineMap(item as Record<string, unknown>)}`);
      return;
    }
    if (typeof v === 'object') { lines.push(`${indent}${k}: ${inlineMap(v as Record<string, unknown>)}`); return; }
    lines.push(`${indent}${k}: ${quoteIfNeeded(String(v))}`);
  };
  for (const [k, v] of Object.entries(data)) emit(k, v);
  lines.push('---', '', body.replace(/^\n+/, ''));
  return lines.join('\n');
}
const inlineMap = (o: Record<string, unknown>): string => `{ ${Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${quoteIfNeeded(String(v))}`).join(', ')} }`;
function quoteIfNeeded(s: string): string {
  return /[:#\[\]{},]|^\s|\s$|^$/.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s) ? JSON.stringify(s) : s;
}

// ---------------------------------------------------------------- facts as concepts

export interface FactLike {
  id: string; text: string; category: string; provenance: 'stated' | 'observed' | 'inferred';
  createdAt: string; expiresAt?: string; tags: string[]; entities: string[]; importance: number; confidence: number; source: string;
}

/** An Invarail fact as an OKF concept document. Provenance → trust family (§5/§7). */
export function conceptForFact(fact: FactLike, opts: { owner?: string; agent?: string }): string {
  const agent = opts.agent ?? 'invarail';
  const data: FrontMatter = {
    type: 'Fact',
    title: fact.text.length > 80 ? `${fact.text.slice(0, 77)}…` : fact.text,
    description: fact.text,
    tags: [...new Set([fact.category, ...fact.tags])],
    status: fact.provenance === 'inferred' ? 'draft' : 'stable',
    importance: fact.importance,
    confidence: fact.confidence,
    provenance: fact.provenance,
    generated: { by: `${agent}/${fact.source}`, at: fact.createdAt },
    ...(fact.provenance === 'stated' && opts.owner ? { verified: [{ by: `human:${opts.owner}`, at: fact.createdAt }] } : {}),
    ...(fact.expiresAt ? { stale_after: fact.expiresAt } : {}),
    ...(fact.entities.length ? { entities: fact.entities } : {}),
    invarail_id: fact.id,
  };
  return serializeFrontMatter(data, `${fact.text}\n`);
}

export const FACT_DOMAIN = 'memory';
export const factConceptPath = (vaultPath: string, id: string): string => join(vaultPath, FACT_DOMAIN, `${id}.md`);

// ---------------------------------------------------------------- index.md / log.md

interface Listed { file: string; title: string; description: string }

function listConcepts(dir: string): Listed[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && extname(d.name).toLowerCase() === '.md' && !isReservedName(d.name))
    .map(d => {
      const { data } = parseFrontMatter(readFileSync(join(dir, d.name), 'utf-8'));
      return {
        file: d.name,
        title: typeof data.title === 'string' && data.title ? data.title : d.name.replace(/\.md$/, ''),
        description: typeof data.description === 'string' ? data.description : '',
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Marks a file Invarail generated. A person's own index.md / log.md never carries it and is never overwritten. */
export const GENERATED_MARK = '<!-- generated by invarail; edits are overwritten on the next heartbeat -->';
export function isOurs(path: string): boolean {
  if (!existsSync(path)) return true;
  return readFileSync(path, 'utf-8').includes(GENERATED_MARK);
}

const subdirs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort();
const countConcepts = (dir: string): number => listConcepts(dir).length + subdirs(dir).reduce((n, d) => n + countConcepts(join(dir, d)), 0);

/**
 * Write `index.md` in every directory of the bundle, nested ones included (§8: optional at
 * any level). Existing notes are LISTED as they are — front matter or not, the vault was
 * theirs first; nothing is moved, rewritten or cleared. A directory whose index.md is not
 * ours is left alone and reported in `skipped`.
 */
export function writeIndexes(vaultPath: string, opts?: { title?: string }): string[] {
  return writeIndexesReport(vaultPath, opts).written;
}
export function writeIndexesReport(vaultPath: string, opts?: { title?: string }): { written: string[]; skipped: string[] } {
  const written: string[] = [], skipped: string[] = [];
  if (!existsSync(vaultPath)) return { written, skipped };
  const writeDir = (dir: string, heading: string, root: boolean): void => {
    for (const sub of subdirs(dir)) writeDir(join(dir, sub), sub, false);
    const target = join(dir, 'index.md');
    if (!isOurs(target)) { skipped.push(target); return; }
    const items = listConcepts(dir);
    const lines = [
      ...(root ? ['---', `okf_version: ${OKF_VERSION}`, '---', ''] : []),
      `# ${heading}`, '',
      ...subdirs(dir).map(d => `* [${d}/](${d}/index.md) - ${countConcepts(join(dir, d))} concept(s)`),
      ...items.map(i => `* [${i.title}](${i.file})${i.description ? ` - ${i.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`),
      '', GENERATED_MARK, '',
    ];
    writeFileSync(target, lines.join('\n'));
    written.push(target);
  };
  writeDir(vaultPath, opts?.title ?? (basename(vaultPath) || 'vault'), true);
  return { written, skipped };
}

/** Prepend today's entries to `log.md` (§9: newest first, ISO date headings). */
export function appendLog(vaultPath: string, entries: Array<{ kind: 'Creation' | 'Update' | 'Removal'; text: string }>, now = new Date()): void {
  if (entries.length === 0) return;
  mkdirSync(vaultPath, { recursive: true });
  const path = join(vaultPath, 'log.md');
  if (!isOurs(path)) return;   // a person's own log.md is theirs
  const date = now.toISOString().slice(0, 10);
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const body = existing.replace(/^# [^\n]*\n+/, '').replace(GENERATED_MARK, '').trimEnd();
  const todayHeader = `## ${date}`;
  const newLines = entries.map(e => `* **${e.kind}**: ${e.text}`).join('\n');
  let rest: string;
  if (body.startsWith(todayHeader)) {
    rest = body.replace(todayHeader + '\n', `${todayHeader}\n${newLines}\n`);
  } else {
    rest = `${todayHeader}\n${newLines}\n\n${body}`;
  }
  writeFileSync(path, `# Vault Update Log\n\n${rest.trimEnd()}\n\n${GENERATED_MARK}\n`);
}

// ---------------------------------------------------------------- conformance (§11)

export interface ConformanceIssue { file: string; issue: string }

/** §11: every non-reserved .md has parseable front matter with a non-empty `type`. */
export function checkBundle(vaultPath: string): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  if (!existsSync(vaultPath)) return issues;
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (extname(d.name).toLowerCase() !== '.md' || isReservedName(d.name)) continue;
      const rel = relative(vaultPath, full);
      const { data, hasFrontMatter } = parseFrontMatter(readFileSync(full, 'utf-8'));
      if (!hasFrontMatter) issues.push({ file: rel, issue: 'no front matter' });
      else if (typeof data.type !== 'string' || !data.type) issues.push({ file: rel, issue: 'front matter has no `type`' });
    }
  };
  walk(vaultPath);
  return issues;
}

/** Give a plain vault document the minimum OKF front matter (type + title) without touching its body. */
export function ensureFrontMatter(path: string, defaults: { type: string; title?: string }): boolean {
  const text = readFileSync(path, 'utf-8');
  const { data, hasFrontMatter, body } = parseFrontMatter(text);
  if (hasFrontMatter && typeof data.type === 'string' && data.type) return false;
  const title = defaults.title ?? (body.match(/^#\s+(.+)$/m)?.[1] ?? basename(path, '.md'));
  const merged: FrontMatter = { type: defaults.type, title, ...data };
  writeFileSync(path, serializeFrontMatter(merged, body));
  return true;
}

/** Size of the on-disk index a model would read instead of the files. */
export function indexStats(vaultPath: string): { files: number; indexBytes: number } {
  let files = 0, indexBytes = 0;
  if (!existsSync(vaultPath)) return { files, indexBytes };
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.toLowerCase() === 'index.md') indexBytes += statSync(full).size;
      else if (extname(d.name).toLowerCase() === '.md') files++;
    }
  };
  walk(vaultPath);
  return { files, indexBytes };
}
