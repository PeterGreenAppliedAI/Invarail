/**
 * Shared source-scoped embedding helpers over the EmbeddingStore (SQLite).
 * Tenants: 'lesson', 'knowledge' (and formerly 'skill' — retired with the
 * skills system; see DECISIONS 2026-08-10). Extracted from the old
 * skills/semantic.ts when skills were removed.
 */
import { EmbeddingStore, generateEmbedding } from './embeddings.js';
import type { OllamaClient } from '../ollama/client.js';


let sharedStore: EmbeddingStore | null = null;

/** Shared singleton over data/memory.db — tenants scoped by `source` column
 *  (memory / vault / lesson / knowledge). */
export function embeddingStore(): EmbeddingStore {
  sharedStore ??= new EmbeddingStore();
  return sharedStore;
}

/** Test seam — inject a store bound to a temp db. */
export function setEmbeddingStoreForTests(store: EmbeddingStore | null): void {
  sharedStore = store;
}

/** Generic per-source upsert — stable id `<source>:<key>` makes re-indexing idempotent. */
export async function upsertSourceEmbedding(client: OllamaClient, source: string, key: string, text: string): Promise<void> {
  try {
    const embedding = await generateEmbedding(client, text);
    if (embedding.length === 0) return;
    embeddingStore().add({
      id: `${source}:${key}`,
      text,
      file: key,
      section: source,
      embedding,
      savedAt: new Date().toISOString(),
      source,
    });
  } catch (err) {
    console.warn(`[Semantic:${source}] Embedding upsert failed (keyword/degraded paths still active):`, err instanceof Error ? err.message : err);
  }
}

export function deleteSourceEmbedding(source: string, key: string): void {
  try {
    embeddingStore().deleteBySourceFile(source, key);
  } catch { /* best-effort */ }
}

/** Generic per-source dense match. Returns candidate keys above the floor —
 *  callers MUST validate the key still exists in its backing store (embeddings
 *  can outlive archived entries) and prune with deleteSourceEmbedding. */
export async function findBySourceSimilarity(
  client: OllamaClient,
  source: string,
  query: string,
  floor: number,
  maxResults = 3,
): Promise<Array<{ key: string; score: number }>> {
  try {
    const queryEmbedding = await generateEmbedding(client, query);
    if (queryEmbedding.length === 0) return [];
    return embeddingStore().search(queryEmbedding, maxResults, floor, source).map(r => ({ key: r.file, score: r.score }));
  } catch (err) {
    console.warn(`[Semantic:${source}] Dense match unavailable:`, err instanceof Error ? err.message : err);
    return [];
  }
}
