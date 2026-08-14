import { describe, it, expect } from 'vitest';
import { cronPipeline } from '../../src/pipeline/definitions/cron.js';
import { memoryPipeline } from '../../src/pipeline/definitions/memory.js';
import { taskPipeline } from '../../src/pipeline/definitions/task.js';
import type { LlmBranchStage, CodeStage, ToolStage, LlmStage, PipelineContext } from '../../src/pipeline/types.js';

// Every enum-constrained route needs a no-action exit: an option list of only
// action buckets coerces questions into wrong actions (live failure 2026-08-14:
// "Can we trigger a cron early?" → edit → raw "Error: id parameter is required").
// Same doctrine as the engine's repair-prompt exit.

const routes: Array<[string, LlmBranchStage]> = [
  ['cron', cronPipeline.stages[0] as LlmBranchStage],
  ['memory', memoryPipeline.stages[0] as LlmBranchStage],
  ['task', taskPipeline.stages[0] as LlmBranchStage],
];

describe('enum routes have a question exit', () => {
  for (const [name, route] of routes) {
    it(`${name}: options include "question" with a defined branch ending in an llm answer`, () => {
      expect(route.options).toContain('question');
      const branch = route.branches.question;
      expect(branch?.length).toBeGreaterThan(0);
      const last = branch[branch.length - 1] as LlmStage;
      expect(last.type).toBe('llm');
      const { system } = last.buildPrompt({ userMessage: 'can it?', params: {}, stageResults: {} } as unknown as PipelineContext);
      expect(system).toMatch(/Do not perform any/);
    });

    it(`${name}: classifier prompt describes the question option`, () => {
      expect(route.prompt).toMatch(/"question"/);
    });
  }
});

describe('cron question branch tells the truth about run-now', () => {
  it('states there is no trigger-now and offers the real workarounds', () => {
    const route = cronPipeline.stages[0] as LlmBranchStage;
    const answer = route.branches.question[1] as LlmStage;
    const { system } = answer.buildPrompt({ userMessage: 'can we trigger a cron early?', params: {}, stageResults: { gather_jobs: '(jobs)' } } as unknown as PipelineContext);
    expect(system).toMatch(/no run-now/i);
    expect(system).toMatch(/edit the job/i);
  });
});

describe('cron empty-id grace (edit/remove)', () => {
  function branchStage(branch: string, stage: string) {
    const route = cronPipeline.stages[0] as LlmBranchStage;
    return route.branches[branch].find(s => s.name === stage)!;
  }

  it('edit tool is when-guarded on id; confirm asks with the list instead of raw error', () => {
    const editTool = branchStage('edit', 'edit') as ToolStage;
    expect(editTool.when!({ params: {} } as unknown as PipelineContext)).toBe(false);
    expect(editTool.when!({ params: { id: 'abc' } } as unknown as PipelineContext)).toBe(true);

    const confirm = branchStage('edit', 'confirm_edit') as CodeStage;
    const ctx = { params: {}, stageResults: { gather_for_edit: 'JOB LIST HERE' }, answer: '' } as unknown as PipelineContext;
    confirm.execute(ctx);
    expect(ctx.answer).toContain('Which job');
    expect(ctx.answer).toContain('JOB LIST HERE');
    expect(ctx.answer).not.toMatch(/Error:/);
  });

  it('remove branch has the same guard shape', () => {
    const removeTool = branchStage('remove', 'remove') as ToolStage;
    expect(removeTool.when!({ params: {} } as unknown as PipelineContext)).toBe(false);

    const confirm = branchStage('remove', 'confirm_remove') as CodeStage;
    const ctx = { params: {}, stageResults: { gather_for_remove: 'JOB LIST HERE' }, answer: '' } as unknown as PipelineContext;
    confirm.execute(ctx);
    expect(ctx.answer).toContain('Which job');
    expect(ctx.answer).toContain('JOB LIST HERE');
  });

  it('with an id present, confirm stages pass the tool result through', () => {
    const confirm = branchStage('edit', 'confirm_edit') as CodeStage;
    const ctx = { params: { id: 'abc' }, stageResults: { edit: 'Updated job abc' }, answer: '' } as unknown as PipelineContext;
    confirm.execute(ctx);
    expect(ctx.answer).toBe('Updated job abc');
  });
});
