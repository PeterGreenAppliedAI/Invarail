import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // Job that should have fired within the last day (every-minute schedule,
    // lastRunAt an hour ago → definitely missed)
    const job = store.add({ name: 'missed', schedule: '* * * * *', category: 'chat', message: 'm', delivery: { channel: 'discord', target: '' } });
    store.updateLastRun(job.id);
    // Backdate lastRunAt an hour
    const raw = store.get(job.id)!;
    raw.lastRunAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
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
