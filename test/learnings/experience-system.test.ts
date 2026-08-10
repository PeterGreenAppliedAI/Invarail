import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestExperienceCandidates } from '../../src/learnings/experience-harvester.js';

// ── Harvester: code detects, model explains ────────────────────────────────

function tempJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp-'));
  const p = join(dir, 'metrics.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const T0 = '2026-08-10T12:00:00.000Z';
const T1 = '2026-08-10T12:05:00.000Z';  // 5 min later — inside pairing window
const FAR = '2026-08-10T14:00:00.000Z'; // outside 15-min window

describe('experience harvester', () => {
  it('pairs a reaction with the nearest preceding execution (explicit = strength 2)', () => {
    const metrics = tempJsonl([
      { timestamp: T1, type: 'reaction', valence: -1, emoji: '👎', channel: 'discord', channelId: 'c', senderId: 'u' },
    ]);
    const execDir = mkdtempSync(join(tmpdir(), 'exp-'));
    const execPath = join(execDir, 'executions.jsonl');
    writeFileSync(execPath, JSON.stringify({ id: 'x1', task: 'make me an anime image', ts: T0, success: true, calls: [{ name: 'image_generate' }] }) + '\n');

    const { candidates } = harvestExperienceCandidates({ metricsPath: metrics, executionsPath: execPath, markerPath: join(mkdtempSync(join(tmpdir(), "mk-")), "m.json") });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      taskPreview: 'make me an anime image',
      calls: ['image_generate'],
      outcome: 'failed',
      valence: -1,
      signalKind: 'reaction',
      evidenceStrength: 2,
    });
  });

  it('does not pair a signal with an execution outside the window', () => {
    const metrics = tempJsonl([
      { timestamp: FAR, type: 'reaction', valence: 1, emoji: '👍', channel: 'discord', channelId: 'c', senderId: 'u' },
    ]);
    const execDir = mkdtempSync(join(tmpdir(), 'exp-'));
    const execPath = join(execDir, 'executions.jsonl');
    writeFileSync(execPath, JSON.stringify({ id: 'x1', task: 'old task', ts: T0, success: true, calls: [] }) + '\n');

    const { candidates } = harvestExperienceCandidates({ metricsPath: metrics, executionsPath: execPath, markerPath: join(mkdtempSync(join(tmpdir(), "mk-")), "m.json") });
    expect(candidates[0].taskPreview).toBe('');   // unpaired — no stale attribution
  });

  it('denials are explicit (strength 2); steering and review notes are inferred (strength 1)', () => {
    const metrics = tempJsonl([
      { timestamp: T1, type: 'autonomous_action', approval: 'rejected', outcome: 'rejected', action: 'denied:send_message', detail: 'send to X' },
      { timestamp: T1, type: 'steering', category: 'exec', messagePreview: 'no stop doing that' },
      { timestamp: T1, type: 'review_note', category: 'web_search', note: 'response ignored a tool error' },
    ]);
    const { candidates } = harvestExperienceCandidates({ metricsPath: metrics, executionsPath: "/nonexistent", markerPath: join(mkdtempSync(join(tmpdir(), "mk-")), "m.json") });
    const byKind = Object.fromEntries(candidates.map(c => [c.signalKind, c]));
    expect(byKind.deny.evidenceStrength).toBe(2);
    expect(byKind.steering.evidenceStrength).toBe(1);
    expect(byKind.review_note.evidenceStrength).toBe(1);
    for (const c of candidates) expect(c.valence).toBeLessThanOrEqual(0);
  });

  it('detects re-ask (negation) and praise patterns in recent turns', () => {
    const metrics = tempJsonl([]);
    const { candidates } = harvestExperienceCandidates({
      metricsPath: metrics,
      executionsPath: '/nonexistent',
      markerPath: join(mkdtempSync(join(tmpdir(), 'mk-')), 'm.json'),
      recentTurns: [
        { text: "no that's not what I wanted", role: 'user', createdAt: T1, sessionKey: 's1' },
        { text: 'thanks, perfect', role: 'user', createdAt: T1, sessionKey: 's2' },
        { text: 'what is the weather', role: 'user', createdAt: T1, sessionKey: 's3' },  // neutral — ignored
        { text: 'not sure I follow', role: 'assistant', createdAt: T1 },                  // assistant — ignored
      ],
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.find(c => c.signalKind === 'reask')?.valence).toBe(-1);
    expect(candidates.find(c => c.signalKind === 'praise')?.valence).toBe(1);
  });
});

// ── The authority boundary, structurally pinned ────────────────────────────

describe('authority boundary (experience informs, never expands authority)', () => {
  const roots = ['src/memory/experience-store.ts', 'src/learnings/experience-harvester.ts', 'src/learnings/experience-synthesis.ts'];

  it('experience modules import NOTHING from security/', () => {
    for (const p of roots) {
      const src = readFileSync(p, 'utf-8');
      expect(src).not.toMatch(/from '.*security\//);
    }
  });

  it('experience-store is consumed only by advisory surfaces (priming, heartbeat synthesis, !experiences command)', () => {
    const allowed = new Set([
      'src/dispatch.ts',                       // priming injection (plain text)
      'src/services/heartbeat-service.ts',     // synthesis step
      'src/learnings/experience-synthesis.ts', // writer
      'src/orchestrator.ts',                   // !experiences command
    ]);
    // Walk src/ for imports of experience-store
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync(`grep -rl "memory/experience-store" src/ || true`, { encoding: 'utf-8' })
      .split('\n').filter(Boolean).filter(f => f !== 'src/memory/experience-store.ts');
    for (const f of hits) {
      expect(allowed.has(f), `${f} imports experience-store — not an approved advisory surface`).toBe(true);
    }
  });

  it('no security module imports the experience layer', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync(`grep -rl "experience" src/security/ || true`, { encoding: 'utf-8' }).trim();
    expect(hits).toBe('');
  });
});

describe('pairing ignores continuation records', () => {
  it('a signal pairs with the real user task, not a nearer [SYSTEM] continuation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp-'));
    const metrics = join(dir, 'metrics.jsonl');
    const execs = join(dir, 'executions.jsonl');
    writeFileSync(metrics, JSON.stringify({ timestamp: '2026-08-10T16:59:00Z', type: 'reaction', valence: -1, emoji: '👎', channel: 'discord', channelId: 'c', senderId: 'u' }) + '\n');
    writeFileSync(execs, [
      JSON.stringify({ id: 'a', task: 'make me an image of a fox', ts: '2026-08-10T16:56:00Z', success: true, calls: [{ name: 'image_generate' }] }),
      JSON.stringify({ id: 'b', task: '[SYSTEM] The user approved and image_generate has now run', ts: '2026-08-10T16:58:00Z', success: true, calls: [{ name: 'read_file' }] }),
    ].join('\n') + '\n');
    const { candidates } = harvestExperienceCandidates({ metricsPath: metrics, executionsPath: execs, markerPath: join(mkdtempSync(join(tmpdir(), 'mk-')), 'm.json') });
    expect(candidates[0].taskPreview).toBe('make me an image of a fox');
    expect(candidates[0].calls).toEqual(['image_generate']);
  });
});

describe('explicit signals bypass the model veto', () => {
  // The model summarizes; it may not overrule the principal's direct judgment.
  // Pinned at the filter level: a strength-2 candidate with worth_keeping=false
  // from the model must still be kept (the filter logic, extracted inline here,
  // mirrors experience-synthesis.ts).
  it('strength-2 keeps despite worth_keeping=false; strength-1 respects the veto', () => {
    const filter = (s: { candidate: { evidenceStrength: 1 | 2 }; parsed: { taskShape?: string; approach?: string; worth_keeping?: boolean } }) =>
      Boolean(s.parsed.taskShape && s.parsed.approach
        && (s.candidate.evidenceStrength === 2 || s.parsed.worth_keeping === true));
    expect(filter({ candidate: { evidenceStrength: 2 }, parsed: { taskShape: 'x', approach: 'y', worth_keeping: false } })).toBe(true);
    expect(filter({ candidate: { evidenceStrength: 1 }, parsed: { taskShape: 'x', approach: 'y', worth_keeping: false } })).toBe(false);
    expect(filter({ candidate: { evidenceStrength: 1 }, parsed: { taskShape: 'x', approach: 'y', worth_keeping: true } })).toBe(true);
  });
});
