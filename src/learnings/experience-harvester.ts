import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Code-driven candidate detection for the experience layer. CODE DETECTS,
 * MODEL EXPLAINS: candidates come only from evidence on disk — satisfaction
 * signals (reactions, steering, denials, review notes, re-ask patterns) paired
 * with the dispatches/executions they judge. Model self-assessment never
 * creates a candidate.
 *
 * Pairing is by timestamp window (single-principal system — the nearest
 * preceding task within WINDOW_MS is the one being judged). Marker file
 * prevents re-harvest, mirroring lesson-harvester.
 */

export interface ExperienceCandidate {
  taskPreview: string;
  calls: string[];                 // ordered tool names, when an execution record matched
  outcome: 'worked' | 'failed';
  valence: -1 | 0 | 1;
  signalKind: 'reaction' | 'steering' | 'review_note' | 'deny' | 'confirm_failure' | 'reask' | 'praise';
  evidenceStrength: 1 | 2;         // explicit signals = 2 (inject immediately), inferred = 1
  ts: string;
  sessionKey?: string;
}

const MARKER_PATH = '.learnings/last-experience-harvest.json';
const WINDOW_MS = 15 * 60 * 1000;

const NEGATION_RE = /^(no\b|not\b|stop\b|wrong\b|that'?s not|nope\b|ugh\b|bad\b|terrible\b|don'?t\b)/i;
const PRAISE_RE = /^(thanks|thank you|perfect|love (it|this)|great|nice|awesome|exactly)\b/i;

interface MetricEvent { timestamp: string; type: string; [k: string]: unknown }
interface ExecutionRecord { id: string; task: string; ts: string; success: boolean; calls: Array<{ name: string }> }
export interface TurnLike { text: string; role: string; sessionKey?: string; createdAt?: string }

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip */ }
  }
  return out;
}

function loadMarker(): number {
  try { return Date.parse(JSON.parse(readFileSync(MARKER_PATH, 'utf-8')).lastTimestamp) || 0; } catch { return 0; }
}

export function advanceMarker(toIso: string): void {
  try { writeFileSync(MARKER_PATH, JSON.stringify({ lastTimestamp: toIso })); } catch { /* non-fatal */ }
}

/** Nearest preceding execution within the window — the task the signal judges. */
function pairTask(signalTs: number, executions: ExecutionRecord[]): ExecutionRecord | undefined {
  let best: ExecutionRecord | undefined;
  for (const e of executions) {
    const t = Date.parse(e.ts);
    if (t <= signalTs && signalTs - t <= WINDOW_MS && (!best || t > Date.parse(best.ts))) best = e;
  }
  return best;
}

export function harvestExperienceCandidates(opts: {
  metricsPath?: string;
  executionsPath?: string;
  recentTurns?: TurnLike[];        // optional transcript window for re-ask/praise heuristics
  now?: number;
}): { candidates: ExperienceCandidate[]; latestTs: string | null } {
  const since = loadMarker();
  const metrics = readJsonl<MetricEvent>(opts.metricsPath ?? 'data/metrics.jsonl')
    .filter(e => Date.parse(e.timestamp) > since);
  const executions = readJsonl<ExecutionRecord>(opts.executionsPath ?? 'data/executions.jsonl');

  const candidates: ExperienceCandidate[] = [];
  let latest = 0;

  const push = (c: ExperienceCandidate) => { candidates.push(c); };

  for (const e of metrics) {
    const ts = Date.parse(e.timestamp);
    if (ts > latest) latest = ts;
    const paired = pairTask(ts, executions);
    const base = {
      taskPreview: paired?.task ?? '',
      calls: paired?.calls?.map(c => c.name) ?? [],
      ts: e.timestamp,
    };

    if (e.type === 'reaction' && (e.valence === 1 || e.valence === -1)) {
      push({ ...base, outcome: e.valence === 1 ? 'worked' : 'failed', valence: e.valence, signalKind: 'reaction', evidenceStrength: 2 });
    } else if (e.type === 'steering') {
      push({ ...base, taskPreview: base.taskPreview || String(e.messagePreview ?? ''), outcome: 'failed', valence: -1, signalKind: 'steering', evidenceStrength: 1 });
    } else if (e.type === 'review_note') {
      push({ ...base, taskPreview: base.taskPreview || String(e.note ?? ''), outcome: 'failed', valence: -1, signalKind: 'review_note', evidenceStrength: 1 });
    } else if (e.type === 'autonomous_action' && e.approval === 'rejected') {
      push({ ...base, taskPreview: base.taskPreview || String(e.detail ?? ''), outcome: 'failed', valence: -1, signalKind: 'deny', evidenceStrength: 2 });
    } else if (e.type === 'autonomous_action' && e.approval === 'confirmed' && e.outcome === 'failure') {
      push({ ...base, taskPreview: base.taskPreview || String(e.detail ?? ''), outcome: 'failed', valence: 0, signalKind: 'confirm_failure', evidenceStrength: 1 });
    }
  }

  // Transcript heuristics: a user turn matching negation/praise shortly after
  // an assistant turn judges the preceding exchange
  for (const t of opts.recentTurns ?? []) {
    if (t.role !== 'user' || !t.createdAt) continue;
    const ts = Date.parse(t.createdAt);
    if (ts <= since) continue;
    if (ts > latest) latest = ts;
    const neg = NEGATION_RE.test(t.text.trim());
    const pos = PRAISE_RE.test(t.text.trim());
    if (!neg && !pos) continue;
    const paired = pairTask(ts, executions);
    push({
      taskPreview: paired?.task ?? t.text.slice(0, 100),
      calls: paired?.calls?.map(c => c.name) ?? [],
      outcome: neg ? 'failed' : 'worked',
      valence: neg ? -1 : 1,
      signalKind: neg ? 'reask' : 'praise',
      evidenceStrength: 1,
      ts: t.createdAt,
      sessionKey: t.sessionKey,
    });
  }

  return { candidates, latestTs: latest ? new Date(latest).toISOString() : null };
}
