import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCalendarEvents,
  parsePrepAssessments,
  zonedDate,
  cronForDate,
  buildPrepSection,
} from '../../src/services/prep-proposals.js';
import { PendingActionStore } from '../../src/security/pending-actions.js';
import type { OllamaClient } from '../../src/ollama/client.js';

const TZ = 'America/New_York';
const NOW = new Date('2026-07-06T16:00:00.000Z'); // noon EDT, July 6

function mockClient(content: string): OllamaClient {
  return {
    chat: vi.fn().mockResolvedValue({ message: { role: 'assistant', content } }),
  } as unknown as OllamaClient;
}

let store: PendingActionStore;
beforeEach(() => {
  store = new PendingActionStore(join(mkdtempSync(join(tmpdir(), 'prep-')), 'pending.json'));
});

const CALENDAR = [
  '- **Q3 budget review** [TOMORROW] Tue, Jul 7 9:00 AM – 10:00 AM',
  '- **Meeting w/ John** [TOMORROW] Tue, Jul 7 2:00 PM – 3:00 PM',
  'Some non-event line',
].join('\n');

describe('zonedDate + cronForDate (timezone-correct, DST-aware)', () => {
  it('constructs wall-clock times in the target zone', () => {
    const summer = zonedDate(2026, 6, 7, 9, 0, TZ); // Jul 7, 9:00 AM EDT (UTC-4)
    expect(summer.toISOString()).toBe('2026-07-07T13:00:00.000Z');
    const winter = zonedDate(2026, 0, 7, 9, 0, TZ); // Jan 7, 9:00 AM EST (UTC-5)
    expect(winter.toISOString()).toBe('2026-01-07T14:00:00.000Z');
  });

  it('cron fields are expressed in the cron service timezone', () => {
    const when = new Date('2026-07-07T12:00:00.000Z'); // 8:00 AM EDT
    expect(cronForDate(when, TZ)).toBe('0 8 7 7 *');
  });
});

describe('parseCalendarEvents', () => {
  it('parses briefing-format lines into structured events with correct instants', () => {
    const events = parseCalendarEvents(CALENDAR, NOW, TZ);
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Q3 budget review');
    expect(events[0].index).toBe(1);
    expect(events[0].start.toISOString()).toBe('2026-07-07T13:00:00.000Z'); // 9AM EDT
    expect(events[1].start.toISOString()).toBe('2026-07-07T18:00:00.000Z'); // 2PM EDT
  });

  it('infers next year for dates that would be in the past', () => {
    const dec30 = new Date('2026-12-30T16:00:00.000Z');
    const events = parseCalendarEvents('- **NYD brunch** [in 2 days] Fri, Jan 1 11:00 AM – 12:00 PM', dec30, TZ);
    expect(events[0].start.getUTCFullYear()).toBe(2027);
  });

  it('skips unparseable lines', () => {
    expect(parseCalendarEvents('No events found.', NOW, TZ)).toEqual([]);
  });
});

describe('parsePrepAssessments (index-based, no model date math)', () => {
  it('accepts valid entries and enforces bounds', () => {
    const raw = JSON.stringify([
      { event: 1, action: 'reminder', reminder: { minutesBefore: 60, message: 'Budget at 9' } },
      { event: 2, action: 'question', question: 'What is it about?' },
      { event: 3, action: 'task', task: { title: 'out of range' } },      // eventCount=2 → dropped
      { event: 1, action: 'task', task: { title: 'duplicate event' } },    // dup event → dropped
      { event: 2, action: 'reminder', reminder: { minutesBefore: 3000, message: 'x' } }, // >24h → dropped
    ]);
    const parsed = parsePrepAssessments(raw, 2);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].action).toBe('reminder');
  });

  it('returns empty on prose-only output (the qwen timezone-rumination case)', () => {
    expect(parsePrepAssessments('Thinking Process:\n1. Analyze the request...', 2)).toEqual([]);
  });
});

describe('buildPrepSection', () => {
  const baseDeps = {
    model: 'test',
    calendar: CALENDAR,
    memory: 'Solo founder; under-prepares for budget meetings.',
    sender: 'peter',
    channel: 'telegram',
    target: 'owner-1',
    agentId: 'main',
    timeZone: TZ,
    now: NOW,
  };

  it('no parseable events → no model call', async () => {
    const client = mockClient('[]');
    const out = await buildPrepSection({ ...baseDeps, client, store, calendar: 'No events found' });
    expect(out).toBe('');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('reminder proposal: code computes fire time and one-shot cron in the config tz', async () => {
    const client = mockClient(JSON.stringify([
      { event: 1, action: 'reminder', reminder: { minutesBefore: 60, message: 'Budget review at 9 — bring numbers' } },
    ]));
    const section = await buildPrepSection({ ...baseDeps, client, store });
    const open = store.listFor('peter');
    expect(open).toHaveLength(1);
    // Event 9:00 AM EDT − 60m = 8:00 AM EDT on Jul 7
    expect(open[0].params.schedule).toBe('0 8 7 7 *');
    expect(open[0].params.once).toBe(true);
    expect(section).toContain(`confirm ${open[0].id}`);
  });

  it('questions render without ledger entries; out-of-range reminders rejected', async () => {
    const client = mockClient(JSON.stringify([
      { event: 2, action: 'question', question: 'What should I prep?' },
      { event: 1, action: 'reminder', reminder: { minutesBefore: 1440, message: 'way before now' } }, // fire < now → rejected in materialize
    ]));
    const section = await buildPrepSection({ ...baseDeps, client, store });
    expect(section).toContain('What should I prep?');
    expect(store.listFor('peter')).toHaveLength(0);
  });

  it('does not duplicate an open proposal for the same event', async () => {
    const payload = JSON.stringify([
      { event: 1, action: 'reminder', reminder: { minutesBefore: 60, message: 'Budget' } },
    ]);
    await buildPrepSection({ ...baseDeps, client: mockClient(payload), store });
    await buildPrepSection({ ...baseDeps, client: mockClient(payload), store });
    expect(store.listFor('peter')).toHaveLength(1);
  });

  it('survives model failure by returning empty', async () => {
    const client = { chat: vi.fn().mockRejectedValue(new Error('down')) } as unknown as OllamaClient;
    expect(await buildPrepSection({ ...baseDeps, client, store })).toBe('');
  });
});
