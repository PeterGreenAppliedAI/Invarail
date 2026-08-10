import { FalkorDB, Graph } from 'falkordb';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Graph experience memory — the agent's record of what approaches worked,
 * what failed, and what the USER thought of it (satisfaction valence).
 *
 * AUTHORITY BOUNDARY (see DECISIONS 2026-08-10): experience INFORMS execution
 * as advisory prompt text only. Nothing in this module — and nothing consuming
 * it — may modify permissions, routing constraints, confirmation requirements,
 * tool exposure, or allowed workflows. Rebuilding skills under another name is
 * the named failure mode; a structural test pins this module's consumers.
 *
 * Modeled on GraphMemoryStore (the proven pattern): same FalkorDB graph, own
 * connection, vector index, dedup-on-write, SUPERSEDES on contradiction.
 * Contradiction here is PURE CODE (structured outcome/satisfaction fields
 * flipped) — no LLM judge needed, an improvement over the fact system.
 */

export interface Experience {
  id: string;
  text: string;                    // "For <task shape>, <approach> — <outcome>; user <evidence>"
  taskShape: string;
  approach: string;
  outcome: 'worked' | 'failed';
  satisfaction: -1 | 0 | 1;
  evidenceCount: number;
  model: string;                   // model-at-observation (point-in-time, like lessons)
  createdAt: string;
  lastConfirmed: string;
  superseded?: boolean;
}

export interface ExperienceMatch extends Experience {
  score: number;
}

interface ExperienceStoreConfig {
  host: string;
  port: number;
  graphName: string;
  embeddingDims: number;
}

const DEFAULT_CONFIG: ExperienceStoreConfig = {
  host: 'localhost',
  port: 6379,
  graphName: 'localclaw_memory',   // same graph as facts — one memory, many node types
  embeddingDims: 4096,
};

/** KNN cosine-distance bands (mirroring the fact store's measured values). */
const DUPLICATE_DISTANCE = 0.15;     // closer than this = same experience → evidence bump
const CONTRADICTION_DISTANCE = 0.4;  // 0.15–0.4 + flipped verdict = SUPERSEDES

export class ExperienceStore {
  private db: FalkorDB | null = null;
  private graph: Graph | null = null;
  private initialized = false;

  constructor(
    private readonly client: OllamaClient,
    private readonly config: ExperienceStoreConfig = DEFAULT_CONFIG,
  ) {}

  async connect(): Promise<void> {
    if (this.db) return;
    this.db = await FalkorDB.connect({ socket: { host: this.config.host, port: this.config.port } });
    const db = this.db as unknown as { on?: (e: string, fn: (err: unknown) => void) => void; close?: () => Promise<void> };
    db.on?.('error', (err: unknown) => {
      console.warn('[Experience] Connection lost — degraded until reconnect:', err instanceof Error ? err.message : err);
      if (this.db === (db as unknown)) { this.db = null; this.graph = null; this.initialized = false; }
      try { void db.close?.(); } catch { /* dead */ }
    });
    this.graph = this.db.selectGraph(this.config.graphName);
    try {
      await this.graph.query(
        `CREATE VECTOR INDEX FOR (x:Experience) ON (x.embedding) OPTIONS {dimension: ${this.config.embeddingDims}, similarityFunction: 'cosine'}`,
      );
    } catch { /* index exists */ }
    this.initialized = true;
  }

  get connected(): boolean { return this.initialized && this.graph !== null; }

  private async ensure(): Promise<boolean> {
    if (this.connected) return true;
    try { await this.connect(); return true; } catch { return false; }
  }

  /**
   * Save with dedup + contradiction handling:
   * - near-duplicate (dist < 0.15) → evidence bump on the existing node
   *   (satisfaction upgraded when the new signal is stronger/explicit)
   * - similar but verdict flipped (0.15–0.4, outcome or satisfaction sign
   *   differs) → save new + SUPERSEDES old (code-decided, no LLM)
   * Returns {id, action}.
   */
  async save(input: Omit<Experience, 'id' | 'evidenceCount' | 'createdAt' | 'lastConfirmed'> & { evidenceCount?: number }, sourceSessionKey?: string): Promise<{ id: string; action: 'created' | 'reinforced' | 'superseded_old' } | null> {
    if (!(await this.ensure())) return null;
    const [embedding] = await this.client.embed(input.text);
    if (!embedding?.length) return null;
    const now = new Date().toISOString();

    const near = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Experience', 'embedding', 3, vecf32($emb)) YIELD node, score
       WHERE node.superseded IS NULL OR node.superseded = false
       RETURN node.id AS id, node.outcome AS outcome, node.satisfaction AS satisfaction, node.evidenceCount AS ev, score
       ORDER BY score ASC`,
      { params: { emb: embedding } },
    );
    const rows = (near.data ?? []) as Array<{ id: string; outcome: string; satisfaction: number; ev: number; score: number }>;

    // Duplicate → reinforce
    const dupe = rows.find(r => r.score < DUPLICATE_DISTANCE
      && r.outcome === input.outcome && Math.sign(r.satisfaction) === Math.sign(input.satisfaction));
    if (dupe) {
      await this.graph!.query(
        `MATCH (x:Experience {id: $id})
         SET x.evidenceCount = x.evidenceCount + $inc, x.lastConfirmed = $now,
             x.satisfaction = CASE WHEN abs($sat) > abs(x.satisfaction) THEN $sat ELSE x.satisfaction END`,
        { params: { id: dupe.id, inc: input.evidenceCount ?? 1, now, sat: input.satisfaction } },
      );
      return { id: dupe.id, action: 'reinforced' };
    }

    const id = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await this.graph!.query(
      `CREATE (x:Experience {id: $id, text: $text, taskShape: $taskShape, approach: $approach,
        outcome: $outcome, satisfaction: $satisfaction, evidenceCount: $ev, model: $model,
        createdAt: $now, lastConfirmed: $now, superseded: false, embedding: vecf32($emb)})`,
      { params: { id, text: input.text, taskShape: input.taskShape, approach: input.approach, outcome: input.outcome, satisfaction: input.satisfaction, ev: input.evidenceCount ?? 1, model: input.model, now, emb: embedding } },
    );

    // Provenance to the source session's most recent turn, when known
    if (sourceSessionKey) {
      try {
        await this.graph!.query(
          `MATCH (x:Experience {id: $id}), (t:Turn {sessionKey: $sk})
           WITH x, t ORDER BY t.createdAt DESC LIMIT 1
           CREATE (x)-[:EXTRACTED_FROM]->(t)`,
          { params: { id, sk: sourceSessionKey } },
        );
      } catch { /* provenance is best-effort */ }
    }

    // Contradiction → new node supersedes the flipped old one (pure code)
    const flipped = rows.find(r => r.score >= DUPLICATE_DISTANCE && r.score < CONTRADICTION_DISTANCE
      && (r.outcome !== input.outcome || (Math.sign(r.satisfaction) !== 0 && Math.sign(r.satisfaction) !== Math.sign(input.satisfaction))));
    if (flipped) {
      await this.graph!.query(
        `MATCH (n:Experience {id: $newId}), (o:Experience {id: $oldId})
         SET o.superseded = true
         CREATE (n)-[:SUPERSEDES {at: $now}]->(o)`,
        { params: { newId: id, oldId: flipped.id, now } },
      );
      return { id, action: 'superseded_old' };
    }
    return { id, action: 'created' };
  }

  /** KNN over live experiences; floor rejects, scoring orders (facts doctrine). */
  async searchRelevant(query: string, topK = 2, minSimilarity = 0.6): Promise<ExperienceMatch[]> {
    if (!(await this.ensure())) return [];
    try {
      const [embedding] = await this.client.embed(query);
      if (!embedding?.length) return [];
      const res = await this.graph!.query(
        `CALL db.idx.vector.queryNodes('Experience', 'embedding', $k, vecf32($emb)) YIELD node, score
         WHERE (node.superseded IS NULL OR node.superseded = false)
         RETURN node.id AS id, node.text AS text, node.taskShape AS taskShape, node.approach AS approach,
                node.outcome AS outcome, node.satisfaction AS satisfaction, node.evidenceCount AS evidenceCount,
                node.model AS model, node.createdAt AS createdAt, node.lastConfirmed AS lastConfirmed, score
         ORDER BY score ASC LIMIT $k`,
        { params: { emb: embedding, k: topK * 3 } },
      );
      return ((res.data ?? []) as Array<Record<string, unknown>>)
        .map(r => ({ ...(r as unknown as Experience), score: 1 - (r.score as number) }))
        .filter(m => m.score >= minSimilarity)
        .slice(0, topK);
    } catch (err) {
      console.warn('[Experience] search failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  async list(includeSuperseded = false): Promise<Experience[]> {
    if (!(await this.ensure())) return [];
    const res = await this.graph!.query(
      `MATCH (x:Experience) ${includeSuperseded ? '' : 'WHERE x.superseded IS NULL OR x.superseded = false'}
       RETURN x.id AS id, x.text AS text, x.taskShape AS taskShape, x.approach AS approach, x.outcome AS outcome,
              x.satisfaction AS satisfaction, x.evidenceCount AS evidenceCount, x.model AS model,
              x.createdAt AS createdAt, x.lastConfirmed AS lastConfirmed, x.superseded AS superseded
       ORDER BY x.lastConfirmed DESC`,
    );
    return (res.data ?? []) as Experience[];
  }

  async archive(id: string): Promise<boolean> {
    if (!(await this.ensure())) return false;
    const res = await this.graph!.query(
      `MATCH (x:Experience {id: $id}) SET x.superseded = true RETURN x.id`,
      { params: { id } },
    );
    return ((res.data ?? []) as unknown[]).length > 0;
  }

  async close(): Promise<void> {
    try { await (this.db as unknown as { close?: () => Promise<void> })?.close?.(); } catch { /* fine */ }
    this.db = null; this.graph = null; this.initialized = false;
  }
}

// Shared instance — dispatch priming and heartbeat synthesis must see the
// same store (mirrors the embeddingStore() singleton pattern)
let shared: ExperienceStore | null = null;
export function sharedExperienceStore(client: OllamaClient): ExperienceStore {
  if (!shared) shared = new ExperienceStore(client);
  return shared;
}
export function setExperienceStoreForTests(store: ExperienceStore | null): void {
  shared = store;
}
