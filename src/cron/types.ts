/**
 * Single source of truth for which specialist categories a cron job may run.
 * cron_add/cron_edit validation AND the cron pipeline's extraction enum all
 * import this — they drifted once (tool rejected "task" while the extractor
 * offered it, July 20 incident) and must never be maintained separately again.
 */
export const CRON_JOB_CATEGORIES = [
  'chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'config', 'task', 'research', 'personal',
] as const;

export interface CronJob {
  id: string;
  name: string;
  type: 'cron' | 'heartbeat';
  schedule: string;    // cron expression
  category: string;    // specialist category
  message: string;     // prompt to run
  delivery: {
    channel: string;
    target: string;    // channelId to send result to
  };
  enabled: boolean;
  /** One-shot: disabled automatically after the first successful run.
   *  Without this, a "remind me tomorrow at 9" cron fires every year. */
  once?: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export interface CronJobCreate {
  name: string;
  type?: 'cron' | 'heartbeat';
  schedule: string;
  category: string;
  message: string;
  delivery: { channel: string; target: string };
  once?: boolean;
}

export interface CronJobUpdate {
  name?: string;
  schedule?: string;
  category?: string;
  message?: string;
  enabled?: boolean;
  once?: boolean;
}
