import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunRecord, listRunRecords, appendDeadLetter, listDeadLetters, scanArtifacts } from '../../src/cron/run-log.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runlog-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('run records + dead letters', () => {
  it('appends and reads back records', () => {
    const path = join(dir, 'runs.jsonl');
    appendRunRecord({ jobId: 'j1', runId: 'r1', name: 'Test', sessionKey: 'cron:j1:r1', startedAt: 'now', durationMs: 5, status: 'success', artifacts: [], resultPreview: 'ok' }, path);
    const records = listRunRecords(10, path);
    expect(records).toHaveLength(1);
    expect(records[0].sessionKey).toBe('cron:j1:r1');
  });

  it('caps at 200 records, keeping the newest', () => {
    const path = join(dir, 'dead.jsonl');
    for (let i = 0; i < 210; i++) {
      appendDeadLetter({ source: 'cron', detail: `job${i}`, error: 'boom' }, path);
    }
    const all = listDeadLetters(500, path);
    expect(all).toHaveLength(200);
    expect(all[all.length - 1].detail).toBe('job209');
    expect(all[0].detail).toBe('job10');
  });
});

describe('scanArtifacts', () => {
  it('finds only files with mtime inside the run window, skipping excluded dirs', () => {
    const before = Date.now() - 60_000;
    writeFileSync(join(dir, 'old-report.pdf'), 'x');
    utimesSync(join(dir, 'old-report.pdf'), new Date(before), new Date(before));

    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'facts.json'), 'x'); // excluded dir
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'new-report.pdf'), 'x');
    writeFileSync(join(dir, '.hidden'), 'x'); // dotfile skipped

    const artifacts = scanArtifacts(dir, Date.now() - 5_000);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toContain('new-report.pdf');
  });
});
