import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const METRICS_PATH = 'data/metrics.jsonl';

export interface MetricEvent {
  timestamp: string;
  type: string;
  category?: string;
  [key: string]: unknown;
}

let initialized = false;

function ensureDir(): void {
  if (!initialized) {
    mkdirSync(dirname(METRICS_PATH), { recursive: true });
    initialized = true;
  }
}

export function logMetric(event: MetricEvent): void {
  // Unit tests exercising metric-emitting code paths must not pollute the
  // real metrics file (found: test events in production autonomy stats)
  if (process.env.VITEST) return;
  ensureDir();
  try {
    appendFileSync(METRICS_PATH, JSON.stringify(event) + '\n');
  } catch {
    // Non-critical — don't crash on metrics failure
  }
}

/** Log a dispatch cycle with timing and outcome */
export function logDispatch(data: {
  category: string;
  confidence: string;
  iterations: number;
  hitMaxIterations: boolean;
  durationMs: number;
  toolCalls?: string[];
  repairUsed?: boolean;
  abortReason?: string;
  /** First 120 chars of the user request — gives lesson harvesting the
   *  REQUEST SHAPE behind a failure, not just the failure */
  messagePreview?: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'dispatch',
    ...data,
  });
}

/** Log a tool execution */
export function logToolCall(data: {
  tool: string;
  category: string;
  durationMs: number;
  success: boolean;
  error?: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'tool_call',
    ...data,
  });
}

/** Log a narration repair (model narrated instead of using tool_calls) */
export function logRepair(data: {
  category: string;
  format: 'xml' | 'action' | 'repair_prompt';
  toolName: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'narration_repair',
    ...data,
  });
}

/** Log a router classification */
export function logRouterClassification(data: {
  category: string;
  confidence: string;
  durationMs: number;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'router',
    ...data,
  });
}

/**
 * Log an action the system took (or proposed) on its own initiative.
 * This is the track record the autonomy ladder promotes against: an action
 * type only moves up (propose→notify→silent) with a history of good outcomes.
 */
export function logAutonomousAction(data: {
  /** What was done, e.g. "task_auto_complete", "stale_fact_proposed", "cron_job_run" */
  action: string;
  /** Ladder rung this action executed at */
  tier: 'silent' | 'act_then_notify' | 'propose_confirm';
  /** What triggered it, e.g. "heartbeat", "cron", "briefing" */
  source: string;
  /** Whether the action can be undone */
  reversible: boolean;
  outcome: 'success' | 'failure' | 'proposed' | 'confirmed' | 'rejected';
  /** Short human-readable detail (task title, fact text, job name) */
  detail?: string;
  /** How the action was authorized — makes promotion evidence queryable:
   *  'auto' (silent/notify tier), 'granted' (standing grant / reply-origin),
   *  'confirmed' / 'rejected' (explicit user decision) */
  approval?: 'auto' | 'granted' | 'confirmed' | 'rejected';
  /** Grep-able external object the action touched (send target, url, job id) */
  resource?: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'autonomous_action',
    ...data,
  });
}

/** Explicit user-satisfaction signal (emoji reaction on a bot reply).
 *  Strongest ground truth the experience layer has — code-detected, zero
 *  inference. Correlated to the preceding dispatch at harvest time. */
export function logReaction(data: {
  valence: 1 | -1;
  emoji: string;
  channel: string;
  channelId: string;
  senderId: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'reaction',
    ...data,
  });
}

/** Mid-turn user steering — the user interrupting a run is a correction
 *  signal for the experience layer (steering is never praise). */
export function logSteering(data: { category: string; messagePreview: string }): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'steering',
    ...data,
  });
}

/** Post-task review note — the reviewer model flagged a quality issue with a
 *  delivered answer. Inferred (weak) dissatisfaction evidence. */
export function logReviewNote(data: { category: string; note: string }): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'review_note',
    ...data,
  });
}
