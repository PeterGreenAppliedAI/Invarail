import { logAutonomousAction } from '../metrics.js';
import { pendingActions, PendingActionStore } from '../security/pending-actions.js';
import { eventKeyFor, PrepContextStore } from './prep-context.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Calendar prep proposals — the first rung of proactive autonomy.
 *
 * The briefing looks at upcoming events and, per event, either:
 *  - asks the user a targeted question when it lacks context to help, or
 *  - proposes a concrete prep action (reminder / task) it can execute on confirm.
 *
 * Division of labor (learned the hard way — see DECISIONS.md July 7): CODE
 * parses the calendar into structured events and does ALL date/time math in
 * the configured timezone. The model only picks an event NUMBER and, for
 * reminders, a minutesBefore integer. The first version asked the model to
 * construct ISO timestamps; a real 9B burned its whole token budget reasoning
 * about timezones and never emitted JSON.
 */

export interface ParsedEvent {
  /** 1-based — matches the numbering shown to the model and the user */
  index: number;
  title: string;
  start: Date;
  /** Human label for display, e.g. "Wed, Jul 8 2:00 PM" */
  label: string;
}

export interface PrepAssessment {
  event: number;
  action: 'question' | 'reminder' | 'task' | 'none';
  question?: string;
  reminder?: { minutesBefore: number; message: string };
  task?: { title: string };
}

const VALID_ACTIONS = new Set(['question', 'reminder', 'task', 'none']);
const MAX_PROPOSALS_PER_BRIEFING = 4;
const PREP_TTL_MS = 12 * 60 * 60 * 1000; // briefings are read late — 12h, not the interactive 10min
const MIN_MINUTES_BEFORE = 5;
const MAX_MINUTES_BEFORE = 24 * 60;

export const PREP_ASSESSMENT_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      event: { type: 'integer' },
      action: { type: 'string', enum: [...VALID_ACTIONS] },
      question: { type: 'string' },
      reminder: {
        type: 'object',
        properties: {
          minutesBefore: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['minutesBefore', 'message'],
      },
      task: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
    required: ['event', 'action'],
  },
};

// --- Timezone-correct date math (no dependencies) ---

function tzOffsetMs(ts: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(ts).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - ts;
}

/** Construct the UTC instant whose WALL-CLOCK time in `timeZone` matches the given components. */
export function zonedDate(year: number, monthIdx: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, monthIdx, day, hour, minute);
  let offset = tzOffsetMs(guess, timeZone);
  let t = guess - offset;
  const offset2 = tzOffsetMs(t, timeZone);
  if (offset2 !== offset) t = guess - offset2; // DST boundary second pass
  return new Date(t);
}

/** One-shot cron fields expressed in the CronService's configured timezone
 *  (croner interprets expressions in that tz, NOT server-local). */
export function cronForDate(when: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(when).map(p => [p.type, p.value]));
  return `${+parts.minute} ${+parts.hour % 24} ${+parts.day} ${+parts.month} *`;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * Parse briefing calendar text (enrichCalendarOutput format) into structured
 * events: `- **Title** [TOMORROW] Wed, Jul 8 2:00 PM – 3:00 PM`.
 * Unparseable lines are skipped — better to offer nothing than mis-time a reminder.
 */
export function parseCalendarEvents(calendarText: string, now: Date, timeZone: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const lineRe = /^-\s*\*\*([^*]+?)\*\*(?:\s*\[[^\]]*\])?\s+\w{3},\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+([AP]M)/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(calendarText)) !== null) {
    const [, title, mon, dayStr, hourStr, minStr, ampm] = m;
    const monthIdx = MONTHS[mon];
    if (monthIdx === undefined) continue;
    let hour = parseInt(hourStr) % 12;
    if (ampm === 'PM') hour += 12;

    // Year inference: assume this year; if that lands >1 day in the past, it's next year
    let start = zonedDate(now.getFullYear(), monthIdx, parseInt(dayStr), hour, parseInt(minStr), timeZone);
    if (start.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      start = zonedDate(now.getFullYear() + 1, monthIdx, parseInt(dayStr), hour, parseInt(minStr), timeZone);
    }

    events.push({
      index: events.length + 1,
      title: title.trim(),
      start,
      label: start.toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    });
  }
  return events;
}

export function buildPrepPrompt(events: ParsedEvent[], memory: string, identityLine?: string | null, knownContext?: Map<number, string>): { system: string; user: string } {
  const eventList = events.map(e => {
    const known = knownContext?.get(e.index);
    return `${e.index}. ${e.title} — ${e.label}${known ? `\n   KNOWN CONTEXT (the user already told you): ${known}` : ''}`;
  }).join('\n');
  return {
    system: [
      'You help a user prepare for upcoming calendar events. For each event pick EXACTLY ONE action:',
      ...(identityLine ? [identityLine] : []),
      '- "question" — the title alone doesn\'t tell you what prep would help. Ask ONE short, specific question.',
      '- "reminder" — a timed nudge would help. Give minutesBefore: how many minutes before the event to nudge (30, 60, or 120 are typical). Include a short message.',
      '- "task" — concrete prep work exists (prepare slides, review numbers). Give an actionable title.',
      '- "none" — routine event, nothing useful. Prefer "none" over inventing busywork.',
      'RULES:',
      '- NEVER ask a question about an event that has KNOWN CONTEXT — the user already answered. Use the context to propose something concrete, or choose "none".',
      '- Reference events ONLY by their number. NEVER write dates, times, or timezones — the system computes all timing.',
      `- At most ${MAX_PROPOSALS_PER_BRIEFING} entries. Return ONLY a JSON array, no prose, no reasoning.`,
      'Example: [{"event":2,"action":"reminder","reminder":{"minutesBefore":60,"message":"Budget review at 9 — bring updated numbers"}}]',
      '/no_think',
    ].join('\n'),
    user: `## Events\n${eventList}\n\n## About the user\n${memory.slice(0, 1500)}`,
  };
}

export function parsePrepAssessments(raw: string, eventCount: number, max = MAX_PROPOSALS_PER_BRIEFING): PrepAssessment[] {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: PrepAssessment[] = [];
  const seenEvents = new Set<number>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const eventNum = typeof o.event === 'number' ? o.event : NaN;
    if (!Number.isInteger(eventNum) || eventNum < 1 || eventNum > eventCount || seenEvents.has(eventNum)) continue;
    if (typeof o.action !== 'string' || !VALID_ACTIONS.has(o.action)) continue;
    if (o.action === 'none') continue;
    if (o.action === 'question' && typeof o.question !== 'string') continue;
    if (o.action === 'reminder') {
      const r = o.reminder as any;
      if (typeof r?.minutesBefore !== 'number' || typeof r?.message !== 'string') continue;
      if (r.minutesBefore < MIN_MINUTES_BEFORE || r.minutesBefore > MAX_MINUTES_BEFORE) continue;
    }
    if (o.action === 'task' && typeof (o.task as any)?.title !== 'string') continue;
    seenEvents.add(eventNum);
    out.push(o as unknown as PrepAssessment);
    if (out.length >= max) break;
  }
  return out;
}

export interface PrepSectionDeps {
  client: OllamaClient;
  model: string;
  calendar: string;
  memory: string;
  /** The sender id the user will reply FROM on the delivery channel (principal-resolved by the caller) */
  sender: string;
  channel: string;
  target: string;
  agentId: string;
  timeZone: string;
  /** Config-driven self-identity line (identity/principal.ts selfIdentityLine) */
  identityLine?: string | null;
  /** Prep-context store — remembered answers + asked-question dedup (intake loop) */
  prepContext?: PrepContextStore;
  store?: PendingActionStore;
  now?: Date;
}

/** Run the prep assessment and materialize proposals. Returns the briefing section text ('' if nothing to add). */
export async function buildPrepSection(deps: PrepSectionDeps): Promise<string> {
  const { client, model, calendar, memory, sender, channel, target, agentId, timeZone } = deps;
  const store = deps.store ?? pendingActions;
  const now = deps.now ?? new Date();

  // CODE parses events and owns all time math. No parseable events → no model call.
  const events = parseCalendarEvents(calendar, now, timeZone)
    .filter(e => e.start.getTime() > now.getTime() && e.start.getTime() < now.getTime() + 48 * 60 * 60 * 1000);
  if (events.length === 0) return '';
  // Re-number after the 48h filter so the model's numbering matches what it sees
  events.forEach((e, i) => { e.index = i + 1; });

  // Known answers (this instance or a recent same-title instance) become
  // context the model must use instead of re-asking
  const knownContext = new Map<number, string>();
  if (deps.prepContext) {
    for (const e of events) {
      const ctx = deps.prepContext.contextFor(e.title, e.start);
      if (ctx?.answer) knownContext.set(e.index, ctx.answer);
    }
  }

  const { system, user } = buildPrepPrompt(events, memory, deps.identityLine, knownContext);
  const chatParams = {
    model,
    messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }],
    options: { temperature: 0.2, num_predict: 2048 },
  };
  let raw: string;
  try {
    // Grammar-constrained when the backend supports it
    const resp = await client.chat({ ...chatParams, format: PREP_ASSESSMENT_SCHEMA });
    raw = resp.message?.content ?? '';
  } catch {
    try {
      const resp = await client.chat(chatParams);
      raw = resp.message?.content ?? '';
    } catch (err) {
      console.warn('[Prep] Assessment failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  const assessments = parsePrepAssessments(raw, events.length);
  if (assessments.length === 0) return '';

  // Don't duplicate proposals the user hasn't answered yet
  const openNames = new Set(store.listFor(sender).map(a => String((a.params as any).name ?? (a.params as any).title ?? '')));

  const lines: string[] = [];
  for (const a of assessments) {
    const event = events[a.event - 1];

    if (a.action === 'question' && a.question) {
      // Ask-once policy: answered (incl. recurring carryover) → never; asked &
      // unanswered → one re-ask on the morning of the event, then silent
      if (deps.prepContext && !deps.prepContext.shouldAsk(event.title, event.start, timeZone, now)) {
        console.log(`[Prep] Question suppressed for "${event.title}" (answered or already asked)`);
        continue;
      }
      lines.push(`❓ **${event.title}** (${event.label}) — ${a.question}`);
      deps.prepContext?.recordAsked(eventKeyFor(event.title, event.start), event.title, event.start, a.question, now);
      logAutonomousAction({ action: 'prep_question', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: `${event.title}: ${a.question.slice(0, 80)}` });
      continue;
    }

    if (a.action === 'reminder' && a.reminder) {
      // Code computes the fire time: event start minus the model's integer
      const fire = new Date(event.start.getTime() - a.reminder.minutesBefore * 60_000);
      if (fire.getTime() < now.getTime() + 60_000) {
        console.warn(`[Prep] Rejected reminder for "${event.title}": fire time already passed`);
        continue;
      }
      const name = `prep: ${event.title}`.slice(0, 50);
      if (openNames.has(name)) continue;
      const schedule = cronForDate(fire, timeZone);
      const entry = store.record({
        tool: 'cron_add',
        params: { name, schedule, category: 'chat', message: `Reminder: ${a.reminder.message}`, channel, target, once: true },
        sender, channel, agentId, sessionKey: 'briefing',
      }, PREP_TTL_MS);
      logAutonomousAction({ action: 'prep_reminder_proposed', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: `${event.title} -${a.reminder.minutesBefore}m` });
      const local = fire.toLocaleString('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
      lines.push(`⏰ **${event.title}** — reminder ${local}: "${a.reminder.message.slice(0, 60)}" → \`confirm ${entry.id}\``);
      continue;
    }

    if (a.action === 'task' && a.task) {
      if (openNames.has(a.task.title)) continue;
      const entry = store.record({
        tool: 'task_add', params: { title: a.task.title }, sender, channel, agentId, sessionKey: 'briefing',
      }, PREP_TTL_MS);
      logAutonomousAction({ action: 'prep_task_proposed', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: a.task.title.slice(0, 80) });
      lines.push(`📋 **${event.title}** — task: "${a.task.title.slice(0, 60)}" → \`confirm ${entry.id}\``);
    }
  }

  if (lines.length === 0) return '';
  return `\n\n🎯 **Prep** — reply with details, or \`confirm <id>\` to accept:\n${lines.join('\n')}`;
}
