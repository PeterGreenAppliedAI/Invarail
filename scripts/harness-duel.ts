/**
 * Harness duel: Invarail arena loop vs DeepSeek Harness (dsh) headless.
 *
 * FAIRNESS PROTOCOL:
 * - Same model both arms: qwen3.8-27b on SGLang (<host>:8000, OpenAI-compat).
 * - Same prompts, same fresh workspace fixtures, same computed-oracle checks.
 * - Neutral task set only: file/shell/python. No Invarail-only tools (task board,
 *   memory) — those tasks would be rigged. Both arms get file read/write + shell.
 * - Metric asymmetry, disclosed: dsh reports wall time + exit code + pass only
 *   (no token/iteration telemetry from the outside); ours reports full telemetry.
 *   Wall time and oracle pass/fail are the comparable columns.
 *
 * Usage:
 *   npx tsx scripts/harness-duel.ts                 # all tasks, both arms
 *   npx tsx scripts/harness-duel.ts --task fib-exec --arm dsh
 *   npx tsx scripts/harness-duel.ts --runs 2
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import type { OllamaClient } from '../src/ollama/client.js';
import { runToolLoop } from '../src/tool-loop/engine.js';
import type { InvarailTool, ToolContext, ToolExecutor } from '../src/tools/types.js';
import { createReadFileTool } from '../src/tools/read-file.js';
import { createWriteFileTool } from '../src/tools/write-file.js';
import { createExecTool } from '../src/tools/exec.js';
import { createPiBuildTool } from '../src/tools/pi-build.js';

const execFileAsync = promisify(execFile);

const MODEL = process.env.DUEL_MODEL || 'qwen3.8-27b';
// Tool-calling convention for the invarail arm: models without native tool templates
// (gemma lineage on most servings) duel with prompt-described tools + fallback parsers.
const TOOLSTYLE = (process.env.DUEL_TOOLSTYLE === 'text' ? 'text' : 'native') as 'native' | 'text';
const DSH_HOME = join(process.env.HOME ?? '', '.dsh-home');
const DSH_TIMEOUT_MS = 10 * 60 * 1000;

function read(p: string): string {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

// ---------------------------------------------------------------- tasks (neutral set)

interface DuelTask {
  id: string;
  prompt: string;
  fixtures?: (ws: string) => void;
  check: (ws: string) => { pass: boolean; detail: string };
}

const TASKS: DuelTask[] = [
  {
    id: 'md-linecounts',
    prompt: 'Look at every .md file in your workspace and create a file called summary.txt listing each filename with its number of lines, one per line, format "name.md: N".',
    fixtures: ws => {
      writeFileSync(join(ws, 'alpha.md'), 'one\ntwo\nthree\n');
      writeFileSync(join(ws, 'beta.md'), 'a\nb\n');
    },
    check: ws => {
      const t = read(join(ws, 'summary.txt'));
      const ok = /alpha\.md:?\s*3/.test(t) && /beta\.md:?\s*2/.test(t);
      return { pass: ok, detail: ok ? 'both counts correct' : `summary.txt: ${JSON.stringify(t.slice(0, 120))}` };
    },
  },
  {
    id: 'csv-revenue',
    prompt: 'The file sales.csv has columns product,units,unit_price. Compute the total revenue (sum of units*unit_price) and write just the number to revenue.txt.',
    fixtures: ws => writeFileSync(join(ws, 'sales.csv'), 'product,units,unit_price\nwidget,10,2.50\ngadget,4,12.00\nsprocket,7,3.00\n'),
    check: ws => {
      const t = read(join(ws, 'revenue.txt'));
      const ok = /(^|[^\d.])94(\.0+)?([^\d]|$)/.test(t);
      return { pass: ok, detail: ok ? 'revenue 94 correct' : `revenue.txt: ${JSON.stringify(t.slice(0, 60))}` };
    },
  },
  {
    id: 'fib-exec',
    prompt: 'Write a python script fib.py that computes the 20th Fibonacci number (fib(1)=1, fib(2)=1), run it with python3, and save the output to fib.txt.',
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
    check: ws => {
      const t = read(join(ws, 'README.md'));
      const ok = /## Config/.test(t) && /8443/.test(t) && /demo service/i.test(t);
      return { pass: ok, detail: ok ? 'section + port + original content' : `README: ${JSON.stringify(t.slice(0, 160))}` };
    },
  },
  {
    id: 'json-merge',
    prompt: 'Merge base.json and override.json into merged.json: start from base.json, and for any key present in override.json use its value instead. Keys only in base.json must survive.',
    fixtures: ws => {
      writeFileSync(join(ws, 'base.json'), JSON.stringify({ name: 'svc', retries: 3, timeout: 30, region: 'us-east' }, null, 2));
      writeFileSync(join(ws, 'override.json'), JSON.stringify({ timeout: 60, region: 'eu-west' }, null, 2));
    },
    check: ws => {
      try {
        const m = JSON.parse(read(join(ws, 'merged.json')));
        const ok = m.name === 'svc' && m.retries === 3 && m.timeout === 60 && m.region === 'eu-west';
        return { pass: ok, detail: ok ? 'merge correct' : `merged.json: ${JSON.stringify(m).slice(0, 120)}` };
      } catch {
        return { pass: false, detail: `merged.json unparseable: ${JSON.stringify(read(join(ws, 'merged.json')).slice(0, 80))}` };
      }
    },
  },
  {
    // Long-horizon composite — the 30-step-spiral class. Grindy as tool-per-turn
    // chains, trivial as one generated script (or one Pi delegation).
    id: 'sales-report',
    prompt: 'sales.csv has columns product,units,unit_price. Produce THREE artifacts: (1) report.md with a markdown table of every product and its revenue (units*unit_price), sorted by revenue descending; (2) totals.json with {"total_revenue": <number>, "top_product": "<name>"}; (3) premium.csv containing only the rows (with header) where unit_price is greater than 50.',
    fixtures: ws => {
      const rows = [
        'product,units,unit_price',
        'alpha,12,3.50', 'bravo,3,120.00', 'charlie,40,1.25', 'delta,7,55.00',
        'echo,22,9.99', 'foxtrot,5,80.50', 'golf,18,4.75', 'hotel,2,199.99',
        'india,60,0.99', 'juliett,9,45.00', 'kilo,14,32.10', 'lima,1,500.00',
        'mike,25,6.40', 'november,11,72.25', 'oscar,33,2.15', 'papa,4,150.75',
        'quebec,50,1.10', 'romeo,8,95.00', 'sierra,30,3.33', 'tango,6,66.60',
      ];
      writeFileSync(join(ws, 'sales.csv'), rows.join('\n') + '\n');
    },
    check: ws => {
      // Computed oracle: recompute from the fixture, verify all three artifacts.
      const expTotal = 12 * 3.5 + 3 * 120 + 40 * 1.25 + 7 * 55 + 22 * 9.99 + 5 * 80.5 + 18 * 4.75 + 2 * 199.99
        + 60 * 0.99 + 9 * 45 + 14 * 32.1 + 1 * 500 + 25 * 6.4 + 11 * 72.25 + 33 * 2.15 + 4 * 150.75
        + 50 * 1.1 + 8 * 95 + 30 * 3.33 + 6 * 66.6;
      const report = read(join(ws, 'report.md'));
      let totals: { total_revenue?: number; top_product?: string } = {};
      try { totals = JSON.parse(read(join(ws, 'totals.json'))); } catch { /* judged below */ }
      const premium = read(join(ws, 'premium.csv'));
      const premiumProducts = ['bravo', 'delta', 'foxtrot', 'hotel', 'november', 'lima', 'papa', 'romeo', 'tango'];
      const premiumOk = premiumProducts.every(p => premium.includes(p))
        && !['alpha', 'charlie', 'echo', 'india', 'juliett', 'kilo'].some(p => premium.includes(p));
      const totalOk = typeof totals.total_revenue === 'number' && Math.abs(totals.total_revenue - expTotal) < 1;
      // Top revenue: november 11×72.25=794.75 (then romeo 760, papa 603).
      const topOk = totals.top_product === 'november';
      const reportOk = report.includes('november') && report.includes('romeo') && /\|/.test(report);
      const ok = totalOk && topOk && premiumOk && reportOk;
      return {
        pass: ok,
        detail: ok ? 'all three artifacts correct' : `total: ${totalOk} (${totals.total_revenue} vs ${expTotal.toFixed(2)}), top: ${totals.top_product} (want november), premium: ${premiumOk}, report: ${reportOk}`,
      };
    },
  },
  {
    id: 'log-triage',
    prompt: 'app.log contains mixed log lines. Create errors.txt whose first line is the count of ERROR lines and whose second line is the message text of the LAST ERROR line.',
    fixtures: ws => writeFileSync(join(ws, 'app.log'), [
      '2026-08-22T10:00:01 INFO service started',
      '2026-08-22T10:00:05 ERROR db connection refused',
      '2026-08-22T10:01:11 WARN retrying db',
      '2026-08-22T10:01:12 INFO db connected',
      '2026-08-22T10:04:41 ERROR payment webhook timeout',
      '2026-08-22T10:09:03 INFO heartbeat ok',
      '2026-08-22T10:12:55 ERROR disk usage above 90%',
      '2026-08-22T10:13:00 INFO cleanup scheduled',
    ].join('\n') + '\n'),
    check: ws => {
      const t = read(join(ws, 'errors.txt'));
      const ok = /(^|[^\d])3([^\d]|$)/.test(t.split('\n')[0] ?? '') && /disk usage above 90/.test(t);
      return { pass: ok, detail: ok ? 'count=3 + last error msg' : `errors.txt: ${JSON.stringify(t.slice(0, 100))}` };
    },
  },
];

// ---------------------------------------------------------------- environment

function makeWs(task: DuelTask, runId: string): string {
  const ws = resolve(join(tmpdir(), 'harness-duel', runId));
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  task.fixtures?.(ws);
  return ws;
}

function makeTools(config: ReturnType<typeof loadConfig>, withPi = false): InvarailTool[] {
  const tools = [
    createReadFileTool(),
    createWriteFileTool(),
    createExecTool(config.tools?.exec, undefined),
  ];
  // arena-pi arm: "our code mode is Pi" — the delegation rung dsh's Code Mode maps to.
  if (withPi) tools.push(createPiBuildTool(config.pi));
  return tools;
}

const ARENA_PROMPT = (tools: InvarailTool[]) => [
  'You are an autonomous assistant working in a workspace directory. Complete the user\'s task fully, then stop.',
  '',
  'Available tools:',
  ...tools.map(t => `- ${t.name}: ${t.description.split('\n')[0].slice(0, 120)}`),
  '',
  'Work step by step with your tools. Verify your own results where possible (e.g. read a file back after writing it). When the task is fully done, give a short final answer describing what you did.',
].join('\n');

// ---------------------------------------------------------------- arms

interface ArmResult {
  pass: boolean;
  detail: string;
  seconds: number;
  llmCalls?: number;
  toolCalls?: number;
  completionTokens?: number;
  error?: string;
}

async function runInvarail(client: OllamaClient, config: ReturnType<typeof loadConfig>, ws: string, task: DuelTask, runId: string, withPi = false): Promise<Omit<ArmResult, 'pass' | 'detail'>> {
  const start = Date.now();
  const tools = makeTools(config, withPi);
  const byName = new Map(tools.map(t => [t.name, t]));
  const executor: ToolExecutor = async (name, params, ctx) => {
    const tool = byName.get(name);
    if (!tool) return `Error: Tool "${name}" is not available. Available: ${[...byName.keys()].join(', ')}`;
    try { return await tool.execute(params, ctx); } catch (err) { return `Error: ${err instanceof Error ? err.message : String(err)}`; }
  };
  const toolContext = { agentId: 'harness-duel', sessionKey: runId, workspacePath: ws, senderId: 'harness-duel' } as ToolContext;
  const result = await runToolLoop({
    client,
    config: {
      model: MODEL,
      maxIterations: 30,
      temperature: 0.7,
      maxTokens: 2048,
      contextSize: 32768,
      systemPrompt: ARENA_PROMPT(tools),
      toolStyle: TOOLSTYLE,
      think: false, // duel-pinned parity with the arena duel
    },
    tools,
    executor,
    toolContext,
    userMessage: task.prompt,
  });
  return {
    seconds: (Date.now() - start) / 1000,
    llmCalls: result.iterations,
    toolCalls: result.steps.filter(s => s.action).length,
    completionTokens: result.completionTokens ?? 0,
  };
}

async function runDsh(ws: string, task: DuelTask): Promise<Omit<ArmResult, 'pass' | 'detail'>> {
  const start = Date.now();
  try {
    // Model comes from $DSH_HOME/settings.yaml (agent-default-model) — dsh has no --model flag.
    await execFileAsync('npx', ['-y', '@deepseek-ai/dsh', '--profile', 'headless', task.prompt], {
      cwd: ws,
      env: { ...process.env, DSH_HOME, SGLANG_API_KEY: 'sglang' },
      timeout: DSH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { seconds: (Date.now() - start) / 1000 };
  } catch (err) {
    // Non-zero exit or timeout: the oracle still judges the workspace — a harness
    // that errors after doing the work should get credit for the work.
    const e = err as { killed?: boolean; code?: number | string; message?: string };
    return {
      seconds: (Date.now() - start) / 1000,
      error: e.killed ? 'timeout' : `exit=${e.code ?? '?'}`,
    };
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const onlyTask = flag('task');
  const onlyArm = flag('arm');
  const runs = Number(flag('runs') ?? '1');

  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends, config.inference?.ollamaBackends);

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = join('data', 'model-eval', `harness-duel-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const tasks = TASKS.filter(t => !onlyTask || t.id === onlyTask);
  const arms = ['invarail', 'arena-pi', 'dsh'].filter(a => !onlyArm || a === onlyArm);
  const results: Array<{ task: string; arm: string; run: number } & ArmResult> = [];

  for (const task of tasks) {
    for (const arm of arms) {
      for (let run = 0; run < runs; run++) {
        const runId = `${task.id}-${arm}-${run}`;
        const ws = makeWs(task, runId);
        console.log(`\n=== ${task.id} · ${arm} · run ${run + 1}/${runs} ===`);
        let telemetry: Omit<ArmResult, 'pass' | 'detail'>;
        try {
          telemetry = arm === 'dsh'
            ? await runDsh(ws, task)
            : await runInvarail(client, config, ws, task, runId, arm === 'arena-pi');
        } catch (err) {
          telemetry = { seconds: 0, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
        }
        const verdict = task.check(ws);
        const row = { task: task.id, arm, run, ...verdict, ...telemetry };
        results.push(row);
        console.log(`${verdict.pass ? 'PASS' : 'FAIL'} in ${telemetry.seconds.toFixed(1)}s — ${verdict.detail}${telemetry.error ? ` (${telemetry.error})` : ''}`);
        writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
      }
    }
  }

  console.log('\n============ SCOREBOARD ============');
  for (const arm of arms) {
    const rows = results.filter(r => r.arm === arm);
    const passes = rows.filter(r => r.pass).length;
    const avgS = rows.reduce((a, r) => a + r.seconds, 0) / Math.max(rows.length, 1);
    const tokens = rows.reduce((a, r) => a + (r.completionTokens ?? 0), 0);
    console.log(`${arm.padEnd(10)} ${passes}/${rows.length} pass · avg ${avgS.toFixed(1)}s/task${tokens ? ` · ${tokens} completion tokens` : ' · (tokens n/a externally)'}`);
  }
  for (const task of tasks) {
    const line = arms.map(a => {
      const r = results.filter(x => x.task === task.id && x.arm === a);
      return `${a}: ${r.filter(x => x.pass).length}/${r.length}`;
    }).join(' · ');
    console.log(`  ${task.id.padEnd(18)} ${line}`);
  }
  console.log(`\nArtifacts: ${outDir}/results.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
