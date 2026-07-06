import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateAutonomousActions, successRate, isPromotionCandidate, buildAutonomyReport } from '../../src/metrics/autonomy-report.js';

function writeMetrics(events: Array<Record<string, unknown>>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'metrics-')), 'metrics.jsonl');
  writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

const now = new Date().toISOString();
const evt = (action: string, outcome: string, tier = 'propose_confirm') => ({
  timestamp: now, type: 'autonomous_action', action, tier, source: 'test', reversible: true, outcome,
});

describe('autonomy report', () => {
  it('aggregates by action with outcome counts', () => {
    const path = writeMetrics([
      evt('cron_job_run', 'success', 'act_then_notify'),
      evt('cron_job_run', 'success', 'act_then_notify'),
      evt('cron_job_run', 'failure', 'act_then_notify'),
      evt('fact_review', 'confirmed'),
      { timestamp: now, type: 'dispatch', category: 'chat' }, // ignored
      'not json', // tolerated
    ] as any);
    const stats = aggregateAutonomousActions(path);
    expect(stats).toHaveLength(2);
    expect(stats[0].action).toBe('cron_job_run');
    expect(stats[0].outcomes).toEqual({ success: 2, failure: 1 });
  });

  it('successRate counts decided outcomes only', () => {
    const path = writeMetrics([
      evt('x', 'proposed'), evt('x', 'proposed'), evt('x', 'confirmed'), evt('x', 'rejected'),
    ]);
    const [stats] = aggregateAutonomousActions(path);
    expect(successRate(stats)).toBe(0.5); // 1 confirmed / 2 decided; proposals pending don't count
  });

  it('flags promotion candidates at ≥20 acts and ≥95% success', () => {
    const path = writeMetrics([
      ...Array(20).fill(evt('send', 'confirmed')),
      ...Array(5).fill(evt('small', 'confirmed')),
    ]);
    const stats = aggregateAutonomousActions(path);
    const send = stats.find(s => s.action === 'send')!;
    const small = stats.find(s => s.action === 'small')!;
    expect(isPromotionCandidate(send)).toBe(true);
    expect(isPromotionCandidate(small)).toBe(false); // volume too low
  });

  it('excludes events older than the window', () => {
    const old = { ...evt('ancient', 'success'), timestamp: new Date(Date.now() - 60 * 86_400_000).toISOString() };
    const path = writeMetrics([old, evt('recent', 'success')]);
    const stats = aggregateAutonomousActions(path, 30);
    expect(stats.map(s => s.action)).toEqual(['recent']);
  });

  it('builds a readable report and handles missing file', () => {
    const path = writeMetrics([evt('cron_job_run', 'failure', 'act_then_notify')]);
    const report = buildAutonomyReport(path);
    expect(report).toContain('cron_job_run');
    expect(report).toContain('last failure');
    expect(buildAutonomyReport('/nonexistent/metrics.jsonl')).toContain('no autonomous actions');
  });
});
