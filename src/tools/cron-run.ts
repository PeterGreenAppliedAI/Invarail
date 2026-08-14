import type { InvarailTool } from './types.js';
import type { CronService } from '../cron/service.js';

export function createCronRunTool(cronService: CronService): InvarailTool {
  return {
    name: 'cron_run',
    description: 'Run an existing scheduled job NOW, without waiting for its schedule. '
      + 'WHEN TO USE: the user explicitly asks to run/trigger/fire a job immediately ("run the weekly report now"). '
      + 'DO NOT use to create new jobs (cron_add) or change schedules (cron_edit). '
      + 'The schedule is untouched; results deliver to the job\'s configured channel exactly as a scheduled fire would. '
      + 'Running a one-shot job consumes it, same as its scheduled fire.',
    parameterDescription: 'job (required): the job ID or (part of) the job name.',
    example: 'cron_run[{"job": "Weekly AI Developments"}]',
    parameters: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Job ID or (part of) the job name' },
      },
      required: ['job'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = String(params.job ?? '').trim();
      if (!query) return 'Error: job parameter is required (a job ID or name)';

      const jobs = cronService.list(true).filter(j => j.type !== 'heartbeat');
      let match = jobs.find(j => j.id === query);
      if (!match) {
        const q = query.toLowerCase();
        const byName = jobs.filter(j => j.name.toLowerCase().includes(q));
        if (byName.length === 0) {
          return `No job matches "${query}". Current jobs:\n${jobs.map(j => `- ${j.name} (${j.id})`).join('\n') || '(none)'}`;
        }
        if (byName.length > 1) {
          return `"${query}" matches ${byName.length} jobs — be more specific:\n${byName.map(j => `- ${j.name} (${j.id})`).join('\n')}`;
        }
        match = byName[0];
      }

      // Fire-and-forget: a manual trigger behaves exactly like the clock firing —
      // same execution path (concurrency guard, retries, failure notify), results
      // delivered by the job's own channel. Awaiting here would hold the user's
      // turn hostage for the job's full runtime (research jobs run ~20 minutes).
      void cronService.run(match.id).catch(err =>
        console.warn(`[Cron] Manual run of "${match.name}" failed:`, err instanceof Error ? err.message : err));

      const next = cronService.nextRunFor(match.id);
      return `Triggered "${match.name}" (${match.id}) — running now. Results will be delivered to its configured channel. `
        + `Schedule unchanged${next ? ` (next scheduled run: ${next.toISOString()})` : ''}.`;
    },
  };
}
