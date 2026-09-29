/**
 * The battery: twelve tasks, each a real request through the front door, scored by code
 * oracles over the workspace, the stores, the routed category and the answer — never a judge.
 * Every task carries a `reference` performer; `--selftest` runs it through the same checks
 * with no model, so a wrong check cannot masquerade as a model failure.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DispatchResult } from '../../src/dispatch.js';
import { stripThinkingTags } from '../../src/utils/text.js';
import { handleConfirmation } from '../../src/security/confirm-handler.js';
import { CORPUS } from './corpus.js';
import { OWNER, type Env } from './install.js';

export interface CheckResult { name: string; pass: boolean; detail?: string }
export interface TaskCtx extends Env { answer: string; result?: DispatchResult; researchDir: string; flowFacts?: Record<string, boolean | string> }

export interface E2ETask {
  id: string;
  /** A scripted multi-message flow instead of one prompt; returns named facts the checks read. */
  flow?: (env: Env, send: (sessionKey: string, message: string, timeoutMs: number) => Promise<DispatchResult>) => Promise<Record<string, boolean | string>>;
  /** Categories that can finish the request — a route that guarantees a half-job is not accepted. */
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
export const clean = (s: string): string => stripThinkingTags(s).trim();
export const has = (name: string, pass: boolean, detail?: string): CheckResult => ({ name, pass, detail });

const RESEARCH_PHRASES = [/Q4_K_M/i, /24\s?GB/i, /tokens per second/i, /speculative decoding/i, /llama\.cpp/i, /vLLM/i, /unified memory/i, /prefill|prompt processing/i];

export const TASKS: E2ETask[] = [
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
    // Needs read_file + task_add + write_file: only multi holds all three (task has no file
    // tools, exec has no task board). Accepting task/exec scored a guaranteed half-job as routed.
    expect: ['multi'],
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
    // Needs web_search + write_file: web_search cannot write files, exec cannot search.
    expect: ['multi'],
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
      if (env.canRenderPdf) {
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
      const pdfCheck = ctx.canRenderPdf ? has('PDF delivered (document tool reachable from the research specialist)', pdf)
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
