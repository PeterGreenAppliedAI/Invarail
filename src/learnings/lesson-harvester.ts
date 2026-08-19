import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Code-driven failure-candidate detection — the "code detects" half of the
 * lesson system. Reads evidence that already exists on disk (metrics.jsonl,
 * unrouted.jsonl); NO model involvement and NO model self-assessment. The
 * synthesis model only ever sees what this harvester surfaces.
 */

export interface LessonCandidate {
  kind: 'max_iterations' | 'tool_failures' | 'repair_cluster' | 'action_rejected' | 'dead_letter' | 'pi_session_failed';
  /** Tool involved, when tool-scoped */
  tool?: string;
  /** Model observed failing (tool_call.category carries the model id) */
  model?: string;
  /** Router category for dispatch-level candidates */
  routeCategory?: string;
  count: number;
  /** Error messages / outcome details (max 3) */
  examples: string[];
  /** Request previews — the SHAPE of what the user asked for (max 3) */
  contexts: string[];
}

interface HarvestMarker {
  lastTimestamp: string;
}

const MAX_CANDIDATES = 6;
const TOOL_FAILURE_THRESHOLD = 3;   // matches the LEARNINGS.md promotion bar
const REPAIR_CLUSTER_THRESHOLD = 3;

function readJsonl(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
      })
      .filter((r): r is Record<string, unknown> => r !== null);
  } catch {
    return [];
  }
}

export function loadHarvestMarker(markerPath: string): string {
  try {
    return (JSON.parse(readFileSync(markerPath, 'utf-8')) as HarvestMarker).lastTimestamp ?? '';
  } catch {
    return '';
  }
}

export function saveHarvestMarker(markerPath: string, lastTimestamp: string): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ lastTimestamp } satisfies HarvestMarker, null, 2));
  } catch (err) {
    console.warn('[Lessons] Marker save failed:', err instanceof Error ? err.message : err);
  }
}

export interface HarvestResult {
  candidates: LessonCandidate[];
  /** Newest event timestamp seen — write to the marker AFTER synthesis succeeds */
  newestTimestamp: string;
}

export function harvestLessonCandidates(opts: {
  metricsPath?: string;
  deadLetterPath?: string;
  sinceTimestamp: string;
}): HarvestResult {
  const metricsPath = opts.metricsPath ?? 'data/metrics.jsonl';
  const deadLetterPath = opts.deadLetterPath ?? 'data/unrouted.jsonl';
  const since = opts.sinceTimestamp;

  const events = readJsonl(metricsPath).filter(e => typeof e.timestamp === 'string' && (e.timestamp as string) > since);
  let newest = since;
  for (const e of events) {
    if ((e.timestamp as string) > newest) newest = e.timestamp as string;
  }

  const candidates: LessonCandidate[] = [];

  // 1. Dispatches that exhausted the iteration budget — grouped by router category
  const maxIter = new Map<string, { count: number; contexts: string[] }>();
  for (const e of events) {
    if (e.type === 'dispatch' && e.hitMaxIterations === true) {
      const key = String(e.category ?? 'unknown');
      const g = maxIter.get(key) ?? { count: 0, contexts: [] };
      g.count++;
      if (typeof e.messagePreview === 'string' && g.contexts.length < 3) g.contexts.push(e.messagePreview);
      maxIter.set(key, g);
    }
  }
  for (const [category, g] of maxIter) {
    candidates.push({ kind: 'max_iterations', routeCategory: category, count: g.count, examples: [`hit max iterations (${g.count}x)`], contexts: g.contexts });
  }

  // 2. Repeated tool failures — same grouping + threshold as LEARNINGS.md promotion
  const toolFails = new Map<string, { tool: string; model?: string; count: number; examples: string[] }>();
  for (const e of events) {
    if (e.type === 'tool_call' && e.success === false && typeof e.tool === 'string') {
      const error = String(e.error ?? '');
      const key = `${e.tool}:${error.slice(0, 60).toLowerCase()}`;
      const g = toolFails.get(key) ?? { tool: e.tool, model: typeof e.category === 'string' ? e.category : undefined, count: 0, examples: [] };
      g.count++;
      if (g.examples.length < 3 && error) g.examples.push(error.slice(0, 200));
      toolFails.set(key, g);
    }
  }
  for (const g of toolFails.values()) {
    if (g.count >= TOOL_FAILURE_THRESHOLD) {
      candidates.push({ kind: 'tool_failures', tool: g.tool, model: g.model, count: g.count, examples: g.examples, contexts: [] });
    }
  }

  // 3. Narration-repair clusters — a model repeatedly failing the calling convention
  const repairs = new Map<string, { count: number; model?: string }>();
  for (const e of events) {
    if (e.type === 'narration_repair' && typeof e.toolName === 'string') {
      const g = repairs.get(e.toolName) ?? { count: 0, model: typeof e.category === 'string' ? e.category : undefined };
      g.count++;
      repairs.set(e.toolName, g);
    }
  }
  for (const [tool, g] of repairs) {
    if (g.count >= REPAIR_CLUSTER_THRESHOLD) {
      candidates.push({ kind: 'repair_cluster', tool, model: g.model, count: g.count, examples: [`narration repairs (${g.count}x)`], contexts: [] });
    }
  }

  // 4. Explicit user rejections + autonomous failures — a human said no, or an
  //    autonomous act broke; both are meaningful at count 1
  for (const e of events) {
    if (e.type === 'autonomous_action' && (e.outcome === 'rejected' || e.outcome === 'failure')) {
      candidates.push({
        kind: 'action_rejected',
        count: 1,
        examples: [`${String(e.action ?? 'action')} → ${String(e.outcome)}`],
        contexts: typeof e.detail === 'string' ? [e.detail.slice(0, 200)] : [],
      });
    }
  }

  // 5. Failed Pi coding sessions (self-mod AND builds) — authority-grade at count 1.
  //    Error context enriched from the session JSONL when available (the transcript is
  //    the provenance bottom; the metric row only knows ok/timedOut).
  for (const e of events) {
    if (e.type === 'pi_session' && (e.ok === false || e.timedOut === true)) {
      const examples: string[] = [];
      if (e.timedOut === true) examples.push('session timed out');
      if (typeof e.error === 'string' && e.error) examples.push(e.error.slice(0, 200));
      const jsonlError = typeof e.sessionFile === 'string' ? extractPiFailureContext(e.sessionFile) : '';
      if (jsonlError) examples.push(jsonlError);
      candidates.push({
        kind: 'pi_session_failed',
        model: typeof e.model === 'string' ? e.model : undefined,
        count: 1,
        examples: examples.slice(0, 3),
        contexts: typeof e.slug === 'string' ? [String(e.slug)] : [],
      });
    }
  }

  // 6. Dead letters — background work that exhausted retries
  const deadLetters = readJsonl(deadLetterPath).filter(d => typeof d.at === 'string' && (d.at as string) > since);
  for (const d of deadLetters) {
    if ((d.at as string) > newest) newest = d.at as string;
    candidates.push({
      kind: 'dead_letter',
      count: 1,
      examples: [String(d.error ?? '').slice(0, 200)],
      contexts: [`[${String(d.source ?? '?')}] ${String(d.detail ?? '')}`],
    });
  }

  // Authority beats frequency: a count-1 rollback or failed Pi session is orders of
  // magnitude more informative than 30 generic tool timeouts — severity ranks first,
  // count breaks ties. Bounded: the synthesis model sees at most 6.
  const severity = (c: LessonCandidate): number =>
    c.kind === 'action_rejected' || c.kind === 'pi_session_failed' ? 3
    : c.kind === 'dead_letter' ? 2
    : 1;
  candidates.sort((a, b) => severity(b) - severity(a) || b.count - a.count);
  return { candidates: candidates.slice(0, MAX_CANDIDATES), newestTimestamp: newest };
}

/**
 * Best-effort tail-parse of a Pi session JSONL for the last error text. Defensive by
 * design: the format belongs to the SDK — any surprise shape returns '' rather than
 * breaking the harvest.
 */
export function extractPiFailureContext(sessionFile: string): string {
  try {
    if (!existsSync(sessionFile)) return '';
    const lines = readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean).slice(-50);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"isError":true') && !lines[i].includes('"isError": true')) continue;
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        const texts: string[] = [];
        // Recurse everywhere; COLLECT only at text-ish keys (ids/roles/paths stay out).
        const walk = (v: unknown, key?: string): void => {
          if (typeof v === 'string') {
            if ((key === 'text' || key === 'error' || key === 'output') && v.trim()) texts.push(v);
            return;
          }
          if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
          if (v && typeof v === 'object') {
            for (const [k, val] of Object.entries(v)) walk(val, k);
          }
        };
        walk(entry);
        const text = texts.join(' ').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 200);
      } catch { /* malformed line — keep scanning */ }
    }
    return '';
  } catch {
    return '';
  }
}

export function defaultMarkerPath(workspacePath: string): string {
  return join(workspacePath, '.learnings', 'last-harvest.json');
}
