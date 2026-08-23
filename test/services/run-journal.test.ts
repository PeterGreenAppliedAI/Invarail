import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRunJournal, sweepInterruptedRuns } from '../../src/services/run-journal.js';

describe('run journal — crash-durable steps', () => {
  it('journal exists during the run, deleted on close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const j = startRunJournal('main', 'discord:123', 'do the thing', dir);
    j.step(0, 'web_search', 'found stuff');
    j.step(1, 'write_file', 'wrote it');
    expect(readdirSync(dir)).toHaveLength(1);
    j.close();
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('sweep turns a surviving journal into a transcript note and removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const j = startRunJournal('main', 'discord:456', 'compile the weekly report', dir);
    j.step(0, 'read_file', 'read csv');
    j.step(1, 'exec', 'computed');
    // no close() — simulated process death

    const appendTurn = vi.fn();
    const swept = sweepInterruptedRuns({ appendTurn }, dir);
    expect(swept).toBe(1);
    expect(appendTurn).toHaveBeenCalledWith('main', 'discord:456', expect.objectContaining({
      role: 'assistant',
      content: expect.stringContaining('interrupted by a restart after 2 tool step(s)'),
    }));
    expect(appendTurn.mock.calls[0][2].content).toContain('compile the weekly report');
    expect(readdirSync(dir)).toHaveLength(0); // journal consumed
    rmSync(dir, { recursive: true, force: true });
  });

  it('sweep of empty/missing dir is a no-op', () => {
    expect(sweepInterruptedRuns({ appendTurn: vi.fn() }, '/nonexistent-journal-dir-xyz')).toBe(0);
  });

  it('missing agent/session context → noop journal, no files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const j = startRunJournal(undefined, undefined, 'x', dir);
    j.step(0, 't', 'o');
    j.close();
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
