import { sharedExperienceStore, type ExperienceStore } from '../memory/experience-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * CodingMemoryContext — the advisory memory surfaces for Pi sessions (Phase C).
 * Two surfaces, deliberately split:
 *  - buildPriorExperienceBrief: a small deterministic packet PREPENDED to the prompt
 *    (cheap, bounded — the default substrate)
 *  - buildMemorySearchCallback: read-only pull for when Pi decides it needs more
 * AUTHORITY BOUNDARY: both surfaces are advisory prompt text. Pi READS memory; only
 * Invarail writes it. Nothing here may alter permissions, routing, or tool exposure.
 */

const BRIEF_MAX_LINES = 4;
const EXPERIENCE_FLOOR = 0.6;
const FACT_FLOOR = 0.52;   // chat priming's measured floor (qwen3-embedding corpus)

export interface CodingMemoryDeps {
  experienceStore?: ExperienceStore;
  graphMemory?: GraphMemoryStore;
  client?: OllamaClient;
  ownerId?: string;
  /** Workspace path for the LessonStore (lessons skipped when absent) */
  workspacePath?: string;
}

/**
 * Bounded PRIOR EXPERIENCE block for the session prompt. Floor + cap discipline mirrors
 * chat priming: the floor rejects, never the whole transcript of last time. Empty-safe:
 * any absent dependency or failure yields ''.
 */
export async function buildPriorExperienceBrief(spec: string, deps: CodingMemoryDeps): Promise<string> {
  const lines: string[] = [];
  try {
    if (deps.experienceStore) {
      const experiences = await deps.experienceStore.searchRelevant(spec, 2, EXPERIENCE_FLOOR);
      for (const x of experiences) {
        lines.push(`- [${x.outcome}${x.verified ? ', gate-verified' : ''}] ${x.text.slice(0, 200)}`);
      }
    }
  } catch (err) {
    console.warn('[CodingMemory] experience brief failed:', err instanceof Error ? err.message : err);
  }
  try {
    if (deps.client && deps.workspacePath) {
      const lessonLines = await lessonLinesFor(deps.client, deps.workspacePath, spec);
      lines.push(...lessonLines.slice(0, 2));
    }
  } catch (err) {
    console.warn('[CodingMemory] lesson brief failed:', err instanceof Error ? err.message : err);
  }
  if (lines.length === 0) return '';
  return '\nPRIOR EXPERIENCE (institutional memory — advisory):\n' + lines.slice(0, BRIEF_MAX_LINES).join('\n') + '\n';
}

/**
 * The read-only memory_search callback for the Pi session (registered via customTools in
 * the adapter — memory modules never see SDK types; the adapter never sees memory types
 * beyond this function). NEVER throws: memory unavailability degrades cognition, it must
 * not alter task-outcome telemetry (a thrown tool lands as isError in the failure harvest).
 */
export function buildMemorySearchCallback(deps: CodingMemoryDeps): (query: string) => Promise<string> {
  return async (query: string): Promise<string> => {
    try {
      const parts: string[] = [];
      if (deps.experienceStore) {
        const experiences = await deps.experienceStore.searchRelevant(query, 3, EXPERIENCE_FLOOR);
        parts.push(...experiences.map(x => `[experience/${x.outcome}${x.verified ? '/verified' : ''}] ${x.text.slice(0, 200)}`));
      }
      if (deps.graphMemory && deps.ownerId) {
        const facts = await deps.graphMemory.search(query, deps.ownerId, 5, { minSimilarity: FACT_FLOOR });
        parts.push(...facts.slice(0, 5).map(f => `[fact] ${String((f as { text?: string }).text ?? '').slice(0, 200)}`).filter(l => l !== '[fact] '));
      }
      if (deps.client && deps.workspacePath) {
        parts.push(...(await lessonLinesFor(deps.client, deps.workspacePath, query)).slice(0, 2));
      }
      return parts.length > 0 ? parts.slice(0, 8).join('\n') : 'No relevant prior experience or facts found.';
    } catch (err) {
      console.warn('[CodingMemory] memory_search failed (returning empty):', err instanceof Error ? err.message : err);
      return 'No relevant prior experience or facts found.';
    }
  };
}

/** Deps assembly lives HERE (an allowlisted experience-store consumer) so callers like
 *  register-all never import the experience layer directly. */
export function buildCodingMemoryDeps(opts: {
  client?: OllamaClient;
  graphMemory?: GraphMemoryStore;
  ownerId?: string;
  workspacePath?: string;
  experienceStore?: ExperienceStore;
  falkordb?: { host?: string; port?: number; graphName?: string };
}): CodingMemoryDeps {
  return {
    client: opts.client,
    graphMemory: opts.graphMemory,
    ownerId: opts.ownerId,
    workspacePath: opts.workspacePath,
    experienceStore: opts.experienceStore ?? (opts.client ? sharedExperienceStore(opts.client, opts.falkordb) : undefined),
  };
}

async function lessonLinesFor(client: OllamaClient, workspacePath: string, message: string): Promise<string[]> {
  const { LessonStore } = await import('../learnings/lesson-store.js');
  const { relevantLessonLines } = await import('../learnings/lesson-semantic.js');
  return relevantLessonLines(client, new LessonStore(workspacePath), message);
}
