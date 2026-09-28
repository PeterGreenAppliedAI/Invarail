/**
 * End-to-end model eval — the SAME front door a user's message takes.
 *
 * `scripts/model-eval.ts` measures the ENGINE (runToolLoop + extractParams with mock
 * tools and a fifteen-token system prompt). It cannot see what a small model does under
 * the real thing: the router, a wizard-generated config, the specialist prompts, the
 * workspace context (1.6K tokens fresh, 3–4K on a lived-in box), the real tool schemas,
 * the six security layers, the confirm ledger, session history, the pipelines. This
 * harness does: every task goes through `dispatchMessage` with a config the wizard
 * would have generated for the model under test, a bootstrapped workspace, the real
 * registry, and the real stores — in a scratch directory that IS the install
 * (`process.chdir`, so every `data/…` path lands there and nothing touches the repo).
 *
 * Only the WEB is stubbed: `web_search`/`web_fetch` are replaced with a fixed corpus so
 * the run is reproducible and never spends a real provider's quota (or the host IP's
 * reputation). Everything else is production code.
 *
 * Scoring: code oracles over the workspace, the stores, the routed category and the
 * answer — never a judge. `--selftest` runs a scripted perfect performer through every
 * oracle with no model, so a wrong check cannot masquerade as a model failure.
 *
 * Usage:
 *   npx tsx scripts/e2e-eval.ts <model> [model ...] [--reps=1] [--task=<id>] [--profile=full]
 *   npx tsx scripts/e2e-eval.ts --selftest
 *   OLLAMA_URL=http://host:11434 npx tsx scripts/e2e-eval.ts qwen3.5:9b   (target another host)
 * NOTE: node needs LAN access — run inside the `lab` tmux session.
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config/loader.js';
import type { InvarailConfig } from '../src/config/types.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import type { OllamaClient } from '../src/ollama/client.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerAllTools } from '../src/tools/register-all.js';
import type { InvarailTool } from '../src/tools/types.js';
import { PipelineRegistry } from '../src/pipeline/registry.js';
import { registerAllPipelines } from '../src/pipeline/definitions/index.js';
import { SessionStore } from '../src/sessions/store.js';
import { FactStore } from '../src/memory/fact-store.js';
import { TaskStore } from '../src/tasks/store.js';
import { CronStore } from '../src/cron/store.js';
import { CronService } from '../src/cron/service.js';
import { bootstrapWorkspace } from '../src/agents/workspace.js';
import { resolveWorkspacePath } from '../src/agents/scope.js';
import { dispatchMessage, type DispatchResult } from '../src/dispatch.js';
import { buildConfig, type WizardState } from '../src/setup/steps/generate.js';
import { findMeasured, thinkFor, foregroundTier, contextSizeForTier } from '../src/setup/measured-models.js';
import { stripThinkingTags } from '../src/utils/text.js';
import { handleConfirmation } from '../src/security/confirm-handler.js';
import { detectLibreOffice } from '../src/setup/detect.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATE = new Date().toISOString().slice(0, 10);
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const REPS = Number(flag('reps') ?? 1);
const TASK_FILTER = flag('task');
/** `full` | `small` | `wizard` (whatever the wizard would write for this model's tier). */
const PROFILE = (flag('profile') ?? 'wizard') as 'full' | 'small' | 'wizard';
/** `fresh` (bootstrap files only) | `lived` (a workspace that has grown: USER/TOOLS/AGENTS/LEARNINGS filled in). */
const WORKSPACE = (flag('workspace') ?? 'fresh') as 'fresh' | 'lived';
const RUN_DIR = join(REPO, 'data', 'model-eval', `e2e-${DATE}-${PROFILE}-${WORKSPACE}`);
const SELFTEST = argv.includes('--selftest');
const MODELS = argv.filter(a => !a.startsWith('--'));
const OWNER = 'eval-owner';
/** Resolved once at startup: whether this box can render PDFs at all. */
let SOFFICE = false;

// ---------------------------------------------------------------- the stubbed web

interface Page { url: string; title: string; body: string }

/** Fixed corpus. Distinctive phrases are what the oracles look for in reports and answers. */
const CORPUS: Page[] = [
  {
    url: 'https://gpu-inference.example/consumer-gpus-2026',
    title: 'Local LLM inference on consumer GPUs in 2026: what fits where',
    body: `Local inference in 2026 is bounded by VRAM, not compute. A 12GB card (RTX 3060 / 4070) runs 7–12B models comfortably in 4-bit GGUF; a 24GB card (RTX 3090 / 4090 / A5000) runs 27–35B models at Q4_K_M with room for a 16K context. The common rule of thumb is 0.6GB of VRAM per billion parameters at Q4 plus the KV cache. Above 24GB, two-card setups or unified memory (Apple silicon, Strix Halo) take over.\n\nThroughput on a 4090 for a 27B Q4 model is roughly 35–45 tokens per second; a 12B model on a 3060 lands near 25 tokens per second. Prompt processing (prefill) is the hidden cost: a 4K-token system prompt costs 1–2 seconds on a 3060 before the first token.`,
  },
  {
    url: 'https://quant-notes.example/gguf-quantization-guide',
    title: 'GGUF quantization guide: Q4_K_M is the default for a reason',
    body: `Q4_K_M keeps 95–98% of a model's benchmark quality at ~4.5 bits per weight and is the default download on most hubs. Q8_0 is near-lossless but doubles memory. Q3 and Q2 quants fit more parameters into the same VRAM but the quality drop is steep below 4 bits — a Q2 27B is usually worse than a Q4 12B. IQ quants (importance-matrix) recover some quality at low bit widths. For tool calling specifically, quantization below Q4 measurably increases malformed JSON arguments.`,
  },
  {
    url: 'https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama',
    title: 'llama.cpp vs vLLM vs Ollama: which serving stack for one user',
    body: `For a single user on one GPU, llama.cpp (and Ollama, which wraps it) wins on simplicity and memory efficiency; vLLM wins on batched throughput and is the choice for a shared server. Ollama added structured outputs (JSON schema constrained decoding) and native tool calling for supported chat templates; not every model's template declares tools — phi4 and the gemma3 small models return HTTP 400 on a tools request. Speculative decoding with a small draft model gives 1.5–2× on long generations in llama.cpp. vLLM's prefix caching makes repeated system prompts nearly free; llama.cpp caches the KV prefix per slot.`,
  },
  {
    url: 'https://small-models.example/9b-vs-27b-tool-use',
    title: 'How small can a tool-using agent go? 9B vs 27B in practice',
    body: `In agent loops the gap between 9B and 27B is not knowledge, it is discipline: small models call a tool when none is needed, pad arguments with fields the schema never asked for, and lose the thread after 4–5 hops. Thinking modes help 27B models and hurt 9B models on tool batteries — the reasoning burns the output budget before the call. With a short system prompt and a capped toolset a 9B holds up on 1–2 hop tasks; with a 4K-token prompt and twenty tools it degrades sharply.`,
  },
  {
    url: 'https://nodejs-history.example/timeline',
    title: 'A short history of Node.js',
    body: `Node.js was first released in 2009 by Ryan Dahl, built on Google's V8 engine. npm arrived in 2010. The io.js fork in 2014 merged back in 2015 under the Node.js Foundation, which became the OpenJS Foundation in 2019. Long-term support releases ship every October.`,
  },
  {
    url: 'https://example-docs.test/guide',
    title: 'Widget Service — Operator Guide',
    body: `# Widget Service Operator Guide\n\nThe service listens on port 8443 and requires TLS. Configuration lives in /etc/widget/config.toml and is reloaded with SIGHUP — no restart needed. Backups run nightly at 02:00 UTC to the "widget-backups" bucket and are retained for 30 days. The health endpoint is /healthz and returns 503 while a backup is in progress.`,
  },
  {
    url: 'https://unified-memory.example/apple-strix-halo',
    title: 'Unified memory for local inference: Apple silicon and Strix Halo',
    body: `Unified memory trades bandwidth for capacity: a 128GB Mac Studio or Strix Halo box loads a 70B model that no consumer card can, at a fraction of the tokens per second a 4090 gives on a model that fits. For chat that is fine; for agent loops that prefill a long prompt every turn, the lower bandwidth shows up as latency to first token. MLX on Apple silicon narrows the gap for prefill.`,
  },
];

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9.]{3,}/g) ?? []);

function makeWebStubs(log: string[]): InvarailTool[] {
  const search: InvarailTool = {
    name: 'web_search',
    description: 'Search the web. WHEN TO USE: you need current facts, sources, or URLs you do not have. Returns titles, URLs and snippets.',
    parameterDescription: '{"query": "search terms", "count": 5}',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' }, count: { type: 'number', description: 'Number of results (default 5)' } }, required: ['query'] },
    category: 'web',
    execute: async (params) => {
      const q = String(params.query ?? '');
      log.push(`web_search(${q})`);
      const qt = tokens(q);
      const ranked = CORPUS
        .map(p => ({ p, hits: [...tokens(`${p.title} ${p.body}`)].filter(t => qt.has(t)).length }))
        .sort((a, b) => b.hits - a.hits);
      const top = ranked.slice(0, Math.min(Number(params.count ?? 4) || 4, 5)).map(r => r.p);
      return top.map((p, i) => `${i + 1}. ${p.title}\n   ${p.url}\n   ${p.body.slice(0, 160).replace(/\n/g, ' ')}…`).join('\n\n');
    },
  };
  const fetch: InvarailTool = {
    name: 'web_fetch',
    description: 'Fetch a web page by URL and return its text content. WHEN TO USE: you have a URL and need what is on the page.',
    parameterDescription: '{"url": "https://…"}',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The URL to fetch' } }, required: ['url'] },
    category: 'web',
    execute: async (params) => {
      const url = String(params.url ?? '').replace(/\/$/, '');
      log.push(`web_fetch(${url})`);
      const page = CORPUS.find(p => p.url === url);
      return page ? `# ${page.title}\n\n${page.body}` : 'Error: HTTP 404 Not Found';
    },
  };
  return [search, fetch];
}

// ---------------------------------------------------------------- a lived-in workspace

/** What a workspace looks like after a few weeks: the files the bootstrap leaves as stubs,
 *  filled the way the heartbeat and the owner fill them. Sized like the reference box
 *  (~3K tokens across the four) — the number the small profile exists to bound. */
function seedLivedWorkspace(ws: string): void {
  const para = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed} ${i + 1}: ` + 'the owner prefers short answers, hates being asked to confirm twice, runs a home lab with three GPU boxes and a Mac mini, tracks work on the task board, and wants a heads-up before anything touches the network. '.repeat(2)).join('\n\n');
  writeFileSync(join(ws, 'USER.md'), `# USER.md\n\n## Preferences\n${para(6, 'Preference')}\n\n## Projects\n${para(4, 'Project')}\n`);
  writeFileSync(join(ws, 'TOOLS.md'), `# TOOLS.md\n\n## Conventions\n${para(8, 'Convention')}\n\n## Hosts\n${para(6, 'Host')}\n`);
  writeFileSync(join(ws, 'AGENTS.md'), `# AGENTS.md\n\n## Operating rules\n${para(6, 'Rule')}\n`);
  writeFileSync(join(ws, 'LEARNINGS.md'), `# LEARNINGS.md\n\n${para(5, 'Learning')}\n`);
}

// ---------------------------------------------------------------- the install

interface Env {
  root: string;
  ws: string;
  config: InvarailConfig;
  client: OllamaClient;
  registry: ToolRegistry;
  pipelines: PipelineRegistry;
  sessions: SessionStore;
  facts: FactStore;
  tasks: TaskStore;
  cron: CronStore;
  webLog: string[];
  /** The registry's SQLite store — must be closed before the scratch install is removed (Windows EBUSY). */
  embeddingStore?: { close(): void };
}

/** Close what holds files open, then remove the scratch install. */
function teardown(env: Env): void {
  try { env.embeddingStore?.close(); } catch { /* already closed */ }
  process.chdir(REPO);
  rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function wizardState(model: string, ollamaUrl: string): WizardState {
  return {
    ollama: { url: ollamaUrl, models: [] },
    models: {
      routerModel: model, specialistModel: model, backgroundModel: model,
      categoryModels: {}, inferenceBackends: [],
      specialistThink: thinkFor(findMeasured(model)),
      foregroundTier: PROFILE === 'wizard' ? foregroundTier(model) : PROFILE,
    },
    channels: {
      discord: { enabled: false }, telegram: { enabled: false },
      web: { enabled: true, port: 3100, host: '127.0.0.1' },
      ownerId: OWNER, trustedUsers: {},
    },
    services: {
      // brave + a stub key just so the wizard ENABLES web_search/website/research; the
      // registry's web tools are replaced with the corpus before any message runs.
      webSearch: { enabled: true, provider: 'brave', apiKey: 'stub', dailyQueryCeiling: 250 },
      tts: { enabled: false }, stt: { enabled: false }, vision: { enabled: false },
      browser: { enabled: false, headless: true },
      exec: { security: 'allowlist' },
      graphMemory: { enabled: false }, memory: { backend: 'flat', embeddingModel: 'none' }, heartbeat: { enabled: false },
      reasoning: { enabled: false }, imageGen: { enabled: false }, pi: { enabled: false },
    },
  } as WizardState;
}

/** A fresh install in a scratch directory: wizard config for THIS model, bootstrapped
 *  workspace, real registry + pipelines + stores. The process chdir's into it so every
 *  relative `data/…` path in the runtime lands there. */
async function makeEnv(model: string, ollamaUrl: string): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'invarail-e2e-'));
  const configPath = join(root, 'invarail.config.json5');
  writeFileSync(configPath, buildConfig(wizardState(model, ollamaUrl)));
  process.env.OLLAMA_URL = ollamaUrl;
  process.env.BRAVE_API_KEY = 'stub';
  process.chdir(root);
  const config = loadConfig(configPath);
  // The client the way the orchestrator builds it — from THIS config, so calls that name
  // no num_ctx (quality judge, summaries) get the generated defaultContextSize. A shared
  // client built without it sent those calls to the server's default and reloaded the
  // model between them (second A/B pass, 2026-09-27).
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, [], [], config.ollama.defaultContextSize);
  instrument(client);

  const ws = resolveWorkspacePath(config.agents.default, config);
  bootstrapWorkspace(ws, 'Invarail');
  if (WORKSPACE === 'lived') seedLivedWorkspace(ws);
  const sessions = new SessionStore(config.session.transcriptDir);
  const facts = new FactStore(ws, client);
  const tasks = new TaskStore(join(ws, 'tasks.json'), join(ws, 'TASKS.md'));
  const cron = new CronStore(join(root, 'data', 'cron.json'));
  const cronService = new CronService({ store: cron, onTrigger: async () => undefined, timezone: config.timezone });
  const registry = new ToolRegistry();
  const { embeddingStore } = await registerAllTools(registry, config, { ollamaClient: client, taskStore: tasks, factStore: facts, cronService });
  const webLog: string[] = [];
  for (const t of makeWebStubs(webLog)) registry.register(t);   // same names → replaces the real ones
  const pipelines = new PipelineRegistry();
  registerAllPipelines(pipelines);
  return { root, ws, config, client, registry, pipelines, sessions, facts, tasks, cron, webLog, embeddingStore };
}

// ---------------------------------------------------------------- tasks

interface CheckResult { name: string; pass: boolean; detail?: string }
interface TaskCtx extends Env { answer: string; result?: DispatchResult; researchDir: string; flowFacts?: Record<string, boolean | string> }

interface E2ETask {
  id: string;
  /** A scripted multi-message flow instead of one prompt; returns named facts the checks read. */
  flow?: (env: Env, send: (sessionKey: string, message: string, timeoutMs: number) => Promise<DispatchResult>) => Promise<Record<string, boolean | string>>;
  /** Category the router SHOULD pick (several accepted where two are defensible). */
  expect: string[];
  timeoutMs: number;
  /** Second turn in the same session, sent after the first answer is appended. */
  followUp?: string;
  prompt: string;
  fixtures?: (env: Env) => void;
  /** Perfect performer for --selftest: produces the state the checks look for, no model. */
  reference: (env: Env) => Promise<string> | string;
  check: (ctx: TaskCtx) => CheckResult[];
}

const read = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };
const clean = (s: string): string => stripThinkingTags(s).trim();
const has = (name: string, pass: boolean, detail?: string): CheckResult => ({ name, pass, detail });

const RESEARCH_PHRASES = [/Q4_K_M/i, /24\s?GB/i, /tokens per second/i, /speculative decoding/i, /llama\.cpp/i, /vLLM/i, /unified memory/i, /prefill|prompt processing/i];

const TASKS: E2ETask[] = [
  {
    id: 'chat-plain',
    expect: ['chat'],
    timeoutMs: 180_000,
    prompt: 'In two sentences: what is the difference between a Python list and a tuple?',
    reference: () => 'A list is mutable and a tuple is immutable. Tuples are hashable and can be dict keys.',
    check: ({ answer }) => [
      has('mentions mutability', /mutab|immutab|change/i.test(answer)),
      has('short (≤ 4 sentences)', (answer.match(/[.!?](\s|$)/g) ?? []).length <= 4, `${(answer.match(/[.!?](\s|$)/g) ?? []).length} sentences`),
    ],
  },
  {
    id: 'chat-exact-word',
    expect: ['chat'],
    timeoutMs: 120_000,
    prompt: 'Reply with exactly the single word READY and nothing else.',
    reference: () => 'READY',
    check: ({ answer }) => [has('exactly READY', /^\W*READY\W*$/.test(answer), JSON.stringify(answer.slice(0, 60)))],
  },
  {
    id: 'task-board',
    expect: ['task'],
    timeoutMs: 300_000,
    prompt: 'Add three tasks to my task board: "Renew SSL certificate" with high priority, "Water the plants" with low priority, and "Submit quarterly report" due 2026-08-28.',
    reference: env => {
      env.tasks.add({ title: 'Renew SSL certificate', priority: 'high' }, 'user');
      env.tasks.add({ title: 'Water the plants', priority: 'low' }, 'user');
      env.tasks.add({ title: 'Submit quarterly report', dueDate: '2026-08-28' }, 'user');
      return 'Added three tasks.';
    },
    check: ({ tasks }) => {
      const all = tasks.list();
      const ssl = all.find(t => /ssl/i.test(t.title));
      const plants = all.find(t => /plant/i.test(t.title));
      const report = all.find(t => /quarterly/i.test(t.title));
      return [
        has('three tasks exist', !!ssl && !!plants && !!report, `${all.length} tasks: ${all.map(t => t.title).join(' | ').slice(0, 120)}`),
        has('priorities correct', ssl?.priority === 'high' && plants?.priority === 'low', `${ssl?.priority}/${plants?.priority}`),
        has('due date correct', !!report?.dueDate?.startsWith('2026-08-28'), report?.dueDate),
      ];
    },
  },
  {
    id: 'memory-save-recall',
    expect: ['memory'],
    timeoutMs: 300_000,
    prompt: 'Remember this: my deployment freeze starts on 2026-09-01.',
    followUp: 'When does my deployment freeze start?',
    reference: async env => {
      const tool = env.registry.get('memory_save')!;
      await tool.execute({ content: 'Deployment freeze starts 2026-09-01', category: 'decision' }, { agentId: 'main', sessionKey: 'ref', workspacePath: env.ws, senderId: OWNER } as any);
      return 'Your deployment freeze starts on 2026-09-01.';
    },
    check: ({ ws, answer }) => {
      const walk = (dir: string): string => {
        let acc = '';
        try { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); acc += f.isDirectory() ? walk(p) : '\n' + read(p); } } catch { /* absent */ }
        return acc;
      };
      return [
        has('fact persisted', /2026-09-01/.test(walk(join(ws, 'memory')))),
        has('recalled in follow-up', /2026-09-01|september 1/i.test(answer), JSON.stringify(answer.slice(0, 100))),
      ];
    },
  },
  {
    id: 'exec-csv-revenue',
    expect: ['exec', 'multi'],
    timeoutMs: 420_000,
    prompt: 'The file sales.csv in my workspace has columns product,units,unit_price. Compute the total revenue (sum of units*unit_price) and write just the number to revenue.txt.',
    fixtures: env => writeFileSync(join(env.ws, 'sales.csv'), 'product,units,unit_price\nwidget,10,2.50\ngadget,4,12.00\nsprocket,7,3.00\n'),
    reference: env => { writeFileSync(join(env.ws, 'revenue.txt'), '94\n'); return 'Total revenue is 94, written to revenue.txt.'; },
    check: ({ ws }) => [has('revenue.txt = 94', /(^|[^\d.])94(\.0+)?([^\d]|$)/.test(read(join(ws, 'revenue.txt'))), JSON.stringify(read(join(ws, 'revenue.txt')).slice(0, 40)))],
  },
  {
    id: 'exec-fib-script',
    expect: ['exec', 'multi'],
    timeoutMs: 420_000,
    prompt: 'Write a python script fib.py in my workspace that prints the 20th Fibonacci number (fib(1)=1, fib(2)=1), run it with python3, and save its output to fib.txt.',
    reference: env => { writeFileSync(join(env.ws, 'fib.py'), 'a,b=1,1\nfor _ in range(18): a,b=b,a+b\nprint(b)\n'); writeFileSync(join(env.ws, 'fib.txt'), '6765\n'); return 'fib.txt contains 6765.'; },
    check: ({ ws }) => [
      has('fib.py exists', existsSync(join(ws, 'fib.py'))),
      has('fib.txt = 6765', /6765/.test(read(join(ws, 'fib.txt'))), JSON.stringify(read(join(ws, 'fib.txt')).slice(0, 40))),
    ],
  },
  {
    id: 'multi-release-notes',
    expect: ['multi', 'exec', 'task'],
    timeoutMs: 600_000,
    prompt: 'Read releases.txt in my workspace. Add a task to my task board to evaluate the new version (put the version number in the title). Then write notes/release-summary.md summarizing the actual changes listed.',
    fixtures: env => writeFileSync(join(env.ws, 'releases.txt'), [
      'v0.6.2 — 2026-08-18',
      '- Rust frontend rework: network ingress to tokenized handoff moved out of Python',
      '- MTP speculative decoding enabled by default (3 steps)',
      '- KV cache compression for long-context batches',
      '- Fixed a deadlock in continuous batching under abort storms',
    ].join('\n') + '\n'),
    reference: env => {
      env.tasks.add({ title: 'Evaluate v0.6.2' }, 'user');
      mkdirSync(join(env.ws, 'notes'), { recursive: true });
      writeFileSync(join(env.ws, 'notes', 'release-summary.md'), '# v0.6.2\n\nRust frontend rework moves ingress out of Python. Speculative decoding now default. KV cache compression added; batching deadlock fixed.\n');
      return 'Task added and notes written.';
    },
    check: ({ ws, tasks }) => {
      const task = tasks.list().find(t => /0\.6\.2/.test(t.title));
      const note = read(join(ws, 'notes', 'release-summary.md'));
      const hits = [/rust\s+frontend/i, /speculative\s+decoding/i, /kv\s+cache/i, /deadlock/i].filter(p => p.test(note)).length;
      return [
        has('task with version', !!task, tasks.list().map(t => t.title).join(' | ').slice(0, 100)),
        has('summary covers ≥2 changes', hits >= 2, `${hits}/4 phrases, ${note.length} chars`),
      ];
    },
  },
  {
    id: 'cron-schedule',
    expect: ['cron'],
    timeoutMs: 300_000,
    prompt: 'Every weekday at 8am, remind me to check the build dashboard.',
    reference: env => { env.cron.add({ name: 'Check build dashboard', type: 'cron', schedule: '0 8 * * 1-5', message: 'Remind me to check the build dashboard', category: 'chat', delivery: { channel: 'web', target: 'e2e' } }); return 'Scheduled.'; },
    check: ({ cron }) => {
      const jobs = cron.list(true);
      const job = jobs.find(j => /dashboard|build/i.test(`${j.name} ${j.message}`));
      const parts = (job?.schedule ?? '').trim().split(/\s+/);
      const weekday8 = parts.length >= 5 && parts[1] === '8' && /^(1-5|mon-fri|1,2,3,4,5)$/i.test(parts[4]);
      return [
        has('job created', !!job, `${jobs.length} jobs`),
        has('weekday 8am schedule', weekday8, job?.schedule),
      ];
    },
  },
  {
    id: 'web-fact-to-file',
    expect: ['web_search', 'multi'],
    timeoutMs: 420_000,
    prompt: 'Find the year Node.js was first released (search the web if you need to) and write just the year to node-year.txt in my workspace.',
    reference: async env => {
      await env.registry.get('web_search')!.execute({ query: 'Node.js first release year' }, {} as any);
      writeFileSync(join(env.ws, 'node-year.txt'), '2009\n');
      return 'Node.js was first released in 2009.';
    },
    check: ({ ws, answer, webLog }) => [
      has('searched the web', webLog.some(l => l.startsWith('web_search(')), webLog.join('; ').slice(0, 100)),
      has('year in file or answer', /2009/.test(read(join(ws, 'node-year.txt'))) || /2009/.test(answer), JSON.stringify(read(join(ws, 'node-year.txt')).slice(0, 20))),
    ],
  },
  {
    id: 'website-summarize',
    expect: ['website', 'web_search'],
    timeoutMs: 300_000,
    prompt: 'Summarize https://example-docs.test/guide in three bullet points.',
    reference: async env => {
      const page = await env.registry.get('web_fetch')!.execute({ url: 'https://example-docs.test/guide' }, {} as any);
      if (!/8443/.test(page)) throw new Error(`stub fetch returned: ${page.slice(0, 80)}`);
      return '- Listens on port 8443 with TLS\n- Config reloads on SIGHUP\n- Nightly backups at 02:00 UTC, kept 30 days';
    },
    check: ({ answer, webLog }) => {
      const hits = [/8443/, /SIGHUP/i, /02:00|2\s?am|nightly/i, /30 days/i, /healthz/i].filter(p => p.test(answer)).length;
      return [
        has('fetched the page', webLog.some(l => l.includes('example-docs.test/guide')), webLog.join('; ').slice(0, 100)),
        has('≥2 facts from the page', hits >= 2, `${hits}/5`),
        has('no invented facts (no port other than 8443)', !/\b(80|443|8080|3000)\b/.test(answer)),
      ];
    },
  },
  {
    id: 'confirm-ledger',
    expect: ['task'],
    timeoutMs: 300_000,
    prompt: 'Add a task to my task board: "Rotate the API keys" with high priority.',
    flow: async (env, send) => {
      const facts: Record<string, boolean | string> = {};
      // The ONE thing this task adds beyond the wizard's output: a confirm gate on task_add for
      // the web channel, so the ledger path is exercised end to end. Only HERE — when it was
      // applied to every env (2026-09-28) the task-board and multi tasks of every model "failed"
      // because task_add correctly returned a confirmation preview instead of adding the task.
      env.config.channels.web = { ...env.config.channels.web, security: { ...(env.config.channels.web?.security ?? {}), confirmTools: ['task_add'] } } as typeof env.config.channels.web;
      const first = await send('e2e-confirm', 'Add a task to my task board: "Rotate the API keys" with high priority.', 300_000);
      facts.routed = first.category;
      const pending = first.pendingActions?.[0];
      facts.previewOffered = !!pending && /confirm/i.test(first.answer);
      facts.gateHeld = !env.tasks.list().some(t => /api keys/i.test(t.title));
      if (!pending) return facts;
      // sender-bound: a stranger holding the id must not be able to execute it
      const stranger = await handleConfirmation({ message: `confirm ${pending.id}`, senderId: 'stranger', channel: 'web', config: env.config, toolRegistry: env.registry, sessionStore: env.sessions });
      facts.strangerRejected = !stranger.executed && !env.tasks.list().some(t => /api keys/i.test(t.title));
      const owner = await handleConfirmation({ message: `confirm ${pending.id}`, senderId: OWNER, channel: 'web', config: env.config, toolRegistry: env.registry, sessionStore: env.sessions });
      facts.ownerExecuted = !!owner.executed && env.tasks.list().some(t => /api keys/i.test(t.title) && t.priority === 'high');
      // single-use: the same id again must not run twice
      const again = await handleConfirmation({ message: `confirm ${pending.id}`, senderId: OWNER, channel: 'web', config: env.config, toolRegistry: env.registry, sessionStore: env.sessions });
      facts.singleUse = !again.executed && env.tasks.list().filter(t => /api keys/i.test(t.title)).length === 1;
      return facts;
    },
    reference: env => { env.tasks.add({ title: 'Rotate the API keys', priority: 'high' }, 'user'); return 'Preview shown, then confirmed.'; },
    check: ({ flowFacts, tasks }) => {
      const f = flowFacts ?? { routed: 'task', previewOffered: true, gateHeld: true, strangerRejected: true, ownerExecuted: tasks.list().some(t => /api keys/i.test(t.title)), singleUse: true };
      return [
        has('confirm preview offered (no execution)', f.previewOffered === true && f.gateHeld === true),
        has('stranger cannot confirm (sender-bound)', f.strangerRejected === true),
        has('owner confirm executes the STORED call', f.ownerExecuted === true),
        has('single-use (second confirm does nothing)', f.singleUse === true),
      ];
    },
  },
  {
    id: 'research-report',
    expect: ['research'],
    timeoutMs: 1_800_000,
    prompt: 'Write me a research report on the state of local LLM inference on consumer GPUs in 2026: what fits on which cards, quantization tradeoffs, and serving stacks.',
    reference: async env => {
      // the perfect performer does what the pipeline does: search, fetch, write from sources
      const hits = await env.registry.get('web_search')!.execute({ query: 'local LLM inference consumer GPUs quantization serving stacks' }, {} as any);
      const urls = [...new Set(hits.match(/https?:\/\/[^\s)"\]]+/g) ?? [])].slice(0, 3);
      const pages = await Promise.all(urls.map(u => env.registry.get('web_fetch')!.execute({ url: u }, {} as any)));
      const dir = join(env.ws, 'research', 'local-llm-inference');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'report.md'), `# Local LLM inference on consumer GPUs\n\n${pages.map(p => p.slice(0, 400)).join('\n\n')}\n\nA 24GB card runs 27B at Q4_K_M near 40 tokens per second. llama.cpp and vLLM differ on batching; speculative decoding helps; unified memory trades bandwidth for capacity.\n\n## Sources\n${urls.join('\n')}\n`);
      // the real document tool, the way convert_pdf calls it — only where LibreOffice exists
      if (SOFFICE) {
        const out = await env.registry.get('document')!.execute({ action: 'create', content: '<html><body><h1>Report</h1><p>selftest</p></body></html>', format: 'pdf', filename: 'local-llm-inference' }, { agentId: 'main', sessionKey: 'ref', workspacePath: env.ws } as any);
        if (/^Error/.test(out)) throw new Error(`document tool: ${out.slice(0, 120)}`);
      }
      return 'Report written.';
    },
    check: ctx => {
      const { ws, answer, webLog } = ctx;
      const dir = join(ws, 'research');
      let text = '';
      const walk = (d: string) => { try { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(md|html|txt)$/.test(f.name)) text += '\n' + read(p); } } catch { /* absent */ } };
      walk(dir);
      const phrases = RESEARCH_PHRASES.filter(p => p.test(text)).length;
      const cited = CORPUS.filter(p => text.includes(p.url)).length;
      const aborted = /couldn't produce the research report|every web search came back empty/i.test(answer);
      const docs = join(ctx.root, 'data', 'media', 'documents');
      const pdf = existsSync(docs) && readdirSync(docs).some(f => f.endsWith('.pdf'));
      // No LibreOffice on this box (CI): the pipeline cannot render a PDF anywhere, so the check
      // is not a model result — it is skipped with the reason instead of failing the model.
      const pdfCheck = SOFFICE ? has('PDF delivered (document tool reachable from the research specialist)', pdf)
        : has('PDF delivered — skipped: no LibreOffice on this box', true, 'soffice not found');
      return [
        has('pipeline ran to a report (not the evidence-gate abort)', !aborted && text.length > 500, `${text.length} chars of report text, ${webLog.length} web calls`),
        has('report uses ≥3 corpus facts', phrases >= 3, `${phrases}/${RESEARCH_PHRASES.length}`),
        has('cites ≥2 corpus URLs', cited >= 2, `${cited} cited`),
        pdfCheck,
      ];
    },
  },
];

// ---------------------------------------------------------------- running

interface TaskRecord {
  id: string; expected: string[]; routed?: string; routedBy?: string;
  /** A provider outage that survived one retry: excluded from means, reported separately. */
  unscored?: boolean;
  checks: CheckResult[]; score: number; durationMs: number;
  promptTokens: number; completionTokens: number; modelCalls: number;
  iterations?: number; hitMaxIterations?: boolean; error?: string; bucket?: string;
  answer: string; webCalls: string[];
}
interface ModelRecord {
  model: string; profile: string; think?: boolean;
  configTokens: { specialists: number }; reps: TaskRecord[][];
  taskScores: Record<string, number>; categoryScores: Record<string, number>; overall: number; totalMs: number;
}

const meter = { prompt: 0, completion: 0, calls: 0 };
function instrument(client: OllamaClient): void {
  const orig = client.chat.bind(client);
  (client as any).chat = async (params: Record<string, unknown>) => {
    meter.calls++;
    const res = await orig(params as Parameters<typeof orig>[0]);
    const r = res as unknown as { eval_count?: number; prompt_eval_count?: number };
    meter.completion += r.eval_count ?? 0;
    meter.prompt += r.prompt_eval_count ?? 0;
    return res;
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms / 1000}s: ${label}`)), ms).unref())]);
}
function bucketOf(msg: string): string {
  if (/^TIMEOUT after/.test(msg)) return 'TIMEOUT';
  if (/503|500 Internal Server Error|prediction aborted|ECONNREFUSED|EHOSTUNREACH|fetch failed|socket hang up/i.test(msg)) return 'PROVIDER_OUTAGE';
  if (/400 Bad Request/.test(msg)) return 'SERVING_INCOMPATIBLE';
  return 'MODEL_FAILURE';
}

async function send(env: Env, sessionKey: string, message: string, timeoutMs: number, label: string): Promise<DispatchResult> {
  const result = await withTimeout(dispatchMessage({
    client: env.client, registry: env.registry, config: env.config, message,
    agentId: env.config.agents.default, sessionKey, sessionStore: env.sessions,
    pipelineRegistry: env.pipelines, factStore: env.facts,
    sourceContext: { channel: 'web', channelId: 'e2e', senderId: OWNER },
  }), timeoutMs, label);
  // The orchestrator/console append the exchange after delivery; do the same so a
  // follow-up turn sees history the way a real second message would.
  const now = new Date().toISOString();
  env.sessions.appendTurn(env.config.agents.default, sessionKey, { role: 'user', content: message, timestamp: now, category: result.category, routedBy: result.classification?.confidence });
  env.sessions.appendTurn(env.config.agents.default, sessionKey, { role: 'assistant', content: result.answer, timestamp: now, category: result.category });
  return result;
}

async function runTask(model: string, ollamaUrl: string, task: E2ETask, rep: number, runDir: string, attempt = 0): Promise<TaskRecord> {
  const env = await makeEnv(model, ollamaUrl);
  task.fixtures?.(env);
  const sessionKey = `e2e-${task.id}-${rep}`;
  const m0 = { ...meter };
  const start = Date.now();
  let result: DispatchResult | undefined;
  let answer = '';
  let error: string | undefined;
  let facts: Record<string, boolean | string> | undefined;
  try {
    if (task.flow) {
      facts = await task.flow(env, (sk, message, timeoutMs) => send(env, sk, message, timeoutMs, `${model} ${task.id}`).then(r => { result = r; answer = clean(r.answer); return r; }));
    } else {
      result = await send(env, sessionKey, task.prompt, task.timeoutMs, `${model} ${task.id}`);
      answer = clean(result.answer);
      if (task.followUp) {
        const second = await send(env, sessionKey, task.followUp, task.timeoutMs, `${model} ${task.id} follow-up`);
        answer = clean(second.answer);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ctx: TaskCtx = { ...env, answer, result, researchDir: join(env.ws, 'research'), flowFacts: facts };
  if (error && bucketOf(error) === 'PROVIDER_OUTAGE' && attempt === 0) {
    // the serving stack, not the model — one retry after a pause, then unscored
    console.log(`    provider outage on ${task.id} (${error.slice(0, 60)}) — retrying once in 20s`);
    teardown(env);
    await new Promise(r => setTimeout(r, 20_000));
    return runTask(model, ollamaUrl, task, rep, runDir, 1);
  }
  const checks: CheckResult[] = error
    ? [has('completed without error', false, error.slice(0, 160))]
    : [
      has(`routed to ${task.expect.join('|')}`, task.expect.includes(result!.category), result!.category),
      ...task.check(ctx),
      has('non-empty answer', answer.length > 0),
      has('no scaffolding leak', !/Thought:|Final Answer:|Action:/.test(answer)),
    ];
  const score = checks.filter(c => c.pass).length / checks.length;
  // keep the artifacts a human would want to read
  const keep = join(runDir, 'artifacts', model.replace(/[^a-z0-9.]/gi, '_'), `${task.id}-rep${rep + 1}`);
  mkdirSync(keep, { recursive: true });
  writeFileSync(join(keep, 'answer.txt'), answer);
  if (existsSync(join(env.ws, 'research'))) cpSync(join(env.ws, 'research'), join(keep, 'research'), { recursive: true });
  teardown(env);
  return {
    id: task.id, expected: task.expect, routed: result?.category, routedBy: result?.classification?.confidence,
    checks, score, durationMs: Date.now() - start,
    promptTokens: meter.prompt - m0.prompt, completionTokens: meter.completion - m0.completion, modelCalls: meter.calls - m0.calls,
    iterations: result?.iterations, hitMaxIterations: result?.hitMaxIterations,
    error, bucket: error ? bucketOf(error) : undefined, unscored: !!error && bucketOf(error) === 'PROVIDER_OUTAGE',
    answer: answer.slice(0, 1500), webCalls: env.webLog,
  };
}

async function selftest(): Promise<void> {
  console.log('SELFTEST — scripted perfect performer through every oracle, no model');
  let failures = 0;
  for (const task of TASKS) {
    if (TASK_FILTER && task.id !== TASK_FILTER) continue;
    const env = await makeEnv('selftest-model', 'http://127.0.0.1:1');
    task.fixtures?.(env);
    const answer = await task.reference(env);
    const checks = task.check({ ...env, answer, researchDir: join(env.ws, 'research') });   // facts undefined → the check's reference defaults
    const bad = checks.filter(c => !c.pass);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${task.id}${bad.length ? ' — ' + bad.map(c => `${c.name} (${c.detail ?? ''})`).join('; ') : ''}`);
    failures += bad.length;
    teardown(env);
  }
  if (failures) { console.error(`${failures} oracle(s) fail on the reference performer — fix the checks before trusting a score`); process.exit(1); }
  console.log('all oracles pass on the reference performer');
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function report(results: ModelRecord[], prov: Record<string, unknown>): string {
  let md = `# End-to-end eval — ${DATE} · profile=${PROFILE} · workspace=${WORKSPACE}\n\nEvery task through \`dispatchMessage\` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **${PROFILE}** (\`wizard\` = what the wizard writes for the model's tier). Workspace: **${WORKSPACE}**. Reps: ${REPS}.\n\n`;
  md += `| # | Model | Overall | ${TASKS.map(t => t.id).join(' | ')} | prompt tok/battery | wall |\n|---|---|---|${TASKS.map(() => '---').join('|')}|---|---|\n`;
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  for (const [i, r] of sorted.entries()) {
    const ptok = r.reps.flat().reduce((s, t) => s + t.promptTokens, 0) / Math.max(1, r.reps.length);
    md += `| ${i + 1} | ${r.model} | **${pct(r.overall)}** | ${TASKS.map(t => pct(r.taskScores[t.id] ?? 0)).join(' | ')} | ${Math.round(ptok).toLocaleString()} | ${(r.totalMs / 60000).toFixed(1)}m |\n`;
  }
  md += `\n## By category\n\n| Model | ${Object.keys(sorted[0]?.categoryScores ?? {}).join(' | ')} |\n|---|${Object.keys(sorted[0]?.categoryScores ?? {}).map(() => '---').join('|')}|\n`;
  for (const r of sorted) md += `| ${r.model} | ${Object.values(r.categoryScores).map(pct).join(' | ')} |\n`;
  for (const r of sorted) {
    md += `\n## ${r.model}\n\n| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |\n|---|---|---|---|---|---|---|\n`;
    for (const t of r.reps[0] ?? []) {
      const failed = t.checks.filter(c => !c.pass).map(c => `✗ ${c.name}${c.detail ? ` (${t.error ? c.detail : c.detail})` : ''}`).join('; ');
      md += `| ${t.id} | ${pct(t.score)} | ${t.routed ?? '—'}${t.expected.includes(t.routed ?? '') ? '' : ' ⚠'} | ${failed || 'all pass'} | ${t.modelCalls} | ${t.promptTokens.toLocaleString()} | ${(t.durationMs / 1000).toFixed(0)}s |\n`;
    }
    md += `\n<details><summary>Answers (rep 1)</summary>\n\n`;
    for (const t of r.reps[0] ?? []) md += `**${t.id}** — web: ${t.webCalls.join(', ') || 'none'}\n\n\`\`\`\n${t.answer.slice(0, 800)}\n\`\`\`\n\n`;
    md += `</details>\n`;
  }
  md += `\n---\nProvenance: ${JSON.stringify(prov)}\n`;
  return md;
}

async function main(): Promise<void> {
  SOFFICE = (await detectLibreOffice()).found;
  if (!SOFFICE) console.log('No LibreOffice on this box — the research PDF check is skipped with that reason (the pipeline cannot render one here)');
  if (SELFTEST) { await selftest(); return; }
  if (!MODELS.length) { console.error('usage: npx tsx scripts/e2e-eval.ts <model> [model ...] [--reps=1] [--task=id] | --selftest'); process.exit(2); }
  mkdirSync(RUN_DIR, { recursive: true });
  // Never the live config: this is a fresh install's view. OLLAMA_URL picks the host.
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const warm = createInferenceClient(ollamaUrl, undefined, [], [], undefined);   // warmup only; every task builds its own from its config
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { /* not fatal */ }
  const prov = { date: new Date().toISOString(), gitCommit, ollamaUrl, reps: REPS, profile: PROFILE, workspace: WORKSPACE, tasks: TASKS.map(t => t.id) };
  const tasks = TASK_FILTER ? TASKS.filter(t => t.id === TASK_FILTER) : TASKS;
  console.log(`E2E eval — ${MODELS.length} model(s) × ${tasks.length} task(s) × ${REPS} rep(s) · profile=${PROFILE} workspace=${WORKSPACE} → ${RUN_DIR}`);

  const results: ModelRecord[] = [];
  for (const model of MODELS) {
    const modelStart = Date.now();
    console.log(`\n================ ${model} ================`);
    try {
      await withTimeout(warm.chat({ model, messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 4, num_ctx: contextSizeForTier(PROFILE === 'wizard' ? foregroundTier(model) : PROFILE) } }), 300_000, `${model} warmup`);
    } catch (err) { console.log(`  warmup FAILED: ${err instanceof Error ? err.message : err}`); }
    const reps: TaskRecord[][] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const recs: TaskRecord[] = [];
      for (const task of tasks) {
        const rec = await runTask(model, ollamaUrl, task, rep, RUN_DIR);
        recs.push(rec);
        const bad = rec.checks.filter(c => !c.pass).map(c => c.name).join(', ');
        console.log(`  ${rec.id}: ${rec.unscored ? 'UNSCORED' : pct(rec.score)} routed=${rec.routed ?? '—'} calls=${rec.modelCalls} ptok=${rec.promptTokens} ${(rec.durationMs / 1000).toFixed(0)}s${bad ? ` — ✗ ${bad}` : ''}${rec.error ? ` [${rec.bucket}] ${rec.error.slice(0, 80)}` : ''}`);
      }
      reps.push(recs);
    }
    const taskScores: Record<string, number> = {};
    for (const t of tasks) {
      const rs = reps.map(r => r.find(x => x.id === t.id)).filter((x): x is TaskRecord => !!x && !x.unscored).map(x => x.score);
      if (rs.length) taskScores[t.id] = rs.reduce((a, b) => a + b, 0) / rs.length;   // an outage-only task is absent from the mean, not a zero
    }
    const categoryScores: Record<string, number> = {};
    for (const cat of [...new Set(tasks.map(t => t.expect[0]))]) {
      const ids = tasks.filter(t => t.expect[0] === cat).map(t => t.id);
      categoryScores[cat] = ids.reduce((s, id) => s + taskScores[id], 0) / ids.length;
    }
    const overall = Object.values(taskScores).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(taskScores).length);
    const think = thinkFor(findMeasured(model));
    results.push({ model, profile: PROFILE === 'wizard' ? `wizard→${foregroundTier(model)}` : PROFILE, think, configTokens: { specialists: 0 }, reps, taskScores, categoryScores, overall, totalMs: Date.now() - modelStart });
    console.log(`  OVERALL: ${pct(overall)} · ${Object.entries(categoryScores).map(([k, v]) => `${k} ${pct(v)}`).join(' · ')} · ${((Date.now() - modelStart) / 60000).toFixed(1)}m`);
    writeFileSync(join(RUN_DIR, 'results.json'), JSON.stringify({ provenance: prov, results }, null, 2));
    writeFileSync(join(RUN_DIR, 'report.md'), report(results, prov));
  }
  console.log(`\nE2E COMPLETE — report: ${join(RUN_DIR, 'report.md')}`);
}

// registerAllTools opens stores with timers (quota, ledger, sqlite) that keep the loop alive — exit explicitly.
main().then(() => process.exit(0)).catch(err => { console.error('E2E eval failed to run:', err instanceof Error ? err.stack ?? err.message : err); process.exit(1); });
