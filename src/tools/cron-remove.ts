import type { InvarailTool } from './types.js';
import type { CronService } from '../cron/service.js';
import { resolveCronJob } from '../cron/resolve.js';

export function createCronRemoveTool(cronService: CronService): InvarailTool {
  return {
    name: 'cron_remove',
    description: 'Remove a scheduled job',
    parameterDescription: 'id (required): Job ID or (part of) the job name.',
    example: 'cron_remove[{"id": "abc12345"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job ID or (part of) the job name' },
      },
      required: ['id'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = String(params.id ?? '').trim();
      if (!query) return 'Error: id parameter is required (a job ID or name)';

      const resolved = resolveCronJob(cronService.list(true), query);
      if ('error' in resolved) return resolved.error;
      const job = resolved.job;
      if (job.type === 'heartbeat') {
        return `Job "${job.name}" is a heartbeat task. Use heartbeat_remove instead.`;
      }

      const removed = cronService.remove(job.id);
      return removed ? `Removed job "${job.name}" (${job.id})` : `Job ${job.id} not found`;
    },
  };
}
