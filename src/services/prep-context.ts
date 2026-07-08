import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Prep-context store — closes the intake loop for calendar prep questions.
 *
 * Without this, prep questions were stateless: asked in the briefing, answered
 * by the user into plain chat history, then asked again next briefing (nagging
 * by architecture). This store remembers, per event: what was asked, when, and
 * what the user answered.
 *
 * Scope decision (owner's call, July 8): answers are EVENT-SCOPED and expire —
 * they do NOT auto-write to long-term memory. The heartbeat extraction remains
 * the single sanctioned path for autonomous durable-memory writes; durable info
 * in an answer reaches memory through that sieve on its own schedule.
 *
 * Re-ask policy (owner's call): an unanswered question may be re-asked ONCE on
 * the morning of the event day, then never again.
 */

export interface PrepContextEntry {
  /** title + ISO date — each instance of a recurring event is its own entry */
  eventKey: string;
  eventTitle: string;
  eventStartISO: string;
  question: string;
  askedAtISO: string[];
  answer?: string;
  answeredAtISO?: string;
}

// Two lifetimes (owner's design, July 8): one-shot context ("David = podcast
// guest") dies days after the event; RECURRING context ("Standing Meet with
// Val = podcast talk") carries across instances via title-level fallback, so a
// recurring meeting's agenda is asked ONCE, not every week. Neither is
// permanent — truly durable info reaches long-term memory via the heartbeat.
const UNANSWERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ANSWERED_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

export function eventKeyFor(title: string, start: Date): string {
  return `${title.trim().toLowerCase()}@${start.toISOString().slice(0, 10)}`;
}

export function normalizedTitle(title: string): string {
  return title.trim().toLowerCase();
}

export class PrepContextStore {
  constructor(private readonly path: string) {}

  static forPrincipal(workspacePath: string, principal: string): PrepContextStore {
    return new PrepContextStore(join(workspacePath, 'memory', principal, 'prep-context.json'));
  }

  private load(): PrepContextEntry[] {
    try {
      const all = JSON.parse(readFileSync(this.path, 'utf-8')) as PrepContextEntry[];
      const now = Date.now();
      return all.filter(e => {
        const retention = e.answer ? ANSWERED_RETENTION_MS : UNANSWERED_RETENTION_MS;
        return new Date(e.eventStartISO).getTime() > now - retention;
      });
    } catch {
      return [];
    }
  }

  private save(entries: PrepContextEntry[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.warn('[PrepContext] Save failed:', err instanceof Error ? err.message : err);
    }
  }

  get(eventKey: string): PrepContextEntry | undefined {
    return this.load().find(e => e.eventKey === eventKey);
  }

  /** Known context for an event: exact instance first, else the most recent
   *  ANSWERED entry with the same title (recurring-meeting carryover). */
  contextFor(title: string, start: Date): PrepContextEntry | undefined {
    const entries = this.load();
    const exact = entries.find(e => e.eventKey === eventKeyFor(title, start));
    if (exact?.answer) return exact;
    const t = normalizedTitle(title);
    const answered = entries
      .filter(e => e.answer && normalizedTitle(e.eventTitle) === t)
      .sort((a, b) => new Date(b.answeredAtISO!).getTime() - new Date(a.answeredAtISO!).getTime());
    return answered[0] ?? exact;
  }

  /** All entries with an unanswered question for a still-upcoming event. */
  openQuestions(now = new Date()): PrepContextEntry[] {
    return this.load().filter(e => !e.answer && new Date(e.eventStartISO).getTime() > now.getTime());
  }

  /** Record that a question was asked (creates or appends an askedAt). */
  recordAsked(eventKey: string, eventTitle: string, eventStart: Date, question: string, now = new Date()): void {
    const entries = this.load();
    const existing = entries.find(e => e.eventKey === eventKey);
    if (existing) {
      existing.askedAtISO.push(now.toISOString());
      existing.question = question;
    } else {
      entries.push({
        eventKey,
        eventTitle,
        eventStartISO: eventStart.toISOString(),
        question,
        askedAtISO: [now.toISOString()],
      });
    }
    this.save(entries);
  }

  recordAnswer(eventKey: string, answer: string, now = new Date()): boolean {
    const entries = this.load();
    const entry = entries.find(e => e.eventKey === eventKey);
    if (!entry) return false;
    entry.answer = answer;
    entry.answeredAtISO = now.toISOString();
    this.save(entries);
    console.log(`[PrepContext] Answer recorded for "${entry.eventTitle}": ${answer.slice(0, 80)}`);
    return true;
  }

  /**
   * May we ask (or re-ask) a question for this event?
   *  - answered (this instance OR a recent same-title instance) → no
   *  - never asked → yes
   *  - asked & unanswered → once more on the MORNING OF the event's local day,
   *    provided we haven't already asked that day → then silent forever
   */
  shouldAsk(eventTitle: string, eventStart: Date, timeZone: string, now = new Date()): boolean {
    const carried = this.contextFor(eventTitle, eventStart);
    if (carried?.answer) return false;
    const entry = this.get(eventKeyFor(eventTitle, eventStart));
    if (!entry) return true;

    const dayIn = (d: Date) => d.toLocaleDateString('en-US', { timeZone });
    const isEventDay = dayIn(now) === dayIn(eventStart);
    if (!isEventDay) return false;
    const askedToday = entry.askedAtISO.some(a => dayIn(new Date(a)) === dayIn(now));
    return !askedToday;
  }
}

// --- Answer capture (write side of the loop) ---

/**
 * Match a user's reply-to-briefing against the open prep questions and record
 * the answer. The model's ONLY job is picking which question (a closed integer
 * enum) the reply answers — 0 means none. Grammar-constrained where supported.
 */
export async function captureBriefingAnswer(opts: {
  client: OllamaClient;
  model: string;
  userMessage: string;
  store: PrepContextStore;
  now?: Date;
}): Promise<boolean> {
  const { client, model, userMessage, store } = opts;
  const now = opts.now ?? new Date();
  const open = store.openQuestions(now);
  if (open.length === 0) return false;

  const list = open.map((e, i) => `${i + 1}. [${e.eventTitle}] ${e.question}`).join('\n');
  const chatParams = {
    model,
    messages: [
      {
        role: 'system' as const,
        content: [
          'A user was asked prep questions about upcoming calendar events. Decide which ONE question their reply answers.',
          'Reply ONLY with JSON: {"question": <number>} — the question number, or 0 if the reply does not answer any of them.',
          'A reply answers a question if it gives the requested context, even indirectly ("no prep needed, he\'s a podcast guest" answers "what is the purpose of the meeting?").',
          '/no_think',
        ].join('\n'),
      },
      { role: 'user' as const, content: `## Open questions\n${list}\n\n## User reply\n${userMessage}` },
    ],
    options: { temperature: 0.1, num_predict: 64 },
  };

  let raw = '';
  try {
    const resp = await client.chat({
      ...chatParams,
      format: { type: 'object', properties: { question: { type: 'integer' } }, required: ['question'] },
    });
    raw = resp.message?.content ?? '';
  } catch {
    try {
      const resp = await client.chat(chatParams);
      raw = resp.message?.content ?? '';
    } catch (err) {
      console.warn('[PrepContext] Answer capture failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  const match = raw.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*?\}/);
  if (!match) return false;
  let n: number;
  try {
    n = Number(JSON.parse(match[0]).question);
  } catch {
    return false;
  }
  if (!Number.isInteger(n) || n < 1 || n > open.length) return false;

  return store.recordAnswer(open[n - 1].eventKey, userMessage.slice(0, 500), now);
}
