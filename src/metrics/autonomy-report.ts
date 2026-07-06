import { readFileSync } from 'node:fs';

/**
 * Autonomy promotion report — aggregates `autonomous_action` metric events
 * into a per-action-type track record. This is the evidence view for deciding
 * autoApproveTools promotions: an action type earns a higher ladder rung with
 * volume + success rate, never by vibes.
 */

interface AutonomousActionEvent {
  timestamp: string;
  type: string;
  action: string;
  tier: string;
  source: string;
  reversible: boolean;
  outcome: 'success' | 'failure' | 'proposed' | 'confirmed' | 'rejected';
  detail?: string;
}

interface ActionStats {
  action: string;
  tier: string;
  source: string;
  total: number;
  outcomes: Record<string, number>;
  lastFailure?: { detail: string; timestamp: string };
  firstSeen: string;
  lastSeen: string;
}

const PROMOTION_MIN_ACTS = 20;
const PROMOTION_MIN_SUCCESS_RATE = 0.95;

export function aggregateAutonomousActions(metricsPath = 'data/metrics.jsonl', sinceDays = 30): ActionStats[] {
  let lines: string[];
  try {
    lines = readFileSync(metricsPath, 'utf-8').split('\n').filter(l => l.trim());
  } catch {
    return [];
  }

  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const byAction = new Map<string, ActionStats>();

  for (const line of lines) {
    let event: AutonomousActionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'autonomous_action' || !event.action) continue;
    if (new Date(event.timestamp).getTime() < since) continue;

    let stats = byAction.get(event.action);
    if (!stats) {
      stats = { action: event.action, tier: event.tier, source: event.source, total: 0, outcomes: {}, firstSeen: event.timestamp, lastSeen: event.timestamp };
      byAction.set(event.action, stats);
    }
    stats.total++;
    stats.outcomes[event.outcome] = (stats.outcomes[event.outcome] ?? 0) + 1;
    stats.lastSeen = event.timestamp;
    if (event.outcome === 'failure' || event.outcome === 'rejected') {
      stats.lastFailure = { detail: event.detail ?? '(no detail)', timestamp: event.timestamp };
    }
  }

  return [...byAction.values()].sort((a, b) => b.total - a.total);
}

/** Success rate over decided outcomes (success+failure for acts; confirmed+rejected for proposals). */
export function successRate(stats: ActionStats): number | null {
  const good = (stats.outcomes.success ?? 0) + (stats.outcomes.confirmed ?? 0);
  const bad = (stats.outcomes.failure ?? 0) + (stats.outcomes.rejected ?? 0);
  const decided = good + bad;
  return decided === 0 ? null : good / decided;
}

/** Would this action type qualify for a promotion recommendation? */
export function isPromotionCandidate(stats: ActionStats): boolean {
  const rate = successRate(stats);
  return stats.tier === 'propose_confirm'
    && stats.total >= PROMOTION_MIN_ACTS
    && rate !== null
    && rate >= PROMOTION_MIN_SUCCESS_RATE;
}

export function buildAutonomyReport(metricsPath = 'data/metrics.jsonl', sinceDays = 30): string {
  const all = aggregateAutonomousActions(metricsPath, sinceDays);
  if (all.length === 0) {
    return `🪜 **Autonomy Report** — no autonomous actions recorded in the last ${sinceDays} days.`;
  }

  const lines = [`🪜 **Autonomy Report** (last ${sinceDays}d, ${all.reduce((s, a) => s + a.total, 0)} actions)`, ''];

  for (const stats of all) {
    const rate = successRate(stats);
    const rateText = rate === null ? 'no decided outcomes yet' : `${Math.round(rate * 100)}% success`;
    const outcomeBits = Object.entries(stats.outcomes).map(([k, v]) => `${v} ${k}`).join(', ');
    lines.push(`**${stats.action}** — \`${stats.tier}\` via ${stats.source}`);
    lines.push(`  ${stats.total} total (${outcomeBits}) · ${rateText}`);
    if (stats.lastFailure) {
      const ageDays = Math.floor((Date.now() - new Date(stats.lastFailure.timestamp).getTime()) / 86_400_000);
      lines.push(`  last failure ${ageDays}d ago: ${stats.lastFailure.detail.slice(0, 100)}`);
    }
    if (isPromotionCandidate(stats)) {
      lines.push(`  ⬆️ PROMOTION CANDIDATE — ${stats.total} acts at ≥95%: consider autoApproveTools for the underlying tool`);
    }
    lines.push('');
  }

  lines.push('_Promotion rule: propose_confirm actions with ≥20 decided outcomes at ≥95% success. Promote per channel via security.autoApproveTools._');
  return lines.join('\n');
}
