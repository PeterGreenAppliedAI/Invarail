/**
 * Semantic skill matching — dense embeddings over name+description+triggers.
 *
 * Why: the save-time generalizer deliberately strips specifics from skill
 * descriptions ("weather Long Island PDF" → "retrieve data from an external
 * source"), which starved the keyword matcher into never matching (the system
 * was silent March→July 2026). Dense similarity survives generalization, and
 * the `triggers` frontmatter preserves concrete phrasings on top.
 */

import { EmbeddingStore, generateEmbedding } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';
import type { Skill, SkillStore } from './store.js';

const SKILL_SOURCE = 'skill';
/** MEASURED 2026-07-25 vs real qwen3-embedding (scripts/skill-match-check.ts):
 *  noise band ≤0.604, signal band ≥0.700 — the initial 0.60 guess would have
 *  matched "what did we talk about yesterday" (0.604). Re-measure if the
 *  embedding model changes. */
export const SKILL_MATCH_FLOOR = 0.65;

let sharedStore: EmbeddingStore | null = null;

/** Shared singleton over data/memory.db — tenants scoped by `source` column
 *  (memory / vault / skill / lesson). */
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

function skillText(skill: Skill): string {
  const triggers = skill.triggers.length ? ` Triggers: ${skill.triggers.join('; ')}` : '';
  return `${skill.name}. ${skill.description}${triggers}`;
}

/** Insert-or-replace the skill's embedding (stable id → idempotent re-index). */
export async function upsertSkillEmbedding(client: OllamaClient, skill: Skill): Promise<void> {
  await upsertSourceEmbedding(client, SKILL_SOURCE, skill.slug, skillText(skill));
}

export function deleteSkillEmbedding(slug: string): void {
  deleteSourceEmbedding(SKILL_SOURCE, slug);
}

export interface SemanticSkillMatch {
  slug: string;
  score: number;
}

/**
 * Dense match of a goal against indexed skills. Returns null when the backend
 * is unavailable or nothing clears the floor. The caller MUST verify the slug
 * still exists in the SkillStore (embeddings can outlive archived skills).
 */
export async function findSkillBySimilarity(
  client: OllamaClient,
  store: SkillStore,
  goal: string,
  floor = SKILL_MATCH_FLOOR,
): Promise<SemanticSkillMatch | null> {
  const results = await findBySourceSimilarity(client, SKILL_SOURCE, goal, floor);
  for (const r of results) {
    if (store.get(r.key)) return { slug: r.key, score: r.score };
    deleteSkillEmbedding(r.key); // stale index entry for an archived skill
  }
  return null;
}
