import { Cron } from 'croner';
import type { InvarailTool, ToolContext } from './types.js';
import type { CronService } from '../cron/service.js';
import { CRON_JOB_CATEGORIES as VALID_CATEGORIES } from '../cron/types.js';

/** Words a model writes when it means "send it to me / here" — never a deliverable target. */
const PLACEHOLDER_TARGETS = new Set(['dm', 'me', 'here', 'this', 'current', 'user', 'owner', 'self', 'default', 'channel', 'chat', 'private', 'direct']);

/** Per-channel id shapes. A channel not listed accepts any non-placeholder string. */
const TARGET_SHAPE: Record<string, RegExp> = {
  discord: /^\d{15,21}$/,          // a snowflake: a channel id, a DM channel id, or a user id
  telegram: /^-?\d{3,}$/,           // a chat id (groups are negative)
};

/**
 * Where a cron job's results go. Recorded 2026-10-01: a reminder saved with target "dm" failed every
 * delivery — and its failure notice went to the same dead target, so the owner only saw it in the
 * terminal. The cron PIPELINE used to fill the target from the conversation; the arena move left
 * the tool without it. Now: an explicit target must look like a real id for its channel; a missing
 * or placeholder target defaults to the conversation the request came from; otherwise the tool
 * refuses to save a job that cannot deliver.
 */
export function resolveCronDelivery(
  channelParam: unknown,
  targetParam: unknown,
  ctx?: Pick<ToolContext, 'channel' | 'channelId'>,
): { channel: string; target: string; defaulted: boolean } | { error: string } {
  const channel = (typeof channelParam === 'string' && channelParam.trim()) || ctx?.channel || 'discord';
  const raw = typeof targetParam === 'string' ? targetParam.trim() : '';
  const shape = TARGET_SHAPE[channel];
  const usable = !!raw && !PLACEHOLDER_TARGETS.has(raw.toLowerCase()) && (!shape || shape.test(raw));
  if (usable) return { channel, target: raw, defaulted: false };
  if (ctx?.channelId && ctx.channel === channel) return { channel, target: ctx.channelId, defaulted: true };
  const what = raw ? `"${raw}" is not a ${channel} ${shape ? 'id' : 'target'}` : `no ${channel} target was given`;
  return { error: `Error: ${what}, and this request did not come from ${channel}, so there is no conversation to default to. Leave channel and target out when scheduling from the conversation that should receive the results, or give the ${channel} channel/user id.` };
}

export function createCronAddTool(cronService: CronService): InvarailTool {
  return {
    name: 'cron_add',
    description: `Schedule a recurring task. The category must be one of: ${VALID_CATEGORIES.join(', ')}. Use "web_search" for any internet/news lookups, "exec" for commands, "memory" for saving/retrieving info.`,
    parameterDescription: `name (required): Job name. schedule (required): Cron expression (e.g., "0 9 * * *" for daily at 9am). category (required): Must be one of: ${VALID_CATEGORIES.join(', ')}. message (required): The prompt to run. channel (optional): Delivery channel (e.g., "discord"). target (optional): Channel or user ID for results. Leave both out to deliver to THIS conversation — never write words like "dm" or "me".`,
    example: 'cron_add[{"name": "morning-news", "schedule": "0 9 * * *", "category": "web_search", "message": "Search for top AI news today and summarize", "channel": "discord", "target": "1234567890"}]',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name' },
        schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for daily at 9am)' },
        category: { type: 'string', description: `Specialist category. Must be one of: ${VALID_CATEGORIES.join(', ')}`, enum: [...VALID_CATEGORIES] },
        message: { type: 'string', description: 'The prompt to run when triggered' },
        channel: { type: 'string', description: 'Delivery channel (e.g., "discord"). Omit to use the channel this request came from.' },
        target: { type: 'string', description: 'Channel or user ID for results. Omit to deliver to this conversation; never a word like "dm" or "me".' },
        once: { type: 'boolean', description: 'One-shot: run once at the next matching time, then auto-disable. Use for reminders ("remind me tomorrow at 9am").' },
      },
      required: ['name', 'schedule', 'category', 'message'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
      const name = params.name as string;
      const schedule = params.schedule as string;
      const category = params.category as string;
      const message = params.message as string;

      if (!name || !schedule || !category || !message) {
        return 'Error: name, schedule, category, and message are all required';
      }

      if (!VALID_CATEGORIES.includes(category as any)) {
        return `Error: Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`;
      }

      // Validate the cron expression BEFORE persisting — an invalid schedule
      // would otherwise be stored and silently never run
      try {
        new Cron(schedule, { paused: true }).stop();
      } catch (err) {
        return `Error: Invalid cron expression "${schedule}" — ${err instanceof Error ? err.message : err}. Use standard 5-field syntax, e.g. "0 9 * * *" for daily at 9am.`;
      }

      const delivery = resolveCronDelivery(params.channel, params.target, ctx);
      if ('error' in delivery) return delivery.error;

      const once = params.once === true || params.once === 'true';
      const job = cronService.add({
        name,
        schedule,
        category,
        message,
        delivery: { channel: delivery.channel, target: delivery.target },
        ...(once ? { once: true } : {}),
      });

      // Surface the firing semantics — a dated reminder saved WITHOUT once
      // silently becomes an annual job, and only the next-run line reveals it
      const next = cronService.nextRunFor(job.id);
      const nextRun = next ? `, next run ${next.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
      const where = delivery.defaulted ? `, delivering to this conversation` : `, delivering to ${delivery.channel}:${delivery.target}`;
      return `Scheduled ${once ? 'one-shot' : 'recurring'} job "${job.name}" (${job.id}) with schedule "${job.schedule}", category="${job.category}"${nextRun}${once ? ' (runs once, then auto-disables)' : ''}${where}`;
    },
  };
}
