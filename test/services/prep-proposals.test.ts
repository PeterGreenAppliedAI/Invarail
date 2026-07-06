import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrepAssessments, isoToOneShotCron, buildPrepSection } from '../../src/services/prep-proposals.js';
import { PendingActionStore } from '../../src/security/pending-actions.js';
import type { OllamaClient } from '../../src/ollama/client.js';

function mockClient(content: string): OllamaClient {
  return {
    chat: vi.fn().mockResolvedValue({ message: { role: 'assistant', content } }),
  } as unknown as OllamaClient;
}

let store: PendingActionStore;
beforeEach(() => {
  store = new PendingActionStore(join(mkdtempSync(join(tmpdir(), 'prep-')), 'pending.json'));
});

describe('parsePrepAssessments', () => {
  it('parses valid assessments and drops invalid/none entries', () => {
    const raw = JSON.stringify([
      { event: 'Meeting w/ John', action: 'question', question: 'What is it about?' },
      { event: 'Q3 review', action: 'reminder', reminder: { whenISO: '2026-07-07T08:00:00-04:00', message: 'Review starts at 9' } },
      { event: 'Lunch', action: 'none' },
      { event: 'Bad', action: 'reminder' }, // missing reminder payload
      { event: 'Worse', action: 'explode' }, // invalid action
    ]);
    const parsed = parsePrepAssessments(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].action).toBe('question');
    expect(parsed[1].action).toBe('reminder');
  });

  it('tolerates surrounding prose and think tags', () => {
    const raw = '<think>hmm</think>Here you go:\n[{"event":"X","action":"task","task":{"title":"Prep slides"}}]';
    expect(parsePrepAssessments(raw)).toHaveLength(1);
  });

  it('returns empty on garbage', () => {
    expect(parsePrepAssessments('no json here')).toEqual([]);
  });
});

describe('isoToOneShotCron', () => {
  const now = new Date('2026-07-06T12:00:00-04:00');

  it('converts a future time to a one-shot cron expression', () => {
    const when = new Date('2026-07-07T08:30:00-04:00');
    expect(isoToOneShotCron(when.toISOString(), now)).toBe(`${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`);
  });

  it('rejects past times, near-now times, and far-future times', () => {
    expect(isoToOneShotCron('2026-07-05T08:00:00-04:00', now)).toBeNull(); // past
    expect(isoToOneShotCron(now.toISOString(), now)).toBeNull(); // now
    expect(isoToOneShotCron('2026-12-25T08:00:00-04:00', now)).toBeNull(); // >60d
    expect(isoToOneShotCron('not a date', now)).toBeNull();
  });
});

describe('buildPrepSection', () => {
  const baseDeps = {
    model: 'test',
    calendar: '- **Meeting w/ John** [TOMORROW] 2:00 PM',
    memory: 'The user works at DevMesh.',
    sender: 'owner-1',
    channel: 'telegram',
    target: 'owner-1',
    agentId: 'main',
    now: new Date('2026-07-06T12:00:00-04:00'),
  };

  it('returns empty for an empty calendar without calling the model', async () => {
    const client = mockClient('[]');
    const section = await buildPrepSection({ ...baseDeps, client, store, calendar: 'No events found' });
    expect(section).toBe('');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('renders questions without creating ledger entries', async () => {
    const client = mockClient(JSON.stringify([
      { event: 'Meeting w/ John', action: 'question', question: 'What should I prep?' },
    ]));
    const section = await buildPrepSection({ ...baseDeps, client, store });
    expect(section).toContain('What should I prep?');
    expect(store.listFor('owner-1')).toHaveLength(0);
  });

  it('records confirmable ledger entries for reminders with code-built cron params', async () => {
    const client = mockClient(JSON.stringify([
      { event: 'Q3 review', action: 'reminder', reminder: { whenISO: '2026-07-07T08:00:00-04:00', message: 'Review at 9am — bring numbers' } },
    ]));
    const section = await buildPrepSection({ ...baseDeps, client, store });
    const open = store.listFor('owner-1');
    expect(open).toHaveLength(1);
    expect(open[0].tool).toBe('cron_add');
    expect(open[0].params.schedule).toMatch(/^\d+ \d+ \d+ \d+ \*$/);
    expect(open[0].params.category).toBe('chat');
    expect(open[0].params.once).toBe(true); // one-shot — must not fire again next year
    expect(section).toContain(`confirm ${open[0].id}`);
  });

  it('rejects reminders with past times instead of proposing them', async () => {
    const client = mockClient(JSON.stringify([
      { event: 'Old thing', action: 'reminder', reminder: { whenISO: '2020-01-01T08:00:00-04:00', message: 'too late' } },
    ]));
    const section = await buildPrepSection({ ...baseDeps, client, store });
    expect(section).toBe('');
    expect(store.listFor('owner-1')).toHaveLength(0);
  });

  it('does not duplicate an open proposal for the same event', async () => {
    const payload = JSON.stringify([
      { event: 'Q3 review', action: 'reminder', reminder: { whenISO: '2026-07-07T08:00:00-04:00', message: 'Review' } },
    ]);
    await buildPrepSection({ ...baseDeps, client: mockClient(payload), store });
    await buildPrepSection({ ...baseDeps, client: mockClient(payload), store });
    expect(store.listFor('owner-1')).toHaveLength(1);
  });

  it('survives model failure by returning empty', async () => {
    const client = { chat: vi.fn().mockRejectedValue(new Error('down')) } as unknown as OllamaClient;
    const section = await buildPrepSection({ ...baseDeps, client, store });
    expect(section).toBe('');
  });
});
