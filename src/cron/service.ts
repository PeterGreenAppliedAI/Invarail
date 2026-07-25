import { Cron } from 'croner';
import { logAutonomousAction } from '../metrics.js';
import { CronStore } from './store.js';
import type { CronJob, CronJobCreate, CronJobUpdate } from './types.js';

export interface CronServiceDeps {
  store: CronStore;
  onTrigger: (job: CronJob) => Promise<void>;
  /** Called when a job fails all retry attempts — for notifying the delivery channel */
  onFailure?: (job: CronJob, error: string) => Promise<void>;
  timezone?: string;
}

export class CronService {
  private store: CronStore;
  private onTrigger: (job: CronJob) => Promise<void>;
  private onFailure?: (job: CronJob, error: string) => Promise<void>;
  private timezone: string;
  private schedulers = new Map<string, Cron>();
  private running = false;
  /** Jobs currently mid-execution — a tick that fires while the previous run
   *  (or its retries) is still going is SKIPPED, not stacked. */
  private activeJobs = new Set<string>();

  constructor(deps: CronServiceDeps) {
    this.store = deps.store;
    this.onTrigger = deps.onTrigger;
    this.onFailure = deps.onFailure;
    this.timezone = deps.timezone ?? 'America/New_York';
  }

  async start(): Promise<void> {
    this.running = true;
    this.scheduleAll();
    console.log(`[Cron] Started with ${this.store.listByType('cron').length} cron job(s), ${this.store.listByType('heartbeat').length} heartbeat task(s)`);
    this.catchUpMissedRuns();
  }

  /** Run-once catch-up: a fire that was missed while the process was down runs
   *  at boot (spawned, not awaited — boot must not block on job work). Matters
   *  most for `once` reminders: a reboot at 8:59 must not eat a 9:00 reminder. */
  private catchUpMissedRuns(): void {
    const now = Date.now();
    for (const job of this.store.list()) {
      if (job.type === 'heartbeat' || !job.enabled) continue;
      try {
        const since = new Date(job.lastRunAt ?? job.createdAt);
        const probe = new Cron(job.schedule, { paused: true, timezone: this.timezone });
        const missed = probe.nextRun(since);
        probe.stop();
        if (missed && missed.getTime() < now) {
          console.log(`[Cron] Catch-up: "${job.name}" missed a fire at ${missed.toISOString()} — running once now`);
          void this.executeJob(job).catch(err =>
            console.warn(`[Cron] Catch-up run failed for ${job.id}:`, err instanceof Error ? err.message : err));
        }
      } catch { /* invalid schedule already logged by scheduleJob */ }
    }
  }

  stop(): void {
    this.running = false;
    for (const cron of this.schedulers.values()) {
      cron.stop();
    }
    this.schedulers.clear();
  }

  list(includeDisabled = false): CronJob[] {
    return this.store.list(includeDisabled);
  }

  listByType(type: 'cron' | 'heartbeat', includeDisabled = false): CronJob[] {
    return this.store.listByType(type, includeDisabled);
  }

  updateLastRun(id: string): void {
    this.store.updateLastRun(id);
  }

  add(input: CronJobCreate): CronJob {
    const job = this.store.add(input);
    if (this.running && job.enabled && job.type !== 'heartbeat') {
      this.scheduleJob(job);
    }
    return job;
  }

  remove(id: string): boolean {
    const cron = this.schedulers.get(id);
    if (cron) {
      cron.stop();
      this.schedulers.delete(id);
    }
    return this.store.remove(id);
  }

  edit(id: string, changes: CronJobUpdate): CronJob | null {
    const updated = this.store.update(id, changes);
    if (!updated) return null;

    // If schedule changed, reschedule the croner job
    if (changes.schedule !== undefined || changes.enabled !== undefined) {
      const existing = this.schedulers.get(id);
      if (existing) {
        existing.stop();
        this.schedulers.delete(id);
      }
      if (updated.enabled && this.running) {
        this.scheduleJob(updated);
      }
    }

    return updated;
  }

  async run(id: string): Promise<string> {
    const job = this.store.get(id);
    if (!job) return `Job ${id} not found`;
    await this.executeJob(job);
    return `Job ${id} executed`;
  }

  /** Next fire time of a scheduled job (croner computes it in the configured timezone). */
  nextRunFor(id: string): Date | null {
    return this.schedulers.get(id)?.nextRun() ?? null;
  }

  private scheduleAll(): void {
    for (const job of this.store.list()) {
      if (job.type === 'heartbeat') continue;
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJob): void {
    try {
      const cron = new Cron(job.schedule, {
        timezone: this.timezone,
      }, async () => {
        if (!this.running) return;
        await this.executeJob(job);
      });

      this.schedulers.set(job.id, cron);
      const next = cron.nextRun();
      console.log(`[Cron] Scheduled "${job.name}" (${job.schedule}) — next run: ${next?.toISOString() ?? 'unknown'}`);
    } catch (err) {
      console.warn(`[Cron] CONFIG_INVALID: Invalid schedule "${job.schedule}" for job ${job.id} —`, err instanceof Error ? err.message : err);
    }
  }

  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_DELAYS_MS = [30_000, 60_000]; // 30s, 60s

  private async executeJob(job: CronJob): Promise<void> {
    if (this.activeJobs.has(job.id)) {
      console.log(`[Cron] Skipping "${job.name}" (${job.id}) — previous run still in progress`);
      return;
    }
    this.activeJobs.add(job.id);
    try {
      await this.executeJobInner(job);
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  private async executeJobInner(job: CronJob): Promise<void> {
    console.log(`[Cron] Triggering job: ${job.name} (${job.id})`);

    for (let attempt = 0; attempt <= CronService.MAX_RETRIES; attempt++) {
      try {
        await this.onTrigger(job);
        this.store.updateLastRun(job.id);
        if (attempt > 0) {
          console.log(`[Cron] Job ${job.id} succeeded on retry ${attempt}`);
        }
        logAutonomousAction({ action: 'cron_job_run', tier: 'act_then_notify', source: 'cron', reversible: false, outcome: 'success', detail: job.name });
        // One-shot jobs retire after their first successful run — a 5-field
        // cron expression would otherwise fire again next year
        if (job.once) {
          this.edit(job.id, { enabled: false });
          console.log(`[Cron] One-shot job "${job.name}" (${job.id}) completed — disabled`);
        }
        return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        if (attempt < CronService.MAX_RETRIES) {
          const delay = CronService.RETRY_DELAYS_MS[attempt];
          console.warn(`[Cron] Job ${job.id} failed (attempt ${attempt + 1}/${CronService.MAX_RETRIES + 1}): ${errMsg} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.warn(`[Cron] Job ${job.id} failed after ${CronService.MAX_RETRIES + 1} attempts: ${errMsg}`);
          logAutonomousAction({ action: 'cron_job_run', tier: 'act_then_notify', source: 'cron', reversible: false, outcome: 'failure', detail: `${job.name}: ${errMsg.slice(0, 120)}` });
          // Notify via onTrigger's delivery channel if possible
          if (this.onFailure) {
            try { await this.onFailure(job, errMsg); } catch { /* best-effort */ }
          }
        }
      }
    }
  }
}
