import { appendFileSync } from 'node:fs';

/**
 * Emitters for FlowMCP's v0.6 open log contracts. Two feeds:
 *  - registry-log.jsonl `signal` records: consumer-side staleness observations
 *    (the free tier under shadow replay — persistent same-lens signals across
 *    runs are the upstream recompile-nomination trigger)
 *  - executions.jsonl (detection contract): one record per tool-using dispatch,
 *    input for upstream flow nomination (detect.ts)
 * Appends are never fatal — a feed bug must not affect the dispatch it observes.
 */

const tokenize = (s: string): Set<string> =>
  new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/**
 * Map gap-check supplementary queries to the flow's facet names. Queries vary
 * in wording run to run; facet names come from the flow's fixed sections, so
 * they are stable across runs — which is what makes upstream persistence
 * detection work. Falls back to the raw query when nothing overlaps.
 */
export function mapQueriesToLenses(queries: string[], facetAngles: string[]): string[] {
  const lenses: string[] = [];
  for (const q of queries) {
    const qTokens = tokenize(q);
    let best: { angle: string; overlap: number } | null = null;
    for (const angle of facetAngles) {
      let overlap = 0;
      for (const t of tokenize(angle)) if (qTokens.has(t)) overlap++;
      if (overlap > (best?.overlap ?? 0)) best = { angle, overlap };
    }
    const lens = best && best.overlap > 0 ? best.angle : q;
    if (!lenses.includes(lens)) lenses.push(lens);
  }
  return lenses;
}

/** Append a {kind:'signal'} record to a FlowMCP registry-log.jsonl. */
export function appendGatherSignal(logPath: string, flow: string, lenses: string[]): void {
  try {
    const record = { ts: new Date().toISOString(), flow, kind: 'signal', source: 'gap_check', lenses };
    appendFileSync(logPath, JSON.stringify(record) + '\n');
    console.log(`[RegistryFeed] Signal → ${flow}: lenses [${lenses.join(', ')}]`);
  } catch (err) {
    console.warn('[RegistryFeed] Signal append failed:', err instanceof Error ? err.message : err);
  }
}

export interface ExecutionRecord {
  id: string;
  task: string;
  agent: string;
  ts: string;
  success: boolean;
  tokens: number;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

/** Append a detection-contract execution record for upstream flow nomination. */
export function appendExecutionRecord(logPath: string, record: ExecutionRecord): void {
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('[RegistryFeed] Execution append failed:', err instanceof Error ? err.message : err);
  }
}
