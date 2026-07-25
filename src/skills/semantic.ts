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
/** Measured-floor placeholder — validate with scripts/skill-match-check.ts before trusting in prod. */
export const SKILL_MATCH_FLOOR = 0.6;

let sharedStore: EmbeddingStore | null = null;

function embeddingStore(): EmbeddingStore {
  sharedStore ??= new EmbeddingStore();
  return sharedStore;
}

/** Test seam — inject a store bound to a temp db. */
export function setEmbeddingStoreForTests(store: EmbeddingStore | null): void {
  sharedStore = store;
}

function skillText(skill: Skill): string {
  const triggers = skill.triggers.length ? ` Triggers: ${skill.triggers.join('; ')}` : '';
  return `${skill.name}. ${skill.description}${triggers}`;
}

/** Insert-or-replace the skill's embedding (stable id → idempotent re-index). */
export async function upsertSkillEmbedding(client: OllamaClient, skill: Skill): Promise<void> {
  try {
    const embedding = await generateEmbedding(client, skillText(skill));
    if (embedding.length === 0) return;
    embeddingStore().add({
      id: `skill:${skill.slug}`,
      text: skillText(skill),
      file: skill.slug,
      section: 'skill',
      embedding,
      savedAt: new Date().toISOString(),
      source: SKILL_SOURCE,
    });
  } catch (err) {
    // Embedding backend down → keyword fallback still works; never block a save
    console.warn('[Skills] Embedding upsert failed (keyword matching still active):', err instanceof Error ? err.message : err);
  }
}

export function deleteSkillEmbedding(slug: string): void {
  try {
    embeddingStore().deleteBySourceFile(SKILL_SOURCE, slug);
  } catch { /* best-effort */ }
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
  try {
    const queryEmbedding = await generateEmbedding(client, goal);
    if (queryEmbedding.length === 0) return null;
    const results = embeddingStore().search(queryEmbedding, 3, floor, SKILL_SOURCE);
    for (const r of results) {
      if (store.get(r.file)) return { slug: r.file, score: r.score };
      deleteSkillEmbedding(r.file); // stale index entry for an archived skill
    }
    return null;
  } catch (err) {
    console.warn('[Skills] Semantic match unavailable (falling back to keywords):', err instanceof Error ? err.message : err);
    return null;
  }
}
