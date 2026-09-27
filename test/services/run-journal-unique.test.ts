import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRunJournal } from '../../src/services/run-journal.js';

afterEach(() => vi.useRealTimers());

// Re-review N05: `channel:a` and `channel/a` normalized to the same name; in the same
// millisecond they shared one file and closing one run unlinked the other's journal.
describe('run journal filenames are unique', () => {
  it('colliding identifiers in the same millisecond get separate files, and closing one leaves the other', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const a = startRunJournal('main', 'channel:a', 'hello', dir);
    const b = startRunJournal('main', 'channel/a', 'hello', dir);
    expect(readdirSync(dir)).toHaveLength(2);
    a.close();
    expect(readdirSync(dir)).toHaveLength(1);
    b.close();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
