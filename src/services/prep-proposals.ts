import { logAutonomousAction } from '../metrics.js';
import { pendingActions, PendingActionStore } from '../security/pending-actions.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Calendar prep proposals — the first rung of proactive autonomy.
 *
 * The briefing looks at upcoming events and, per event, either:
 *  - asks the user a targeted question when it lacks context to help, or
 *  - proposes a concrete prep action (reminder / task) it can execute on confirm.
 *
 * Structure per the autonomy principles: the model chooses from a CLOSED action
 * set and fills params; code validates everything, does all date math, builds
 * the exact tool calls, and records them in the pending-action ledger. A user
 * "confirm <id>" executes the stored call. Nothing runs without confirmation.
 */

export interface PrepAssessment {
  event: string;
  action: 'question' | 'reminder' | 'task' | 'none';
  question?: string;
  reminder?: { whenISO: string; message: string };
  task?: { title: string; dueDate?: string };
}

const VALID_ACTIONS = new Set(['question', 'reminder', 'task', 'none']);
const MAX_PROPOSALS_PER_BRIEFING = 4;
const PREP_TTL_MS = 12 * 60 * 60 * 1000; // briefings are read late — 12h, not the interactive 10min

export const PREP_ASSESSMENT_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      event: { type: 'string' },
      action: { type: 'string', enum: [...VALID_ACTIONS] },
      question: { type: 'string' },
      reminder: {
        type: 'object',
        properties: { whenISO: { type: 'string' }, message: { type: 'string' } },
        required: ['whenISO', 'message'],
      },
      task: {
        type: 'object',
        properties: { title: { type: 'string' }, dueDate: { type: 'string' } },
        required: ['title'],
      },
    },
    required: ['event', 'action'],
  },
};

export function buildPrepPrompt(calendar: string, memory: string, nowISO: string): { system: string; user: string } {
  return {
    system: [
      'You review a user\'s upcoming calendar and decide, per event, whether you can help them prepare.',
      'For each event choose EXACTLY ONE action:',
      '- "question" — you lack context to help. Ask ONE short, specific question (e.g. "Your 2pm with John — what\'s it about? I can prep notes or a reminder."). Use this when the event title alone doesn\'t tell you what preparation would help.',
      '- "reminder" — a timed nudge would clearly help (early meeting, needs travel, something to bring). Set whenISO to the moment the reminder should FIRE (ISO 8601 with timezone offset), before the event.',
      '- "task" — concrete prep work exists (prepare slides, review a doc). Title should be actionable.',
      '- "none" — routine event, nothing useful to add. Prefer "none" over inventing busywork.',
      `Current time: ${nowISO}. Only consider events in the NEXT 48 HOURS. At most ${MAX_PROPOSALS_PER_BRIEFING} entries — pick the events where you can help MOST.`,
      'Do not fabricate events. Only reference events from the calendar below.',
      'Return ONLY a JSON array matching the schema. No prose. /no_think',
    ].join('\n'),
    user: `## Calendar (day labels pre-computed and correct)\n${calendar}\n\n## What I know about the user (may inform what prep is useful)\n${memory.slice(0, 2000)}`,
  };
}

export function parsePrepAssessments(raw: string, max = MAX_PROPOSALS_PER_BRIEFING): PrepAssessment[] {
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
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.event !== 'string' || typeof o.action !== 'string' || !VALID_ACTIONS.has(o.action)) continue;
    if (o.action === 'question' && typeof o.question !== 'string') continue;
    if (o.action === 'reminder' && (typeof (o.reminder as any)?.whenISO !== 'string' || typeof (o.reminder as any)?.message !== 'string')) continue;
    if (o.action === 'task' && typeof (o.task as any)?.title !== 'string') continue;
    if (o.action === 'none') continue;
    out.push(o as unknown as PrepAssessment);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * ISO timestamp → one-shot cron expression ("m h D M *"). CODE does the date
 * math — the model only names a moment. Returns null for past times or
 * anything more than 60 days out (a reminder that far off is a model error).
 */
export function isoToOneShotCron(whenISO: string, now = new Date()): string | null {
  const when = new Date(whenISO);
  if (isNaN(when.getTime())) return null;
  const deltaMs = when.getTime() - now.getTime();
  if (deltaMs < 60_000 || deltaMs > 60 * 24 * 60 * 60 * 1000) return null;
  return `${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`;
}

export interface PrepSectionDeps {
  client: OllamaClient;
  model: string;
  calendar: string;
  memory: string;
  /** The sender id the user will reply FROM on the delivery channel (hb.delivery.target — same identity the !heartbeat flow uses) */
  sender: string;
  channel: string;
  target: string;
  agentId: string;
  store?: PendingActionStore;
  now?: Date;
}

/** Run the prep assessment and materialize proposals. Returns the briefing section text ('' if nothing to add). */
export async function buildPrepSection(deps: PrepSectionDeps): Promise<string> {
  const { client, model, calendar, memory, sender, channel, target, agentId } = deps;
  const store = deps.store ?? pendingActions;
  const now = deps.now ?? new Date();

  if (!calendar || /no events found/i.test(calendar)) return '';

  const { system, user } = buildPrepPrompt(calendar, memory, now.toISOString());
  const chatParams = {
    model,
    messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }],
    options: { temperature: 0.2, num_predict: 1024 },
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

  const assessments = parsePrepAssessments(raw);
  if (assessments.length === 0) return '';

  // Don't duplicate proposals the user hasn't answered yet
  const openNames = new Set(store.listFor(sender).map(a => String((a.params as any).name ?? (a.params as any).title ?? '')));

  const lines: string[] = [];
  for (const a of assessments) {
    if (a.action === 'question' && a.question) {
      lines.push(`❓ **${a.event}** — ${a.question}`);
      logAutonomousAction({ action: 'prep_question', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: `${a.event}: ${a.question.slice(0, 80)}` });
      continue;
    }

    if (a.action === 'reminder' && a.reminder) {
      const schedule = isoToOneShotCron(a.reminder.whenISO, now);
      if (!schedule) {
        console.warn(`[Prep] Rejected reminder for "${a.event}": invalid/past time ${a.reminder.whenISO}`);
        continue;
      }
      const name = `prep: ${a.event}`.slice(0, 50);
      if (openNames.has(name)) continue;
      const entry = store.record({
        tool: 'cron_add',
        params: { name, schedule, category: 'chat', message: `Reminder: ${a.reminder.message}`, channel, target, once: true },
        sender, channel, agentId, sessionKey: 'briefing',
      }, PREP_TTL_MS);
      logAutonomousAction({ action: 'prep_reminder_proposed', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: `${a.event} @ ${a.reminder.whenISO}` });
      const local = new Date(a.reminder.whenISO).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      lines.push(`⏰ **${a.event}** — reminder ${local}: "${a.reminder.message.slice(0, 60)}" → \`confirm ${entry.id}\``);
      continue;
    }

    if (a.action === 'task' && a.task) {
      if (openNames.has(a.task.title)) continue;
      const params: Record<string, unknown> = { title: a.task.title };
      if (a.task.dueDate) params.dueDate = a.task.dueDate;
      const entry = store.record({
        tool: 'task_add', params, sender, channel, agentId, sessionKey: 'briefing',
      }, PREP_TTL_MS);
      logAutonomousAction({ action: 'prep_task_proposed', tier: 'propose_confirm', source: 'briefing', reversible: true, outcome: 'proposed', detail: a.task.title.slice(0, 80) });
      lines.push(`📋 **${a.event}** — task: "${a.task.title.slice(0, 60)}" → \`confirm ${entry.id}\``);
    }
  }

  if (lines.length === 0) return '';
  return `\n\n🎯 **Prep** — reply with details, or \`confirm <id>\` to accept:\n${lines.join('\n')}`;
}
