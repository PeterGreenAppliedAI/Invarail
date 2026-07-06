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
}
