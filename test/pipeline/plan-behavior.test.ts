import { describe, it, expect, vi } from 'vitest';
import { planPipeline } from '../../src/pipeline/definitions/plan.js';
import { runToolLoop } from '../../src/tool-loop/engine.js';
import type { CodeStage, PipelineContext } from '../../src/pipeline/types.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { OllamaToolCall } from '../../src/ollama/types.js';
import type { ToolContext, ToolDefinition } from '../../src/tools/types.js';

// Behavior pins for the skills+reason prune (Phase 3 of the Invarail trim).
// These assert the planning and tool-loop behavior that must SURVIVE the
// deletions — suite-green alone was judged insufficient for this phase.

function fakeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    userMessage: 'test',
    params: {},
    stageResults: {},
    steps: [],
    client: {} as never,
    executor: vi.fn(async () => 'ok'),
    toolContext: { agentId: 'test', sessionKey: 'test', workspacePath: undefined } as ToolContext,
    model: 'test',
    ...overrides,
  } as PipelineContext;
}

function stage(name: string): CodeStage {
  const s = planPipeline.stages.find(st => st.name === name);
  if (!s) throw new Error(`stage ${name} not found`);
  return s as CodeStage;
}

describe('plan pipeline without skills', () => {
  it('has no skill machinery in its stage list', () => {
    const names = planPipeline.stages.map(s => s.name);
    expect(names).not.toContain('skill_check');
    expect(names).not.toContain('skill_save');
  });

  it('parse_plan parses a well-formed generated plan into executable steps', async () => {
    const ctx = fakeCtx({
      userMessage: 'search the web then write a file',
      stageResults: {
        generate_plan: JSON.stringify([
          { specialist: 'web_search', message: 'find the latest AI news', purpose: 'gather sources' },
          { specialist: 'exec', message: 'write a summary file', purpose: 'produce the artifact' },
        ]),
      },
    });
    await stage('parse_plan').execute(ctx);
    const steps = ctx.params._plan as Array<{ specialist: string }>;
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].specialist).toBe('web_search');
  });

  it('parse_plan falls back to a single exec step when nothing parses (degrade, not abort)', async () => {
    const ctx = fakeCtx({ stageResults: { generate_plan: 'I cannot make a plan for this.' } });
    await stage('parse_plan').execute(ctx);
    const steps = ctx.params._plan as Array<{ specialist: string }>;
    expect(steps).toHaveLength(1);
    expect(steps[0].specialist).toBe('exec');
  });
});

describe('tool loop without a reason tool', () => {
  function mockClient(responses: Array<{ content: string; tool_calls?: OllamaToolCall[] }>): OllamaClient {
    let i = 0;
    return {
      chat: vi.fn(async () => {
        const r = responses[i] ?? { content: 'done' };
        i++;
        return { message: { role: 'assistant', content: r.content, tool_calls: r.tool_calls ?? null } };
      }),
    } as unknown as OllamaClient;
  }

  const tools: ToolDefinition[] = [{
    name: 'web_search',
    description: 'Search',
    parameterDescription: 'query',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'q' } }, required: ['query'] },
  }];

  it('completes a multi-tool run and returns the model answer unmodified (no forced pass)', async () => {
    const client = mockClient([
      { content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'a' } } }] },
      { content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'b' } } }] },
      { content: 'Final synthesized answer from two searches.' },
    ]);
    const executor = vi.fn(async () => 'search results');
    const result = await runToolLoop({
      client,
      config: { model: 'test', maxIterations: 6, temperature: 0.2, maxTokens: 512 },
      tools,
      executor,
      toolContext: { agentId: 'test', sessionKey: 'test' },
      userMessage: 'find a and b then answer',
    });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(result.answer).toContain('Final synthesized answer');
    expect(result.hitMaxIterations).toBe(false);
  });
});
