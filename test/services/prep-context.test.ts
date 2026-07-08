import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrepContextStore, eventKeyFor, captureBriefingAnswer } from '../../src/services/prep-context.js';
import type { OllamaClient } from '../../src/ollama/client.js';

const TZ = 'America/New_York';
const NOW = new Date('2026-07-08T12:00:00.000Z'); // 8am EDT July 8

let store: PrepContextStore;
beforeEach(() => {
  store = new PrepContextStore(join(mkdtempSync(join(tmpdir(), 'prepctx-')), 'prep-context.json'));
});

const david = { title: '30 min with David', start: new Date('2026-07-08T15:15:00.000Z') };
const val = { title: 'Standing Meet with Val', start: new Date('2026-07-08T15:00:00.000Z') };
const valNextWeek = { title: 'Standing Meet with Val', start: new Date('2026-07-15T15:00:00.000Z') };

function ask(e: { title: string; start: Date }, q = 'What is this about?', when = NOW) {
  store.recordAsked(eventKeyFor(e.title, e.start), e.title, e.start, q, when);
}

describe('PrepContextStore — ask-once policy', () => {
  it('never asked → may ask', () => {
    expect(store.shouldAsk(david.title, david.start, TZ, NOW)).toBe(true);
  });

  it('answered → never ask again', () => {
    ask(david);
    store.recordAnswer(eventKeyFor(david.title, david.start), 'Podcast guest, just needs a Riverside link');
    expect(store.shouldAsk(david.title, david.start, TZ, NOW)).toBe(false);
  });

  it('asked yesterday, unanswered → one re-ask on the morning of the event, then silent', () => {
    const yesterday = new Date('2026-07-07T21:00:00.000Z');
    ask(david, 'What is this about?', yesterday);
    // Event day (July 8 local), not yet asked today → may re-ask once
    expect(store.shouldAsk(david.title, david.start, TZ, NOW)).toBe(true);
    ask(david, 'What is this about?', NOW);
    // Already asked today → silent
    expect(store.shouldAsk(david.title, david.start, TZ, new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it('asked, unanswered, NOT the event day → stays silent', () => {
    ask(valNextWeek, 'Agenda?', NOW);
    expect(store.shouldAsk(valNextWeek.title, valNextWeek.start, TZ, new Date('2026-07-09T12:00:00.000Z'))).toBe(false);
  });
});

describe('PrepContextStore — recurring carryover (the Val case)', () => {
  it("last week's answer carries to next week's instance of the same title", () => {
    ask(val);
    store.recordAnswer(eventKeyFor(val.title, val.start), 'Always podcast/Domo talk', NOW);

    const carried = store.contextFor(valNextWeek.title, valNextWeek.start);
    expect(carried?.answer).toBe('Always podcast/Domo talk');
    expect(store.shouldAsk(valNextWeek.title, valNextWeek.start, TZ, new Date('2026-07-15T12:00:00.000Z'))).toBe(false);
  });

  it('one-shot context does NOT leak to different titles', () => {
    ask(david);
    store.recordAnswer(eventKeyFor(david.title, david.start), 'Podcast guest', NOW);
    expect(store.contextFor('Completely different meeting', valNextWeek.start)?.answer).toBeUndefined();
  });
});

describe('captureBriefingAnswer', () => {
  function mockClient(content: string): OllamaClient {
    return { chat: vi.fn().mockResolvedValue({ message: { role: 'assistant', content } }) } as unknown as OllamaClient;
  }

  it('records the answer against the matched open question', async () => {
    ask(david, 'What is the purpose of the meeting with David?');
    const ok = await captureBriefingAnswer({
      client: mockClient('{"question": 1}'),
      model: 'test',
      userMessage: 'No prep needed — David is going on the podcast, I just need to send him a Riverside link',
      store,
      now: NOW,
    });
    expect(ok).toBe(true);
    expect(store.contextFor(david.title, david.start)?.answer).toContain('Riverside link');
  });

  it('question: 0 (no match) records nothing', async () => {
    ask(david);
    const ok = await captureBriefingAnswer({
      client: mockClient('{"question": 0}'),
      model: 'test',
      userMessage: 'What time is it?',
      store,
      now: NOW,
    });
    expect(ok).toBe(false);
    expect(store.contextFor(david.title, david.start)?.answer).toBeUndefined();
  });

  it('no open questions → no model call', async () => {
    const client = mockClient('{"question": 1}');
    const ok = await captureBriefingAnswer({ client, model: 'test', userMessage: 'hello', store, now: NOW });
    expect(ok).toBe(false);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('out-of-range or garbage output records nothing', async () => {
    ask(david);
    expect(await captureBriefingAnswer({ client: mockClient('{"question": 7}'), model: 'test', userMessage: 'x', store, now: NOW })).toBe(false);
    expect(await captureBriefingAnswer({ client: mockClient('not json'), model: 'test', userMessage: 'x', store, now: NOW })).toBe(false);
  });
});
