import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cron } from 'croner';
import { CronService } from '../../src/cron/service.js';
import { CronStore } from '../../src/cron/store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeService(onTrigger: (job: unknown) => Promise<void>) {
  const store = new CronStore(join(dir, 'cron.json'));
  const service = new CronService({ store, onTrigger: onTrigger as never, timezone: 'America/New_York' });
  return { store, service };
}

describe('CronService semantics', () => {
  it('skip-on-overlap: a fire during a running job is skipped, not stacked', async () => {
    let resolveFirst!: () => void;
    const calls: number[] = [];
    const { store, service } = makeService(async () => {
      calls.push(Date.now());
      if (calls.length === 1) await new Promise<void>(r => { resolveFirst = r; });
    });
    const job = store.add({ name: 'slow', schedule: '* * * * *', category: 'chat', message: 'm', delivery: { channel: 'discord', target: '' } });

    const first = service.run(job.id);   // starts, parks on the promise
    await new Promise(r => setTimeout(r, 20));
    await service.run(job.id);           // fires while first is active → skipped
    expect(calls).toHaveLength(1);

    resolveFirst();
    await first;
    await service.run(job.id);           // after completion it runs again
    expect(calls).toHaveLength(2);
  });

  it('catch-up-once: a fire missed while down runs at start()', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    const { store, service } = makeService(onTrigger);
    // Downtime SHORT relative to the job's period — the case the catch-up exists for
    // ("a reboot at 8:59 must not eat a 9:00 reminder"): EXACTLY one fire missed, next
    // cycle still ahead. lastRunAt is derived from the schedule rather than a fixed
    // offset — a wall-clock offset made this flaky (at 22:09 a "70 minutes ago" hourly
    // fixture has missed TWO fires, which is correctly stale).
    const job = store.add({ name: 'missed', schedule: '0 * * * *', category: 'chat', message: 'm', delivery: { channel: 'discord', target: '' } });
    store.updateLastRun(job.id);
    const raw = store.get(job.id)!;
    const probe = new Cron('0 * * * *', { paused: true, timezone: 'America/New_York' });
    const nextFire = probe.nextRun(new Date())!;                     // upcoming fire
    probe.stop();
    const HOUR = 60 * 60 * 1000;
    const lastFire = nextFire.getTime() - HOUR;                      // the one just missed
    raw.lastRunAt = new Date(lastFire - 1000).toISOString();         // ran 1s before it
    (store as unknown as { save: () => void }).save();

    await service.start();
    await new Promise(r => setTimeout(r, 50)); // spawned, not awaited
    service.stop();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('no catch-up when nothing was missed', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    const { store, service } = makeService(onTrigger);
    // Yearly schedule far in the future relative to lastRunAt=now
    const job = store.add({ name: 'future', schedule: '0 9 15 9 *', category: 'chat', message: 'm', delivery: { channel: 'discord', target: '' } });
    store.updateLastRun(job.id);
    void job;

    await service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

import { resolveCronJob } from '../../src/cron/resolve.js';
import type { CronJob } from '../../src/cron/types.js';

describe('resolveCronJob', () => {
  const jobs = [
    { id: 'abc12345', name: 'Weekly AI Developments', type: 'cron' },
    { id: 'def67890', name: 'Daily Motivation', type: 'cron' },
    { id: 'ghi11111', name: 'Weekly Meal Plan', type: 'cron' },
  ] as CronJob[];

  it('resolves by exact id', () => {
    const r = resolveCronJob(jobs, 'abc12345');
    expect('job' in r && r.job.name).toBe('Weekly AI Developments');
  });

  it('resolves by case-insensitive name substring', () => {
    const r = resolveCronJob(jobs, 'weekly ai');
    expect('job' in r && r.job.id).toBe('abc12345');
  });

  it('resolves by full name', () => {
    const r = resolveCronJob(jobs, 'Weekly AI Developments');
    expect('job' in r && r.job.id).toBe('abc12345');
  });

  it('returns actionable error listing jobs on no match', () => {
    const r = resolveCronJob(jobs, 'nonexistent');
    expect('error' in r && r.error).toContain('Weekly AI Developments (abc12345)');
  });

  it('returns ambiguity error when multiple names match', () => {
    const r = resolveCronJob(jobs, 'weekly');
    expect('error' in r && r.error).toContain('matches 2 jobs');
  });
});

describe('catch-up staleness bound (2026-09-19)', () => {
  /** Boot catch-up with a controllable clock: jobs whose lastRunAt is far in the
   *  past must not all fire after long downtime. */
  async function catchUp(schedule: string, lastRunAtDaysAgo: number) {
    const fired: string[] = [];
    const { store, service } = makeService(async (job: any) => { fired.push(job.name); });
    const job = store.add({ name: `job-${schedule}`, schedule, category: 'chat', message: 'm', delivery: { channel: 'discord', target: '' } });
    store.updateLastRun(job.id);
    store.get(job.id)!.lastRunAt = new Date(Date.now() - lastRunAtDaysAgo * 86_400_000).toISOString();
    (store as unknown as { save: () => void }).save();
    await service.start();
    await new Promise(r => setTimeout(r, 60));   // catch-up is spawned, not awaited
    service.stop();
    return fired;
  }

  it('a daily job down for three weeks is STALE — skipped, not fired', async () => {
    expect(await catchUp('0 8 * * *', 21)).toEqual([]);
  });

  it('a weekly job down for three weeks is STALE — skipped', async () => {
    expect(await catchUp('30 20 * * 5', 21)).toEqual([]);
  });

  it('a daily job that missed only its last fire still runs (the 8:59-reboot case)', async () => {
    // lastRunAt ~25h ago: exactly one fire missed, next cycle is still ahead.
    const fired = await catchUp('0 8 * * *', 1.05);
    expect(fired).toHaveLength(1);
  });

  it('an every-minute job down for an hour is stale — 60 missed fires is not a reminder', async () => {
    expect(await catchUp('* * * * *', 1 / 24)).toEqual([]);
  });

  it('an annual reminder days late still runs — its next cycle is a year out', async () => {
    const now = new Date();
    const daysAgo = 4;
    const missedDay = new Date(now.getTime() - daysAgo * 86_400_000);
    const schedule = `0 9 ${missedDay.getDate()} ${missedDay.getMonth() + 1} *`;
    // lastRunAt ~360d ago = it ran on schedule LAST year, so exactly one fire (this
    // year's, 4 days ago) was missed. 400d would mean two missed years — correctly stale.
    expect(await catchUp(schedule, 360)).toHaveLength(1);
  });
});
