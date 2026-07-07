import { Cron } from 'croner';
import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';

const VALID_CATEGORIES = ['chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'config'] as const;

export function createCronAddTool(cronService: CronService): LocalClawTool {
  return {
    name: 'cron_add',
    description: `Schedule a recurring task. The category must be one of: ${VALID_CATEGORIES.join(', ')}. Use "web_search" for any internet/news lookups, "exec" for commands, "memory" for saving/retrieving info.`,
    parameterDescription: `name (required): Job name. schedule (required): Cron expression (e.g., "0 9 * * *" for daily at 9am). category (required): Must be one of: ${VALID_CATEGORIES.join(', ')}. message (required): The prompt to run. channel (required): Delivery channel (e.g., "discord"). target (required): Channel ID for results.`,
    example: 'cron_add[{"name": "morning-news", "schedule": "0 9 * * *", "category": "web_search", "message": "Search for top AI news today and summarize", "channel": "discord", "target": "1234567890"}]',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name' },
        schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for daily at 9am)' },
        category: { type: 'string', description: `Specialist category. Must be one of: ${VALID_CATEGORIES.join(', ')}`, enum: [...VALID_CATEGORIES] },
        message: { type: 'string', description: 'The prompt to run when triggered' },
        channel: { type: 'string', description: 'Delivery channel (e.g., "discord")' },
        target: { type: 'string', description: 'Channel ID for results' },
        once: { type: 'boolean', description: 'One-shot: run once at the next matching time, then auto-disable. Use for reminders ("remind me tomorrow at 9am").' },
      },
      required: ['name', 'schedule', 'category', 'message', 'channel', 'target'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = params.name as string;
      const schedule = params.schedule as string;
      const category = params.category as string;
      const message = params.message as string;
      const channel = params.channel as string;
      const target = params.target as string;

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

      const once = params.once === true || params.once === 'true';
      const job = cronService.add({
        name,
        schedule,
        category,
        message,
        delivery: { channel: channel ?? 'discord', target: target ?? '' },
        ...(once ? { once: true } : {}),
      });

      return `Scheduled ${once ? 'one-shot ' : ''}job "${job.name}" (${job.id}) with schedule "${job.schedule}", category="${job.category}"`;
    },
  };
}
