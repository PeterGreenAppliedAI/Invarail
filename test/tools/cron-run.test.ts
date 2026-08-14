import { describe, it, expect, vi } from 'vitest';
import { createCronRunTool } from '../../src/tools/cron-run.js';
import type { CronService } from '../../src/cron/service.js';

function fakeService(runSpy = vi.fn().mockResolvedValue('ok')) {
  const jobs = [
    { id: 'abc123', name: 'Weekly AI Developments', type: 'cron' },
    { id: 'def456', name: 'Daily Motivation', type: 'cron' },
    { id: 'ghi789', name: 'Weekly Meal Plan', type: 'cron' },
    { id: 'hb1', name: 'Heartbeat Check', type: 'heartbeat' },
  ];
  return {
    service: {
      list: () => jobs,
      run: runSpy,
      nextRunFor: () => new Date('2026-08-16T04:00:00Z'),
    } as unknown as CronService,
    runSpy,
  };
}

describe('cron_run', () => {
  it('runs by exact id, fire-and-forget, schedule untouched', async () => {
    const { service, runSpy } = fakeService();
    const out = await createCronRunTool(service).execute({ job: 'abc123' }, {} as never);
    expect(runSpy).toHaveBeenCalledWith('abc123');
    expect(out).toContain('Triggered "Weekly AI Developments"');
    expect(out).toContain('Schedule unchanged');
    expect(out).toContain('2026-08-16');
  });

  it('resolves a partial name case-insensitively', async () => {
    const { service, runSpy } = fakeService();
    const out = await createCronRunTool(service).execute({ job: 'ai developments' }, {} as never);
    expect(runSpy).toHaveBeenCalledWith('abc123');
    expect(out).toContain('Triggered');
  });

  it('asks for disambiguation on multiple matches instead of guessing', async () => {
    const { service, runSpy } = fakeService();
    const out = await createCronRunTool(service).execute({ job: 'weekly' }, {} as never);
    expect(runSpy).not.toHaveBeenCalled();
    expect(out).toContain('matches 2 jobs');
    expect(out).toContain('Weekly AI Developments');
    expect(out).toContain('Weekly Meal Plan');
  });

  it('lists jobs on no match, never a bare error', async () => {
    const { service, runSpy } = fakeService();
    const out = await createCronRunTool(service).execute({ job: 'nonexistent' }, {} as never);
    expect(runSpy).not.toHaveBeenCalled();
    expect(out).toContain('No job matches');
    expect(out).toContain('Daily Motivation');
  });

  it('excludes heartbeat tasks from matching', async () => {
    const { service, runSpy } = fakeService();
    const out = await createCronRunTool(service).execute({ job: 'Heartbeat Check' }, {} as never);
    expect(runSpy).not.toHaveBeenCalled();
    expect(out).toContain('No job matches');
  });

  it('does not await job completion (fire-and-forget)', async () => {
    let resolveRun!: () => void;
    const slow = vi.fn().mockImplementation(() => new Promise<string>(res => { resolveRun = () => res('done'); }));
    const { service } = fakeService(slow);
    const out = await createCronRunTool(service).execute({ job: 'abc123' }, {} as never);
    expect(out).toContain('Triggered'); // returned before the job resolved
    resolveRun();
  });
});
