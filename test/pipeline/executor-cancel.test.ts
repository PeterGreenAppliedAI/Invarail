import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/pipeline/executor.js';
import type { PipelineContext, PipelineDefinition } from '../../src/pipeline/types.js';

function ctxWith(isCancelled: () => boolean): PipelineContext {
  return {
    userMessage: 'research X', params: {}, stageResults: {}, steps: [],
    client: {} as any, executor: (async () => '') as any,
    toolContext: { agentId: 'a', sessionKey: 's' }, model: 'test', isCancelled,
  };
}

// The tool loop has honored !stop since 2026-08-22; pipelines had no hook at all,
// which a misrouted 22-stage research run made visible on 2026-09-25.
describe('pipeline cancellation (!stop)', () => {
  it('stops at the next stage boundary with an honest answer and runs nothing further', async () => {
    const ran: string[] = [];
    let cancelled = false;
    const def: PipelineDefinition = {
      name: 'test',
      stages: [
        { name: 's1', type: 'code', execute: () => { ran.push('s1'); cancelled = true; } },
        { name: 's2', type: 'code', execute: () => { ran.push('s2'); } },
        { name: 's3', type: 'code', execute: () => { ran.push('s3'); } },
      ],
    };
    const ctx = ctxWith(() => cancelled);
    const result = await runPipeline(def, ctx);
    expect(ran).toEqual(['s1']);
    expect(result.answer).toMatch(/Stopped by request before "s2"/);
    expect(ctx.abort).toBe(true);
  });

  it('is a no-op when never cancelled', async () => {
    const ran: string[] = [];
    const def: PipelineDefinition = { name: 'test', stages: [
      { name: 's1', type: 'code', execute: () => { ran.push('s1'); } },
      { name: 's2', type: 'code', execute: (ctx) => { ran.push('s2'); ctx.answer = 'done'; } },
    ] };
    const result = await runPipeline(def, ctxWith(() => false));
    expect(ran).toEqual(['s1', 's2']);
    expect(result.answer).toBe('done');
  });
});
