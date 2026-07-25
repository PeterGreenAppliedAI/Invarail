import { Cron } from 'croner';
import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';
import { CRON_JOB_CATEGORIES as VALID_CATEGORIES } from '../cron/types.js';

export function createCronEditTool(cronService: CronService): LocalClawTool {
  return {
    name: 'cron_edit',
    description: `Edit an existing cron job. Update its name, schedule, category, message, or enabled status. Category must be one of: ${VALID_CATEGORIES.join(', ')}.`,
    parameterDescription: `id (required): Job ID to edit. name (optional): New name. schedule (optional): New cron expression. category (optional): New category (one of: ${VALID_CATEGORIES.join(', ')}). message (optional): New prompt/message. enabled (optional): Enable or disable the job.`,
    example: 'cron_edit[{"id": "abc12345", "schedule": "0 8 * * 1-5", "enabled": "true"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job ID to edit' },
        name: { type: 'string', description: 'New job name' },
        schedule: { type: 'string', description: 'New cron expression (e.g., "0 9 * * *")' },
        category: { type: 'string', description: `New specialist category. Must be one of: ${VALID_CATEGORIES.join(', ')}`, enum: [...VALID_CATEGORIES] },
        message: { type: 'string', description: 'New prompt/message to run when triggered' },
        enabled: { type: 'string', description: 'Enable (true) or disable (false) the job' },
        once: { type: 'boolean', description: 'One-shot: run once at the next matching time, then auto-disable. Set true to convert a recurring job into a single reminder.' },
      },
      required: ['id'],
    },
    category: 'config',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const changes: Record<string, unknown> = {};

      if (params.name !== undefined) changes.name = params.name as string;
      if (params.schedule !== undefined) {
        const schedule = params.schedule as string;
        // Validate the cron expression BEFORE persisting — an invalid schedule
        // would otherwise be stored and silently never run
        try {
          new Cron(schedule, { paused: true }).stop();
        } catch (err) {
          return `Error: Invalid cron expression "${schedule}" — ${err instanceof Error ? err.message : err}. Use standard 5-field syntax, e.g. "0 9 * * *" for daily at 9am.`;
        }
        changes.schedule = schedule;
      }
      if (params.message !== undefined) changes.message = params.message as string;

      if (params.category !== undefined) {
        const category = params.category as string;
        if (!VALID_CATEGORIES.includes(category as any)) {
          return `Error: Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`;
        }
        changes.category = category;
      }

      if (params.enabled !== undefined) {
        const val = params.enabled;
        changes.enabled = val === true || val === 'true';
      }

      if (params.once !== undefined) {
        changes.once = params.once === true || params.once === 'true';
      }

      if (Object.keys(changes).length === 0) {
        return 'Error: No changes provided. Specify at least one field to update (name, schedule, category, message, enabled).';
      }

      const updated = cronService.edit(id, changes);
      if (!updated) return `Job ${id} not found`;

      return `Updated job "${updated.name}" (${updated.id}): schedule="${updated.schedule}", category="${updated.category}", ${updated.once ? 'one-shot' : 'recurring'}, enabled=${updated.enabled}, message="${updated.message.slice(0, 80)}"`;
    },
  };
}
