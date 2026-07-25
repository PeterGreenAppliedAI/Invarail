import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Cron run records + dead-letter store — the auditable trail behind
 * autonomous runs. Both are capped JSONL files: visibility surfaces,
 * not queues.
 */

export interface CronRunRecord {
  jobId: string;
  runId: string;
  name: string;
  sessionKey: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'failure';
  /** Files the run left in the workspace (mtime inside the run window) — code-driven deliverable capture */
  artifacts: string[];
  resultPreview: string;
}

export interface DeadLetter {
  at: string;
  source: string;   // 'cron' | 'heartbeat' | ...
  detail: string;   // job/task name
  error: string;
}

const RUN_LOG_PATH = 'data/cron-runs.jsonl';
const DEAD_LETTER_PATH = 'data/unrouted.jsonl';
const MAX_RECORDS = 200;

function appendCapped(path: string, record: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    let lines: string[] = [];
    try {
      lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    } catch { /* first write */ }
    lines.push(JSON.stringify(record));
    if (lines.length > MAX_RECORDS) lines = lines.slice(-MAX_RECORDS);
    writeFileSync(path, `${lines.join('\n')}\n`);
  } catch (err) {
    console.warn('[RunLog] Append failed:', err instanceof Error ? err.message : err);
  }
}

function readCapped<T>(path: string, limit: number): T[] {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(l => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export function appendRunRecord(record: CronRunRecord, path = RUN_LOG_PATH): void {
  appendCapped(path, record);
}

export function listRunRecords(limit = 20, path = RUN_LOG_PATH): CronRunRecord[] {
  return readCapped<CronRunRecord>(path, limit);
}

export function appendDeadLetter(entry: Omit<DeadLetter, 'at'>, path = DEAD_LETTER_PATH): void {
  appendCapped(path, { at: new Date().toISOString(), ...entry });
}

export function listDeadLetters(limit = 20, path = DEAD_LETTER_PATH): DeadLetter[] {
  return readCapped<DeadLetter>(path, limit);
}

const ARTIFACT_EXCLUDED_DIRS = new Set(['memory', 'skills', 'sessions', 'node_modules']);
const MAX_ARTIFACTS = 20;
const MAX_SCAN_DEPTH = 3;

/** Files under the workspace whose mtime falls inside the run window —
 *  pure code, no model claims about what was "produced".
 *  NOTE: mtimeMs carries sub-ms precision and can sit FRACTIONALLY AHEAD of
 *  Date.now() (measured -0.66ms) — the until-bound is padded so a file
 *  written the same instant as the scan isn't dropped. */
export function scanArtifacts(workspacePath: string, sinceMs: number, untilMs = Date.now() + 1000): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_ARTIFACTS) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_ARTIFACTS) return;
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ARTIFACT_EXCLUDED_DIRS.has(entry)) walk(full, depth + 1);
      } else if (stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) {
        found.push(full);
      }
    }
  };
  walk(workspacePath, 0);
  return found;
}
