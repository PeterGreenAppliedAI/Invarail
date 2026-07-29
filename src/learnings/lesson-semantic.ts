import type { OllamaClient } from '../ollama/client.js';
import { upsertSourceEmbedding, deleteSourceEmbedding, findBySourceSimilarity } from '../skills/semantic.js';
import { LessonStore, LESSON_EVIDENCE_FLOOR, type Lesson } from './lesson-store.js';

const LESSON_SOURCE = 'lesson';

/** Starts at the MEASURED skill floor (same embedding model, same text shape).
 *  Re-measure with scripts/lesson-floor-check.ts once ~5 real lessons exist. */
export const LESSON_MATCH_FLOOR = 0.65;

function lessonText(lesson: Lesson): string {
  const triggers = lesson.triggers.length ? ` Triggers: ${lesson.triggers.join('; ')}` : '';
  return `${lesson.situation}. ${lesson.description}${triggers}`;
}

export async function upsertLessonEmbedding(client: OllamaClient, lesson: Lesson): Promise<void> {
  await upsertSourceEmbedding(client, LESSON_SOURCE, lesson.slug, lessonText(lesson));
}

export function deleteLessonEmbedding(slug: string): void {
  deleteSourceEmbedding(LESSON_SOURCE, slug);
}

/** Semantic lookup of a matching lesson regardless of evidence (dedup path). */
export async function findLessonBySimilarity(
  client: OllamaClient,
  store: LessonStore,
  situation: string,
  floor = LESSON_MATCH_FLOOR,
): Promise<{ slug: string; score: number } | null> {
  const results = await findBySourceSimilarity(client, LESSON_SOURCE, situation, floor);
  for (const r of results) {
    if (store.get(r.key)) return { slug: r.key, score: r.score };
    deleteLessonEmbedding(r.key); // stale index entry for an archived lesson
  }
  return null;
}

/**
 * Injection-path lookup: lessons relevant to this request that have EARNED
 * the right to steer (evidence ≥ LESSON_EVIDENCE_FLOOR). Max 2 one-liners —
 * the whole point is a few dozen tokens, never the corpus.
 */
export async function relevantLessonLines(
  client: OllamaClient,
  store: LessonStore,
  message: string,
  floor = LESSON_MATCH_FLOOR,
): Promise<string[]> {
  const results = await findBySourceSimilarity(client, LESSON_SOURCE, message, floor, 4);
  const lines: string[] = [];
  for (const r of results) {
    const lesson = store.get(r.key);
    if (!lesson) {
      deleteLessonEmbedding(r.key);
      continue;
    }
    if (lesson.evidenceCount < LESSON_EVIDENCE_FLOOR) continue; // one-off = not yet live
    lines.push(`- ${lesson.description}`);
    if (lines.length >= 2) break;
  }
  return lines;
}
