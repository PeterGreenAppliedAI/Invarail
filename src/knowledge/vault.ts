import { readdirSync, statSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';
import { readDocument } from './chunker.js';
import { normalizeAndChunk } from './vault-chunker.js';
import type { EmbeddingStore, MemorySearchResult } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Vault — domain-organized document store as source of truth.
 *
 * vault/<domain>/*.{md,txt,pdf,html,csv} — folders ARE the taxonomy; the
 * owner edits in Obsidian or any editor; reindex is mtime+hash driven so an
 * edit costs one file's embeddings, once per content version.
 *
 * Retrieval is HYBRID: dense (concepts) ∪ FTS5 lexical (exact names like
 * "Gate 4") fused by reciprocal rank, then floor → per-file cap → adjacent
 * stitch → budget pack, with file›heading provenance on every passage.
 */

const SUPPORTED = new Set(['.md', '.txt', '.pdf', '.html', '.htm', '.csv']);
const QUALITY_LOG = 'data/quality/docs-search.jsonl';
const DENSE_FLOOR = 0.45;          // starting point — tune with measured corpus data
const RRF_K = 60;
const PER_FILE_CAP = 2;
const CANDIDATES = 24;

export interface VaultPassage {
  file: string;
  headingPath: string;
  text: string;
  score: number;
}

export function listDomains(vaultPath: string): string[] {
  if (!existsSync(vaultPath)) return [];
  return readdirSync(vaultPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort();
}

// --- Indexing ---

export interface ReindexReport {
  indexed: Array<{ path: string; tier: string; chunks: number }>;
  removed: string[];
  unchanged: number;
}

export async function reindexVault(
  vaultPath: string,
  store: EmbeddingStore,
  client: OllamaClient,
): Promise<ReindexReport> {
  const report: ReindexReport = { indexed: [], removed: [], unchanged: 0 };
  if (!existsSync(vaultPath)) return report;

  const seen = new Set<string>();
  for (const domain of listDomains(vaultPath)) {
    const dir = join(vaultPath, domain);
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile() || !SUPPORTED.has(extname(name).toLowerCase())) continue;
      const rel = relative(vaultPath, full);
      seen.add(rel);

      const mtimeMs = statSync(full).mtimeMs;
      const existing = store.getDocFile(rel);
      if (existing && existing.mtime_ms === mtimeMs) {
        report.unchanged++;
        continue;
      }

      let text: string;
      try {
        text = await readDocument(full);
      } catch (err) {
        console.warn(`[Vault] Unreadable ${rel}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      if (existing && existing.hash === hash) {
        // Touched but unchanged content — refresh mtime, skip re-embed
        store.upsertDocFile({ path: rel, domain, mtimeMs, hash, tier: existing.tier, chunkCount: existing.chunk_count });
        report.unchanged++;
        continue;
      }

      const { tier, chunks } = await normalizeAndChunk(text, rel, {
        embedParagraphs: async (paragraphs) => client.embed(paragraphs),
      });
      if (chunks.length === 0) continue;

      const embeddings = await client.embed(chunks.map(c => c.text));
      store.deleteByFile(rel);
      const now = new Date().toISOString();
      chunks.forEach((c, i) => store.addVaultChunk({
        id: `${rel}#${c.index}`,
        file: rel,
        section: c.headingPath,
        text: c.text,
        embedding: embeddings[i],
        savedAt: now,
        domain,
      }));
      store.upsertDocFile({ path: rel, domain, mtimeMs, hash, tier, chunkCount: chunks.length });
      report.indexed.push({ path: rel, tier, chunks: chunks.length });
      console.log(`[Vault] Indexed ${rel} (tier=${tier}, ${chunks.length} chunk(s))`);
    }
  }

  // Purge files deleted from the vault
  for (const f of store.listDocFiles()) {
    if (!seen.has(f.path)) {
      store.removeDocFile(f.path);
      report.removed.push(f.path);
      console.log(`[Vault] Removed ${f.path} (file deleted)`);
    }
  }
  return report;
}

// --- Retrieval ---

export async function searchVault(opts: {
  query: string;
  domain?: string;
  store: EmbeddingStore;
  client: OllamaClient;
  budgetChars?: number;
}): Promise<VaultPassage[]> {
  const { query, domain, store, client } = opts;
  const budget = opts.budgetChars ?? 7000;

  const [queryEmbedding] = await client.embed(query);
  const dense = store.searchVault(queryEmbedding, domain, CANDIDATES);
  const lexical = store.searchVaultLexical(query, domain, CANDIDATES);

  // Reciprocal rank fusion — dense finds concepts, lexical finds names
  const fused = new Map<string, { entry: { id: string; file: string; section: string; text: string }; score: number; denseScore?: number }>();
  dense.forEach((r, rank) => {
    fused.set(r.id, { entry: r, score: 1 / (RRF_K + rank + 1), denseScore: r.score });
  });
  lexical.forEach((r, rank) => {
    const prior = fused.get(r.id);
    if (prior) prior.score += 1 / (RRF_K + rank + 1);
    else fused.set(r.id, { entry: r, score: 1 / (RRF_K + rank + 1) });
  });

  // Floor applies to DENSE-ONLY hits (a lexical exact-term hit earns its place)
  const candidates = [...fused.values()]
    .filter(c => c.denseScore === undefined || c.denseScore >= DENSE_FLOOR || lexical.some(l => l.id === c.entry.id))
    .sort((a, b) => b.score - a.score);

  // Per-file cap, then stitch adjacent chunks of the same file
  const perFile = new Map<string, number>();
  const picked: Array<{ id: string; file: string; section: string; text: string; score: number }> = [];
  for (const c of candidates) {
    const n = perFile.get(c.entry.file) ?? 0;
    if (n >= PER_FILE_CAP) continue;
    perFile.set(c.entry.file, n + 1);
    picked.push({ ...c.entry, score: c.score });
  }

  const stitched: VaultPassage[] = [];
  const consumed = new Set<string>();
  for (const p of picked) {
    if (consumed.has(p.id)) continue;
    const idx = parseInt(p.id.split('#').pop() ?? '-1');
    const neighbor = picked.find(q => q.file === p.file && !consumed.has(q.id) && Math.abs(parseInt(q.id.split('#').pop() ?? '-1') - idx) === 1);
    let text = p.text;
    let headingPath = p.section;
    if (neighbor) {
      const [first, second] = parseInt(neighbor.id.split('#').pop()!) > idx ? [p, neighbor] : [neighbor, p];
      text = `${first.text}\n…\n${second.text}`;
      // A stitched passage spans both scopes — provenance must say so
      headingPath = first.section === second.section ? first.section : `${first.section} + ${second.section}`;
      consumed.add(neighbor.id);
    }
    consumed.add(p.id);
    stitched.push({ file: p.file, headingPath, text, score: p.score });
  }

  // Budget pack in rank order
  const packed: VaultPassage[] = [];
  let used = 0;
  for (const p of stitched) {
    const cost = p.text.length + p.file.length + 40;
    if (used + cost > budget && packed.length > 0) break;
    packed.push(used + cost > budget ? { ...p, text: p.text.slice(0, budget - used - p.file.length - 40) } : p);
    used += Math.min(cost, budget - used);
    if (used >= budget) break;
  }

  try {
    mkdirSync('data/quality', { recursive: true });
    appendFileSync(QUALITY_LOG, JSON.stringify({
      timestamp: new Date().toISOString(), query, domain: domain ?? 'all',
      denseTop: dense.slice(0, 3).map(d => ({ f: d.file, s: +d.score.toFixed(3) })),
      lexicalTop: lexical.slice(0, 3).map(l => l.file),
      returned: packed.map(p => p.file),
    }) + '\n');
  } catch { /* non-critical */ }

  return packed;
}

// --- Storing from conversation ---

export function storeDocument(vaultPath: string, domain: string, title: string, content: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
  const dir = join(vaultPath, domain);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${slug}.md`);
  if (existsSync(path)) path = join(dir, `${slug}-${Date.now().toString(36)}.md`);
  const body = content.startsWith('#') ? content : `# ${title}\n\n${content}`;
  writeFileSync(path, body);
  return path;
}
