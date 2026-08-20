/**
 * Arena duel — architecture A/B: the SAME model, SAME tools, SAME tasks through
 *   Arm A ("pipeline"): the plan pipeline (LLM decomposes → code executes steps via
 *                       per-step specialist loops — the 2025 crutch-era architecture)
 *   Arm B ("arena"):    one open tool-loop — task in, natural stop out, no scripted
 *                       decomposition (the dsh/Pi pattern: constrain the arena, not the moves)
 *
 * Scoring: hidden per-task acceptance checks (pure code over an isolated workspace),
 * validated with --selftest (a scripted perfect performer must pass every check BEFORE
 * either arm runs — the pi-duel discipline).
 *
 * External-call budget: exactly ONE task touches the web (Brave, metered); everything
 * else is local surfaces (files, task board, exec, memory). See feedback memory
 * "external-call-budget-in-verification".
 *
 * Usage (lab tmux, LAN):
 *   npx tsx scripts/arena-duel.ts --selftest        # validate acceptance checks (no model)
 *   npx tsx scripts/arena-duel.ts                   # run both arms, think:false
 *   npx tsx scripts/arena-duel.ts --arm=arena --think=medium   # single arm, effort level
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { runToolLoop } from '../src/tool-loop/engine.js';
import { runPipeline } from '../src/pipeline/executor.js';
import { planPipeline } from '../src/pipeline/definitions/plan.js';
import { TaskStore } from '../src/tasks/store.js';
import { createTaskAddTool } from '../src/tools/task-add.js';
import { createTaskListTool } from '../src/tools/task-list.js';
import { createReadFileTool } from '../src/tools/read-file.js';
import { createWriteFileTool } from '../src/tools/write-file.js';
import { createExecTool } from '../src/tools/exec.js';
import { createMemorySaveTool } from '../src/tools/memory-save.js';
import { createWebSearchTool } from '../src/tools/web-search.js';
import { createWebFetchTool } from '../src/tools/web-fetch.js';
import type { InvarailTool, ToolExecutor, ToolContext } from '../src/tools/types.js';
import type { PipelineContext, SubDispatchResult } from '../src/pipeline/types.js';
import type { OllamaClient } from '../src/ollama/client.js';

const MODEL = 'qwen3.8-27b';
const OUT_DIR = `data/model-eval/arena-duel-${new Date().toISOString().slice(0, 10)}`;
const ARM_ARG = process.argv.find(a => a.startsWith('--arm='))?.split('=')[1];
const THINK_ARG = process.argv.find(a => a.startsWith('--think='))?.split('=')[1];
const THINK: boolean | 'low' | 'medium' | 'high' =
  THINK_ARG === 'low' || THINK_ARG === 'medium' || THINK_ARG === 'high' ? THINK_ARG : false;

// ---------------------------------------------------------------- task battery

interface DuelTask {
  id: string;
  prompt: string;
  web?: boolean;                                    // web tools enabled for this task only
  fixtures?: (ws: string) => void;                  // seeded before each run
  reference: (ws: string, store: TaskStore) => Promise<void> | void;  // perfect performer (selftest)
  check: (ws: string, store: TaskStore) => { pass: boolean; detail: string };
}

const read = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };

const TASKS: DuelTask[] = [
  {
    id: 'md-linecounts',
    prompt: 'Look at every .md file in your workspace and create a file called summary.txt listing each filename with its number of lines, one per line, format "name.md: N".',
    fixtures: ws => {
      writeFileSync(join(ws, 'alpha.md'), 'one\ntwo\nthree\n');
      writeFileSync(join(ws, 'beta.md'), 'a\nb\n');
    },
    reference: ws => writeFileSync(join(ws, 'summary.txt'), 'alpha.md: 3\nbeta.md: 2\n'),
    check: ws => {
      const t = read(join(ws, 'summary.txt'));
      const ok = /alpha\.md:?\s*3/.test(t) && /beta\.md:?\s*2/.test(t);
      return { pass: ok, detail: ok ? 'both counts correct' : `summary.txt: ${JSON.stringify(t.slice(0, 120))}` };
    },
  },
  {
    id: 'task-board',
    prompt: 'Add three tasks to my task board: "Renew SSL certificate" with high priority, "Water the plants" with low priority, and "Submit quarterly report" due 2026-08-28.',
    reference: (_ws, store) => {
      store.add({ title: 'Renew SSL certificate', priority: 'high' });
      store.add({ title: 'Water the plants', priority: 'low' });
      store.add({ title: 'Submit quarterly report', dueDate: '2026-08-28' });
    },
    check: (_ws, store) => {
      const tasks = store.list();
      const ssl = tasks.find(t => /ssl/i.test(t.title));
      const plants = tasks.find(t => /plant/i.test(t.title));
      const report = tasks.find(t => /quarterly/i.test(t.title));
      const ok = ssl?.priority === 'high' && plants?.priority === 'low' && !!report?.dueDate?.startsWith('2026-08-28');
      return { pass: ok, detail: ok ? '3 tasks with correct metadata' : `found ${tasks.length} tasks: ${tasks.map(t => `${t.title}(${t.priority ?? '-'}/${t.dueDate ?? '-'})`).join(', ').slice(0, 160)}` };
    },
  },
  {
    id: 'csv-revenue',
    prompt: 'The file sales.csv has columns product,units,unit_price. Compute the total revenue (sum of units*unit_price) and write just the number to revenue.txt.',
    fixtures: ws => writeFileSync(join(ws, 'sales.csv'), 'product,units,unit_price\nwidget,10,2.50\ngadget,4,12.00\nsprocket,7,3.00\n'),
    reference: ws => writeFileSync(join(ws, 'revenue.txt'), '94\n'),
    check: ws => {
      const t = read(join(ws, 'revenue.txt'));
      const ok = /(^|[^\d.])94(\.0+)?([^\d]|$)/.test(t);
      return { pass: ok, detail: ok ? 'revenue 94 correct' : `revenue.txt: ${JSON.stringify(t.slice(0, 60))}` };
    },
  },
  {
    id: 'fib-exec',
    prompt: 'Write a python script fib.py that computes the 20th Fibonacci number (fib(1)=1, fib(2)=1), run it with python3, and save the output to fib.txt.',
    reference: ws => {
      writeFileSync(join(ws, 'fib.py'), 'a,b=1,1\nfor _ in range(18): a,b=b,a+b\nprint(b)\n');
      writeFileSync(join(ws, 'fib.txt'), '6765\n');
    },
    check: ws => {
      const ok = /6765/.test(read(join(ws, 'fib.txt'))) && existsSync(join(ws, 'fib.py'));
      return { pass: ok, detail: ok ? 'fib.py + fib.txt=6765' : `fib.txt: ${JSON.stringify(read(join(ws, 'fib.txt')).slice(0, 40))}, fib.py exists: ${existsSync(join(ws, 'fib.py'))}` };
    },
  },
  {
    id: 'config-to-readme',
    prompt: 'Read config.json, find the server port, and add a section "## Config" to README.md stating the port. Keep the existing README content.',
    fixtures: ws => {
      writeFileSync(join(ws, 'config.json'), JSON.stringify({ name: 'svc', server: { host: '0.0.0.0', port: 8443 }, debug: false }, null, 2));
      writeFileSync(join(ws, 'README.md'), '# Service\n\nA demo service.\n');
    },
    reference: ws => writeFileSync(join(ws, 'README.md'), '# Service\n\nA demo service.\n\n## Config\n\nThe server port is 8443.\n'),
    check: ws => {
      const t = read(join(ws, 'README.md'));
      const ok = /## Config/.test(t) && /8443/.test(t) && /demo service/i.test(t);
      return { pass: ok, detail: ok ? 'section + port + original content' : `README: ${JSON.stringify(t.slice(0, 160))}` };
    },
  },
  {
    id: 'memory-then-file',
    prompt: 'Save to memory that the deployment freeze starts 2026-09-01. Then create freeze-notice.txt containing a one-line reminder with that date.',
    reference: ws => {
      writeFileSync(join(ws, 'MEMORY.md'), '- Deployment freeze starts 2026-09-01\n');
      writeFileSync(join(ws, 'freeze-notice.txt'), 'Deployment freeze starts 2026-09-01.\n');
    },
    check: ws => {
      const mem = read(join(ws, 'MEMORY.md'));
      const note = read(join(ws, 'freeze-notice.txt'));
      const ok = /2026-09-01/.test(mem) && /2026-09-01/.test(note);
      return { pass: ok, detail: ok ? 'memory + file both dated' : `MEMORY has date: ${/2026-09-01/.test(mem)}, notice has date: ${/2026-09-01/.test(note)}` };
    },
  },
  {
    id: 'web-node-year',
    web: true,
    prompt: 'Find the year Node.js was first released (search the web if needed) and write just the year to node-year.txt.',
    reference: ws => writeFileSync(join(ws, 'node-year.txt'), '2009\n'),
    check: ws => {
      const ok = /2009/.test(read(join(ws, 'node-year.txt')));
      return { pass: ok, detail: ok ? '2009' : `node-year.txt: ${JSON.stringify(read(join(ws, 'node-year.txt')).slice(0, 40))}` };
    },
  },
];

// ---------------------------------------------------------------- per-run environment

interface RunEnv {
  ws: string;
  store: TaskStore;
  tools: InvarailTool[];
  executor: ToolExecutor;
  toolContext: ToolContext;
}

function makeEnv(config: ReturnType<typeof loadConfig>, task: DuelTask, runId: string): RunEnv {
  const ws = resolve(join(tmpdir(), 'arena-duel', runId));
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  task.fixtures?.(ws);
  const store = new TaskStore(join(ws, 'tasks.json'), join(ws, 'TASKS.md'));

  const tools: InvarailTool[] = [
    createTaskAddTool(store),
    createTaskListTool(store),
    createReadFileTool(),
    createWriteFileTool(),
    createExecTool(config.tools?.exec, undefined),
    createMemorySaveTool(ws, undefined, undefined),
  ];
  if (task.web) {
    tools.push(createWebSearchTool(config.tools?.web?.search));
    tools.push(createWebFetchTool(config.tools?.web?.fetch));
  }
  const byName = new Map(tools.map(t => [t.name, t]));
  const executor: ToolExecutor = async (name, params, ctx) => {
    const tool = byName.get(name);
    if (!tool) return `Error: Tool "${name}" is not available. Available: ${[...byName.keys()].join(', ')}`;
    try {
      return await tool.execute(params, ctx);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const toolContext: ToolContext = { agentId: 'arena-duel', sessionKey: runId, workspacePath: ws, senderId: 'arena-duel' } as ToolContext;
  return { ws, store, tools, executor, toolContext };
}

// ---------------------------------------------------------------- arms

const ARENA_PROMPT = (tools: InvarailTool[]) => [
  'You are an autonomous assistant working in a workspace directory. Complete the user\'s task fully, then stop.',
  '',
  'Available tools:',
  ...tools.map(t => `- ${t.name}: ${t.description.split('\n')[0].slice(0, 120)}`),
  '',
  'Work step by step with your tools. Verify your own results where possible (e.g. read a file back after writing it). When the task is fully done, give a short final answer describing what you did.',
].join('\n');

const SUB_PROMPT = (tools: InvarailTool[]) => [
  'You are a task-execution specialist. Complete the specific step you are given, using your tools, then give a short factual report of what you did (include any file paths created).',
  '',
  'Available tools:',
  ...tools.map(t => `- ${t.name}: ${t.description.split('\n')[0].slice(0, 120)}`),
].join('\n');

interface ArmResult {
  pass: boolean;
  detail: string;
  seconds: number;
  llmCalls: number;
  toolCalls: number;
  completionTokens: number;
  error?: string;
}

async function runArena(client: OllamaClient, env: RunEnv, task: DuelTask): Promise<Omit<ArmResult, 'pass' | 'detail'>> {
  const start = Date.now();
  const result = await runToolLoop({
    client,
    config: {
      model: MODEL,
      maxIterations: 30,          // generous — "natural stop" within a sanity bound
      temperature: 0.7,
      maxTokens: 2048,
      contextSize: 32768,
      systemPrompt: ARENA_PROMPT(env.tools),
      toolStyle: 'native',
      think: THINK,
    },
    tools: env.tools,
    executor: env.executor,
    toolContext: env.toolContext,
    userMessage: task.prompt,
  });
  return {
    seconds: (Date.now() - start) / 1000,
    llmCalls: result.iterations,
    toolCalls: result.steps.filter(s => s.action).length,
    completionTokens: result.completionTokens ?? 0,
  };
}

async function runPipelineArm(client: OllamaClient, env: RunEnv, task: DuelTask): Promise<Omit<ArmResult, 'pass' | 'detail'>> {
  const start = Date.now();
  let llmCalls = 0;
  let toolCalls = 0;
  let completionTokens = 0;

  // Script-side subDispatch: each plan step runs a bounded specialist loop with the SAME
  // tools + model as the arena arm — faithful to production's per-step sub-dispatch.
  const subDispatch = async (message: string): Promise<SubDispatchResult> => {
    const r = await runToolLoop({
      client,
      config: {
        model: MODEL,
        maxIterations: 8,
        temperature: 0.7,
        maxTokens: 2048,
        contextSize: 32768,
        systemPrompt: SUB_PROMPT(env.tools),
        toolStyle: 'native',
        think: THINK,
      },
      tools: env.tools,
      executor: env.executor,
      toolContext: env.toolContext,
      userMessage: message,
    });
    llmCalls += r.iterations;
    toolCalls += r.steps.filter(s => s.action).length;
    completionTokens += r.completionTokens ?? 0;
    const filePaths = [...r.answer.matchAll(/(?:^|[\s`(])([\w./-]+\.(?:txt|md|py|json|csv))\b/g)].map(m => m[1]);
    return {
      answer: r.answer,
      steps: r.steps.map(s => ({ tool: s.action?.tool, observation: s.observation?.slice(0, 200) })),
      status: 'success',
      filePaths: [...new Set(filePaths)],
      urls: [...r.answer.matchAll(/https?:\/\/\S+/g)].map(m => m[0]),
      category: 'exec',
    };
  };

  const ctx: PipelineContext = {
    userMessage: task.prompt,
    params: {},
    stageResults: {},
    steps: [],
    client,
    executor: env.executor,
    toolContext: env.toolContext,
    model: MODEL,
    think: THINK,
    subDispatch,
  } as PipelineContext;

  const result = await runPipeline(planPipeline, ctx);
  // Plan-level llm stages (generate_plan, reflect, summarize) aren't counted by the
  // sub-loops — approximate as +1 per llm stage that produced a result.
  llmCalls += Object.keys(ctx.stageResults).length > 0 ? 3 : 0;
  void result;
  return {
    seconds: (Date.now() - start) / 1000,
    llmCalls,
    toolCalls,
    completionTokens,
  };
}

// ---------------------------------------------------------------- selftest + main

async function selftest(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('=== SELFTEST: acceptance checks vs reference performers ===');
  let failures = 0;
  for (const task of TASKS) {
    const env = makeEnv(config, task, `selftest-${task.id}`);
    await task.reference(env.ws, env.store);
    const { pass, detail } = task.check(env.ws, env.store);
    console.log(`${pass ? '✅' : '❌'} ${task.id}: ${detail}`);
    if (!pass) failures++;
    rmSync(env.ws, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\nSELFTEST FAILED: ${failures} check(s) reject their own reference — fix the checks before running arms.`);
    process.exit(1);
  }
  console.log('\nSELFTEST PASSED — every check accepts its reference implementation.');
}

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  if (process.argv.includes('--selftest')) return selftest(config);

  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  mkdirSync(OUT_DIR, { recursive: true });
  const arms = ARM_ARG ? [ARM_ARG] : ['pipeline', 'arena'];
  const results: Array<Record<string, unknown>> = [];

  for (const task of TASKS) {
    for (const arm of arms) {
      const runId = `${arm}-${task.id}`;
      const env = makeEnv(config, task, runId);
      console.log(`\n===== ${runId} (think=${THINK}) =====`);
      let telemetry: Omit<ArmResult, 'pass' | 'detail'>;
      let error: string | undefined;
      try {
        telemetry = arm === 'arena' ? await runArena(client, env, task) : await runPipelineArm(client, env, task);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        telemetry = { seconds: 0, llmCalls: 0, toolCalls: 0, completionTokens: 0 };
      }
      const { pass, detail } = task.check(env.ws, env.store);
      const row = { arm, task: task.id, pass, detail, think: THINK, model: MODEL, ...telemetry, ...(error ? { error } : {}) };
      results.push(row);
      console.log(`${pass ? '✅ PASS' : '❌ FAIL'} — ${detail} | ${telemetry.seconds.toFixed(0)}s, ${telemetry.llmCalls} llm calls, ${telemetry.toolCalls} tool calls, ${telemetry.completionTokens} ctok${error ? ` | ERROR: ${error.slice(0, 120)}` : ''}`);
      writeFileSync(join(OUT_DIR, `${runId}.json`), JSON.stringify(row, null, 2));
    }
  }

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\n===== SCOREBOARD =====');
  for (const arm of arms) {
    const rows = results.filter(r => r.arm === arm);
    const passes = rows.filter(r => r.pass).length;
    const secs = rows.reduce((a, r) => a + (r.seconds as number), 0);
    const ctok = rows.reduce((a, r) => a + (r.completionTokens as number), 0);
    const calls = rows.reduce((a, r) => a + (r.llmCalls as number), 0);
    console.log(`${arm.padEnd(9)} ${passes}/${rows.length} pass | ${secs.toFixed(0)}s total | ${calls} llm calls | ${ctok} ctok`);
  }
  console.log(`\nArtifacts: ${OUT_DIR}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
