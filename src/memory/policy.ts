/**
 * Memory tier policy — ONE place that reads the config and says what the memory system
 * is allowed to assume. Four tiers a wizard can write (DECISIONS 2026-09-27, "memory
 * alternatives for people without the reference setup"):
 *
 *   graph  — FalkorDB + an embedding model (the reference box). Required: doctor FAILs
 *            when FalkorDB is unreachable.
 *   flat   — JSONL facts, keyword recall, no sidecar, no embedder needed.
 *   vault  — flat facts PLUS a markdown vault (Obsidian-edited), lexical (FTS5) search;
 *            with `vault.okf` the bundle carries OKF front matter, facts are mirrored as
 *            concept documents, and index.md / log.md are maintained for navigation.
 *   markdown (legacy default) — today's behaviour: try the graph, fall back to flat.
 *
 * `memory.embeddingModel: "none"` turns every embedding call off; consumers that need
 * vectors are not constructed, and the ones that can degrade (vault, fact dedup) do.
 */
import type { InvarailConfig } from '../config/types.js';

export type MemoryBackend = 'auto' | 'graph' | 'flat' | 'vault';

export const NO_EMBEDDINGS = 'none';

export function embeddingsEnabled(memory: { embeddingModel?: string } | undefined): boolean {
  return (memory?.embeddingModel ?? '') !== NO_EMBEDDINGS;
}

/** `markdown` is the historical default and means "graph if it answers, else flat". */
export function memoryBackend(config: Pick<InvarailConfig, 'memory'>): MemoryBackend {
  const b = config.memory?.backend ?? 'markdown';
  return b === 'markdown' ? 'auto' : b;
}

/** Should the process try to connect a graph store at all? */
export function wantsGraph(config: Pick<InvarailConfig, 'memory'>): boolean {
  const b = memoryBackend(config);
  return (b === 'auto' || b === 'graph') && embeddingsEnabled(config.memory);
}

/** Is the vault the knowledge side of memory (lexical at minimum)? */
export function vaultTier(config: Pick<InvarailConfig, 'memory'>): boolean {
  return memoryBackend(config) === 'vault';
}

/** OKF conventions on the vault: front matter, mirrored facts, index.md / log.md. */
export function okfEnabled(config: Pick<InvarailConfig, 'memory' | 'vault'>): boolean {
  return vaultTier(config) && !!config.vault?.okf;
}
