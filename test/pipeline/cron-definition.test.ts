import { describe, it, expect } from 'vitest';
import { cronPipeline } from '../../src/pipeline/definitions/cron.js';
import { CRON_JOB_CATEGORIES } from '../../src/cron/types.js';
import { createCronAddTool } from '../../src/tools/cron-add.js';
import { createCronEditTool } from '../../src/tools/cron-edit.js';
import type { CronService } from '../../src/cron/service.js';
import type { LlmBranchStage, ExtractStage, ParallelToolStage, CodeStage, PipelineContext } from '../../src/pipeline/types.js';

function fakeCronService(): CronService {
  const jobs: unknown[] = [];
  return {
    add: (input: Record<string, unknown>) => {
      const job = { id: `job${jobs.length + 1}`, enabled: true, createdAt: 'now', ...input };
      jobs.push(job);
      return job;
    },
    edit: () => null,
    nextRunFor: () => new Date('2026-09-15T13:00:00Z'),
  } as unknown as CronService;
}

function addBranch() {
  const route = cronPipeline.stages[0] as LlmBranchStage;
  return route.branches.add;
}

describe('cron category list stays in sync', () => {
  it('pipeline extract enum, cron_add enum, and cron_edit enum are all CRON_JOB_CATEGORIES', () => {
    const extract = addBranch()[0] as ExtractStage;
    const extractEnum = extract.schema.jobs.items?.category.enum;
    expect(extractEnum).toEqual([...CRON_JOB_CATEGORIES]);

    const addTool = createCronAddTool(fakeCronService());
    const addEnum = (addTool.parameters?.properties?.category as { enum?: string[] }).enum;
    expect(addEnum).toEqual([...CRON_JOB_CATEGORIES]);

    const editTool = createCronEditTool(fakeCronService());
    const editEnum = (editTool.parameters?.properties?.category as { enum?: string[] }).enum;
    expect(editEnum).toEqual([...CRON_JOB_CATEGORIES]);

    const route = cronPipeline.stages[0] as LlmBranchStage;
    const extractEdit = route.branches.edit[0] as ExtractStage;
    expect(extractEdit.schema.category.enum).toEqual([...CRON_JOB_CATEGORIES]);
  });

  it('cron_add accepts the categories the extractor offers (the July 20 drift)', async () => {
    const tool = createCronAddTool(fakeCronService());
    for (const category of ['task', 'research', 'personal']) {
      const result = await tool.execute(
        { name: 'j', schedule: '0 9 15 9 *', category, message: 'm', channel: 'discord', target: '1' },
        {} as never,
      );
      expect(result).not.toContain('Invalid category');
    }
  });
});

describe('cron add branch — multi-job', () => {
  it('fans out one cron_add call per extracted job with shared channel/target', () => {
    const add = addBranch()[2] as ParallelToolStage;
    const ctx = {
      params: {
        jobs: [
          { name: 'a', schedule: '0 9 15 9 *', category: 'message', message: 'ma', once: true },
          { name: 'b', schedule: '0 9 * * 5', category: 'message', message: 'mb', once: false },
        ],
        channel: 'discord',
        target: '123',
      },
    } as unknown as PipelineContext;
    const list = add.resolveParamsList(ctx);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'a', once: true, channel: 'discord', target: '123' });
    expect(list[1]).toMatchObject({ name: 'b', once: false, target: '123' });
  });

  it('confirm_add joins per-job results and discloses partial creation', async () => {
    const confirm = addBranch()[3] as CodeStage;

    const full = { params: { jobs: [1, 2] }, stageResults: { add: ['ok1', 'ok2'] }, answer: '' } as unknown as PipelineContext;
    await confirm.execute(full);
    expect(full.answer).toBe('ok1\nok2');

    const partial = { params: { jobs: [1, 2, 3] }, stageResults: { add: ['ok1'] }, answer: '' } as unknown as PipelineContext;
    await confirm.execute(partial);
    expect(partial.answer).toContain('Only 1 of 3');

    const empty = { params: { jobs: [] }, stageResults: { add: [] }, answer: '' } as unknown as PipelineContext;
    await confirm.execute(empty);
    expect(empty.answer).toContain("couldn't extract");
  });
});

describe('cron_add confirmation semantics', () => {
  it('labels one-shot vs recurring and includes the next run', async () => {
    const tool = createCronAddTool(fakeCronService());
    const oneShot = await tool.execute(
      { name: 'Token Reminder', schedule: '0 9 15 9 *', category: 'message', message: 'm', channel: 'discord', target: '1', once: true },
      {} as never,
    );
    expect(oneShot).toContain('one-shot');
    expect(oneShot).toContain('auto-disables');
    expect(oneShot).toContain('next run');

    const recurring = await tool.execute(
      { name: 'Weekly', schedule: '0 9 * * 5', category: 'message', message: 'm', channel: 'discord', target: '1' },
      {} as never,
    );
    expect(recurring).toContain('recurring');
    expect(recurring).not.toContain('auto-disables');
  });
});
