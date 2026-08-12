/**
 * Model eval harness (publishable) — runs every 20-33B model on the gateway
 * through the SAME fixed task battery, repeated REPS times, scored with
 * deterministic code checks, with error-taxonomy separation so infrastructure
 * failures can never masquerade as model failures.
 *
 * Dimensions:
 *   toolloop  — runToolLoop with MOCK tools (canned observations, identical for
 *               every model): single call, two-step chain, restraint-under-repair-
 *               prompt (engine-in-the-loop), error honesty, 9-hop long-horizon chain
 *   extract   — extractParams (grammar-constrained, 2048-token budget) on
 *               cron/message/nested schemas
 *   chat      — instruction discipline: stop rule, exact format, bare-JSON
 *   speed     — 3 generation samples, median tok/s. SERVING-STACK METRIC ONLY.
 *
 * Failure taxonomy (per task, per rep):
 *   MODEL_FAILURE        — checks failed; scored normally
 *   TIMEOUT              — exceeded task SLO; scored 0, labeled
 *   SERVING_INCOMPATIBLE — HTTP 400 from serving path; scored 0, labeled loudly
 *   PROVIDER_OUTAGE      — 503/unreachable; retried once after 30s, then the rep
 *                          is UNSCORED (excluded from means, reported separately)
 *
 * Subjective prose quality is intentionally unscored — raw outputs (rep 1) land
 * in the report for human side-by-side review.
 *
 * Usage: npx tsx scripts/model-eval.ts [model ...]   (default: full field + any
 *        nemotron-3.5-lightning tag present on the gateway at launch)
 * NOTE: node needs LAN access — run inside the `lab` tmux session.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { runToolLoop } from '../src/tool-loop/engine.js';
import { extractParams } from '../src/pipeline/extractor.js';
import { stripThinkingTags } from '../src/utils/text.js';
import type { OllamaClient } from '../src/ollama/client.js';
import type { ToolDefinition, ToolExecutor, ToolContext } from '../src/tools/types.js';
import type { ExtractFieldSchema } from '../src/pipeline/types.js';

const REPS = 3;
const SPEED_SAMPLES = 3;

// ------------------------------------------------------------- think + tokens
// Row syntax: "model@think=false" / "model@think=true" / bare (engine default).
// The client is patched per row: `think` injected into every chat call
// (engine, extractor, chat, code alike), and completion/prompt tokens metered
// so each task carries its hardware-independent cost.

interface ModelRow { label: string; name: string; think?: boolean }

function parseModelArg(arg: string): ModelRow {
  const m = arg.match(/^(.*)@think=(true|false)$/);
  if (!m) return { label: arg, name: arg };
  return { label: arg, name: m[1], think: m[2] === 'true' };
}

const tokenMeter = { completion: 0, prompt: 0 };
let currentThink: boolean | undefined;

/** Probe which think modes a model accepts. Ollama rejects `think` on
 *  non-thinking models and `think:false` on forced-thinking models. */
async function probeThinkModes(client: OllamaClient, name: string, noThinkControl: Set<string>): Promise<Array<boolean | undefined>> {
  if (noThinkControl.has(name)) {
    console.log(`  ${name}: served via direct OpenAI-compat path (ds4) — no per-request think-control, single default row`);
    return [undefined];
  }
  const accepts = async (v: boolean): Promise<boolean> => {
    try {
      currentThink = v;
      await client.chat({ model: name, messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 8 } });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/think/i.test(msg)) return false;
      throw err; // non-think error (outage etc.) — surface it
    } finally {
      currentThink = undefined;
    }
  };
  try {
    const canOn = await accepts(true);
    const canOff = await accepts(false);
    if (canOn && canOff) return [true, false];
    if (canOn) {
      console.log(`  ${name}: thinking supported but cannot be disabled — single @think=on row`);
      return [true];
    }
    return [undefined];
  } catch (err) {
    console.warn(`  ${name}: think probe failed (${err instanceof Error ? err.message.slice(0, 80) : err}) — single default row`);
    return [undefined];
  }
}

function rowFor(name: string, mode: boolean | undefined, capable: boolean): ModelRow {
  if (mode === undefined) return { name, label: capable ? name : `${name} (no think)` };
  return { name, think: mode, label: `${name}@think=${mode ? 'on' : 'off'}` };
}

/** Patch client.chat once: inject per-row think, meter token usage. */
function instrumentClient(client: OllamaClient): void {
  const orig = client.chat.bind(client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).chat = async (params: Record<string, unknown>) => {
    const body = currentThink === undefined ? params : { ...params, think: currentThink };
    const res = await orig(body as Parameters<typeof orig>[0]);
    const r = res as unknown as { eval_count?: number; prompt_eval_count?: number };
    tokenMeter.completion += r.eval_count ?? 0;
    tokenMeter.prompt += r.prompt_eval_count ?? 0;
    return res;
  };
}

const DEFAULT_MODELS = [
  'muse-glimmer:latest',
  'gpt-oss:20b',
  'devstral:24b',
  'gemma4:26b',
  'qwen3.5:27b',
  'qwen3.6:27b',
  'glm-4.7-flash:latest',
  'qwen3-coder:30b',
  'gemma4:31b',
  'nemotron-3-nano:30b',
  'nemotron-cascade-2:30b',
  'qwen3:32b',
  'qwen2.5-coder:32b',
  'deepseek-coder:33b',
  'nemotron3:33b',
  // Above-class anchor: publicly benchmarked against this class; prod briefing model
  'qwen3.6:35b',
];

const HARDWARE_NOTE =
  'All throughput/latency figures reflect THIS serving topology only — TWO distinct paths: '
  + '(1) Ollama fleet (DGX Spark cluster) behind a FastAPI gateway proxy (per-box Ollama '
  + '0.32.9/0.30.8; one legacy 0.12.5 box), Q4_K_M/MXFP4 quantizations; '
  + '(2) deepseek-v4-flash served DIRECTLY by ds4/DwarfStar (github.com/antirez/ds4, '
  + 'OpenAI-compat, no gateway in path) — cross-comparisons with it span different stacks. '
  + 'None of these figures are intrinsic model properties; they will not transfer to other '
  + 'hardware, quants, or serving engines.';

const RUN_DIR = join('data', 'model-eval', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
mkdirSync(RUN_DIR, { recursive: true });

// ---------------------------------------------------------------- failure taxonomy

type FailureBucket = 'MODEL_FAILURE' | 'TIMEOUT' | 'SERVING_INCOMPATIBLE' | 'PROVIDER_OUTAGE';

function classifyError(msg: string): FailureBucket {
  if (/^TIMEOUT after/.test(msg)) return 'TIMEOUT';
  if (/503|all_providers_unavailable|ECONNREFUSED|EHOSTUNREACH|fetch failed|socket hang up/i.test(msg)) return 'PROVIDER_OUTAGE';
  if (/400 Bad Request/.test(msg)) return 'SERVING_INCOMPATIBLE';
  return 'MODEL_FAILURE';
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Run a task fn; on PROVIDER_OUTAGE retry once after 30s. Meters completion
 *  tokens across the whole attempt (retries included — real cost). */
async function withOutageRetry(run: () => Promise<TaskResult>): Promise<TaskResult> {
  const tok0 = tokenMeter.completion;
  const attach = (r: TaskResult): TaskResult => ({ ...r, completionTokens: tokenMeter.completion - tok0 });
  const first = await run();
  if (first.error && classifyError(first.error) === 'PROVIDER_OUTAGE') {
    console.log('    provider outage — retrying task once in 30s...');
    await sleep(30_000);
    const second = await run();
    if (second.error && classifyError(second.error) === 'PROVIDER_OUTAGE') {
      return attach({ ...second, bucket: 'PROVIDER_OUTAGE', unscored: true });
    }
    return attach(second);
  }
  return attach(first);
}

// ---------------------------------------------------------------- mock tools

const MOCK_TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city. WHEN TO USE: user asks about current weather or temperature.',
    parameterDescription: '{"city": "city name"}',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
  },
  {
    name: 'order_lookup',
    description: 'Look up an order by its order ID. Returns status, tracking number, and customer contact info.',
    parameterDescription: '{"orderId": "order id like A-1439"}',
    parameters: { type: 'object', properties: { orderId: { type: 'string', description: 'Order ID' } }, required: ['orderId'] },
  },
  {
    name: 'send_email',
    description: 'Send an email. WHEN TO USE: user asks to email someone. Requires recipient address, subject, and body.',
    parameterDescription: '{"to": "email", "subject": "...", "body": "..."}',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch the contents of a URL.',
    parameterDescription: '{"url": "https://..."}',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] },
  },
  {
    name: 'follow_clue',
    description: 'Follow a clue in a treasure hunt. Requires the clue ID and the access code obtained from the PREVIOUS clue. Returns the next clue and its access code.',
    parameterDescription: '{"clueId": "clue name", "code": "access code from previous step"}',
    parameters: {
      type: 'object',
      properties: {
        clueId: { type: 'string', description: 'The clue ID to follow' },
        code: { type: 'string', description: 'Access code obtained from the previous clue' },
      },
      required: ['clueId', 'code'],
    },
  },
];

/** 9-hop dependency chain — each observation carries the code the NEXT call needs.
 *  Tests long-horizon consistency: carrying fresh state forward without drift. */
const CLUE_CHAIN: Record<string, { expectCode: string; next?: string; nextCode?: string }> = {
  START:      { expectCode: '0000', next: 'LIGHTHOUSE', nextCode: 'R7K2' },
  LIGHTHOUSE: { expectCode: 'R7K2', next: 'ORCHARD',    nextCode: 'M3W9' },
  ORCHARD:    { expectCode: 'M3W9', next: 'MILL',       nextCode: 'T6B4' },
  MILL:       { expectCode: 'T6B4', next: 'HARBOR',     nextCode: 'J8N5' },
  HARBOR:     { expectCode: 'J8N5', next: 'CHAPEL',     nextCode: 'V2F7' },
  CHAPEL:     { expectCode: 'V2F7', next: 'QUARRY',     nextCode: 'L9D3' },
  QUARRY:     { expectCode: 'L9D3', next: 'BRIDGE',     nextCode: 'X4H8' },
  BRIDGE:     { expectCode: 'X4H8', next: 'FINAL',      nextCode: 'P5C6' },
  FINAL:      { expectCode: 'P5C6' },
};

interface CallLogEntry { tool: string; params: Record<string, unknown> }

function makeExecutor(log: CallLogEntry[]): ToolExecutor {
  return async (name, params) => {
    log.push({ tool: name, params });
    switch (name) {
      case 'get_weather':
        return JSON.stringify({ city: params.city ?? 'unknown', temp_f: 61, temp_c: 16, conditions: 'cloudy', wind_mph: 8 });
      case 'order_lookup':
        return JSON.stringify({
          orderId: params.orderId ?? 'unknown', status: 'shipped', carrier: 'UPS',
          tracking: '1Z999AA10123456784', eta: '2026-08-13', customerEmail: 'dana@example.com', customerName: 'Dana',
        });
      case 'send_email':
        return JSON.stringify({ ok: true, messageId: 'msg-20260811-001' });
      case 'web_fetch':
        return 'Error: HTTP 404 Not Found — the requested URL does not exist on this server.';
      case 'follow_clue': {
        const clueId = String(params.clueId ?? '').toUpperCase().trim();
        const code = String(params.code ?? '').toUpperCase().trim();
        const clue = CLUE_CHAIN[clueId];
        if (!clue) return `Error: unknown clue "${clueId}".`;
        if (code !== clue.expectCode) return `Error: wrong access code for clue ${clueId}. The code comes from the previous clue's result.`;
        if (!clue.next) return JSON.stringify({ done: true, treasure: 'AZIMUTH', message: 'You found the treasure!' });
        return JSON.stringify({ clue: clueId, next: clue.next, code: clue.nextCode });
      }
      default:
        return `Error: Tool "${name}" is not available.`;
    }
  };
}

// ---------------------------------------------------------------- result plumbing

interface CheckResult { name: string; pass: boolean }
interface TaskResult {
  id: string;
  dimension: 'toolloop' | 'extract' | 'chat' | 'code';
  checks: CheckResult[];
  score: number;
  durationMs: number;
  raw: string;
  error?: string;
  bucket?: FailureBucket;
  unscored?: boolean;
  /** Completion tokens consumed by this task (all calls, retries included) */
  completionTokens?: number;
}
interface TaskAgg {
  id: string;
  dimension: string;
  meanScore: number;        // over scored reps only
  scoredReps: number;
  unscoredReps: number;
  buckets: FailureBucket[]; // unique buckets seen across reps
  checkPassRates: Array<{ name: string; passed: number; of: number }>;
  flippedChecks: string[];  // checks with mixed pass/fail across scored reps
  meanCompletionTokens: number;
}
interface SpeedSample { tokPerSec: number | null; raw: string }
interface ModelResult {
  model: string;            // row label, e.g. "qwen3.6:27b@think=false"
  thinkMode?: boolean;      // undefined = engine default
  /** Sum of per-task mean completion tokens — hardware-independent battery cost */
  batteryTokens: number;
  digest?: string;
  quant?: string;
  paramSize?: string;
  loadMs: number;
  speedSamples: SpeedSample[];
  tokPerSecMedian: number | null;
  reps: TaskResult[][];
  taskAggs: TaskAgg[];
  dimensionScores: Record<string, number>;
  overall: number;
  flippedTotal: number;
  totalMs: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms / 1000}s: ${label}`)), ms).unref()),
  ]);
}

function finish(id: string, dimension: TaskResult['dimension'], checks: CheckResult[], start: number, raw: string, error?: string): TaskResult {
  const score = checks.length ? checks.filter(c => c.pass).length / checks.length : 0;
  const bucket = error ? classifyError(error) : undefined;
  return { id, dimension, checks, score, durationMs: Date.now() - start, raw: raw.slice(0, 3000), error, bucket };
}

function failed(id: string, dimension: TaskResult['dimension'], checkNames: string[], start: number, err: unknown): TaskResult {
  const msg = err instanceof Error ? err.message : String(err);
  return finish(id, dimension, checkNames.map(name => ({ name, pass: false })), start, '', msg);
}

const clean = (s: string): string => stripThinkingTags(s).trim();

// ---------------------------------------------------------------- tool-loop tasks

const TOOLLOOP_TIMEOUT = 300_000;

async function runToolLoopTask(
  client: OllamaClient, model: string, id: string, userMessage: string, systemPrompt: string,
  check: (answer: string, calls: CallLogEntry[]) => CheckResult[],
  checkNames: string[],
  opts?: { maxIterations?: number; timeoutMs?: number },
): Promise<TaskResult> {
  return withOutageRetry(async () => {
    const start = Date.now();
    const calls: CallLogEntry[] = [];
    const toolContext: ToolContext = { agentId: 'eval', sessionKey: 'eval' };
    try {
      const result = await withTimeout(runToolLoop({
        client,
        config: { model, maxIterations: opts?.maxIterations ?? 6, temperature: 0.3, maxTokens: 1024, contextSize: 16384, systemPrompt, toolStyle: 'native' },
        tools: MOCK_TOOLS,
        executor: makeExecutor(calls),
        toolContext,
        userMessage,
      }), opts?.timeoutMs ?? TOOLLOOP_TIMEOUT, `${model} ${id}`);
      const answer = clean(result.answer);
      const checks = [
        ...check(answer, calls),
        { name: 'no scaffolding leak', pass: !/Thought:|Final Answer:|Action:/.test(answer) },
        { name: 'non-empty answer', pass: answer.length > 0 },
      ];
      const rawLog = calls.map(c => `-> ${c.tool}(${JSON.stringify(c.params)})`).join('\n');
      return finish(id, 'toolloop', checks, start, `${rawLog}\n\nANSWER:\n${answer}`);
    } catch (err) {
      return failed(id, 'toolloop', [...checkNames, 'no scaffolding leak', 'non-empty answer'], start, err);
    }
  });
}

const TOOL_SYSTEM = 'You are a helpful assistant. Use your tools when they are needed to answer accurately. Do not use tools when you can answer directly.';

async function toolLoopTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  results.push(await runToolLoopTask(client, model, 'T1-single-call',
    'What is the current temperature in Boston, in fahrenheit?', TOOL_SYSTEM,
    (answer, calls) => [
      { name: 'called get_weather', pass: calls.some(c => c.tool === 'get_weather') },
      { name: 'answer contains 61', pass: /61/.test(answer) },
    ],
    ['called get_weather', 'answer contains 61']));

  results.push(await runToolLoopTask(client, model, 'T2-chain',
    'Look up order A-1439, then email the customer a short status update.', TOOL_SYSTEM,
    (answer, calls) => {
      const lookupIdx = calls.findIndex(c => c.tool === 'order_lookup');
      const emailIdx = calls.findIndex(c => c.tool === 'send_email');
      const email = calls.find(c => c.tool === 'send_email');
      const emailText = email ? `${email.params.to} ${email.params.subject} ${email.params.body}`.toLowerCase() : '';
      return [
        { name: 'called order_lookup', pass: lookupIdx !== -1 },
        { name: 'called send_email after lookup', pass: emailIdx !== -1 && lookupIdx !== -1 && emailIdx > lookupIdx },
        { name: 'email to dana@example.com', pass: emailText.includes('dana@example.com') },
        { name: 'email mentions shipped/tracking', pass: /shipped|1z999aa10123456784|tracking/.test(emailText) },
      ];
    },
    ['called order_lookup', 'called send_email after lookup', 'email to dana@example.com', 'email mentions shipped/tracking']));

  // NOTE (methodology): the engine's premature-refusal detector (engine.ts ~787)
  // fires when a model answers first-step with no tool calls. Since 31d4701 the
  // repair prompt offers an explicit exit ("if NO tool is relevant, restate your
  // answer — do not invent tool calls"). This task measures restraint and answer
  // confidence under that fair challenge: a sound model re-asserts its answer
  // (≤2 calls); a defective one still spirals through fabricated URLs despite
  // being offered the exit. Engine-in-the-loop test; the pre-fix coercive-prompt
  // baseline lives in run-2026-08-11T21-10-06.
  results.push(await runToolLoopTask(client, model, 'T3-restraint',
    'Convert 5 kilometers to miles.', TOOL_SYSTEM,
    (answer, calls) => [
      { name: 'no spiral (<=2 tool calls)', pass: calls.length <= 2 },
      { name: 'answer ~3.1 miles', pass: /3[.,]1/.test(answer) },
    ],
    ['no spiral (<=2 tool calls)', 'answer ~3.1 miles']));

  results.push(await runToolLoopTask(client, model, 'T4-error-honesty',
    'Fetch https://example.com/q3-report.pdf and tell me the key numbers in it.', TOOL_SYSTEM,
    (answer, calls) => [
      { name: 'called web_fetch', pass: calls.some(c => c.tool === 'web_fetch') },
      { name: 'reports failure honestly', pass: /404|not found|unable|could ?n[o']t|fail|error|does ?n[o']t exist|unavailable|no longer/i.test(answer) },
      { name: 'no fabricated numbers', pass: !/revenue|profit|\$\d|Q3 (results|numbers) (are|show)/i.test(answer) || /404|not found|unable|error/i.test(answer) },
    ],
    ['called web_fetch', 'reports failure honestly', 'no fabricated numbers']));

  results.push(await runToolLoopTask(client, model, 'T5-long-horizon',
    'Treasure hunt: start at clue START with access code 0000. Follow the chain clue by clue until you find the treasure — each clue result gives you the next clue ID and its access code. Then tell me the treasure word.',
    TOOL_SYSTEM,
    (answer, calls) => {
      const clueCalls = calls.filter(c => c.tool === 'follow_clue');
      const wrongCode = clueCalls.filter(c => {
        const clue = CLUE_CHAIN[String(c.params.clueId ?? '').toUpperCase().trim()];
        return !clue || String(c.params.code ?? '').toUpperCase().trim() !== clue.expectCode;
      });
      const reachedFinal = clueCalls.some(c =>
        String(c.params.clueId ?? '').toUpperCase().trim() === 'FINAL'
        && String(c.params.code ?? '').toUpperCase().trim() === 'P5C6');
      return [
        { name: 'completed all 9 hops', pass: reachedFinal },
        { name: 'zero wrong-code calls (no drift)', pass: clueCalls.length > 0 && wrongCode.length === 0 },
        { name: 'no wasted calls (<=10)', pass: clueCalls.length > 0 && clueCalls.length <= 10 },
        { name: 'answer names AZIMUTH', pass: /azimuth/i.test(answer) },
      ];
    },
    ['completed all 9 hops', 'zero wrong-code calls (no drift)', 'no wasted calls (<=10)', 'answer names AZIMUTH'],
    { maxIterations: 14, timeoutMs: 600_000 }));

  return results;
}

// ---------------------------------------------------------------- extraction tasks

const EXTRACT_TIMEOUT = 120_000;

const CRON_SCHEMA: Record<string, ExtractFieldSchema> = {
  schedule: { type: 'string', description: '5-field cron expression (minute hour day month weekday)', required: true },
  message: { type: 'string', description: 'What the reminder should say', required: true },
  category: { type: 'string', description: 'Which category executes the job', required: true, enum: ['web_search', 'research', 'chat', 'memory', 'exec', 'multi'] },
};

const MESSAGE_SCHEMA: Record<string, ExtractFieldSchema> = {
  channel: { type: 'string', description: 'Delivery channel', required: true, enum: ['discord', 'telegram', 'email'] },
  recipient: { type: 'string', description: 'Who the message goes to', required: true },
  text: { type: 'string', description: 'The message content', required: true },
};

const RESEARCH_SCHEMA: Record<string, ExtractFieldSchema> = {
  topic: { type: 'string', description: 'The research topic', required: true },
  angles: {
    type: 'array', description: 'Distinct research angles to investigate', required: true,
    items: {
      title: { type: 'string', description: 'Short angle title', required: true },
      focus: { type: 'string', description: 'What this angle investigates', required: true },
    },
  },
};

async function extractionTask(
  client: OllamaClient, model: string, id: string,
  schema: Record<string, ExtractFieldSchema>, userMessage: string,
  check: (params: Record<string, unknown>) => CheckResult[],
  checkNames: string[],
): Promise<TaskResult> {
  return withOutageRetry(async () => {
    const start = Date.now();
    let repairs = 0;
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('[Extract]')) repairs++;
      origWarn(...args);
    };
    try {
      // 2048-token budget: thinking models burn tokens reasoning BEFORE the
      // grammar-constrained JSON; a 256 default starves them into returning
      // thinking prose (see data/model-eval/gateway-brief.md)
      const params = await withTimeout(
        extractParams(client, model, schema, userMessage, undefined, undefined, 2048), EXTRACT_TIMEOUT, `${model} ${id}`);
      const checks = [...check(params), { name: 'no repair round-trip needed', pass: repairs === 0 }];
      return finish(id, 'extract', checks, start, JSON.stringify(params, null, 2));
    } catch (err) {
      return failed(id, 'extract', [...checkNames, 'no repair round-trip needed'], start, err);
    } finally {
      console.warn = origWarn;
    }
  });
}

async function extractionTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  const str = (v: unknown): string => typeof v === 'string' ? v.toLowerCase() : '';

  results.push(await extractionTask(client, model, 'E1-cron', CRON_SCHEMA,
    'Every weekday at 7:30am remind me to stretch, just a chat message is fine',
    p => [
      { name: 'schedule == "30 7 * * 1-5"', pass: str(p.schedule).replace(/\s+/g, ' ').trim() === '30 7 * * 1-5' },
      { name: 'message mentions stretch', pass: str(p.message).includes('stretch') },
      { name: 'category == chat', pass: p.category === 'chat' },
    ],
    ['schedule == "30 7 * * 1-5"', 'message mentions stretch', 'category == chat']));

  results.push(await extractionTask(client, model, 'E2-message', MESSAGE_SCHEMA,
    "Send a telegram to Alice saying I'll be about 10 minutes late to dinner",
    p => [
      { name: 'channel == telegram', pass: p.channel === 'telegram' },
      { name: 'recipient is Alice', pass: str(p.recipient).includes('alice') },
      { name: 'text mentions late', pass: str(p.text).includes('late') },
    ],
    ['channel == telegram', 'recipient is Alice', 'text mentions late']));

  results.push(await extractionTask(client, model, 'E3-nested', RESEARCH_SCHEMA,
    'Research whether heat pumps make sense for old New England homes — cover upfront cost, installation complexity, and cold-climate performance',
    p => {
      const angles = Array.isArray(p.angles) ? p.angles as Array<Record<string, unknown>> : [];
      return [
        { name: 'topic mentions heat pumps', pass: str(p.topic).includes('heat pump') },
        { name: '3+ angles extracted', pass: angles.length >= 3 },
        { name: 'angles have title+focus', pass: angles.length > 0 && angles.every(a => typeof a.title === 'string' && a.title.length > 0 && typeof a.focus === 'string' && a.focus.length > 0) },
      ];
    },
    ['topic mentions heat pumps', '3+ angles extracted', 'angles have title+focus']));

  return results;
}

// ---------------------------------------------------------------- chat tasks

const CHAT_TIMEOUT = 120_000;

async function chatTask(
  client: OllamaClient, model: string, id: string,
  system: string, user: string,
  check: (reply: string) => CheckResult[],
  checkNames: string[],
): Promise<TaskResult> {
  return withOutageRetry(async () => {
    const start = Date.now();
    try {
      const response = await withTimeout(client.chat({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { temperature: 0.3, num_predict: 1024 },
      }), CHAT_TIMEOUT, `${model} ${id}`);
      const reply = clean(response.message?.content ?? '');
      return finish(id, 'chat', check(reply), start, reply);
    } catch (err) {
      return failed(id, 'chat', checkNames, start, err);
    }
  });
}

const SOUL_SYSTEM = "You are Peter's assistant. RULES: Never ask 'Is there anything else?' or similar follow-up questions. When the user signals they're done ('nope', 'thanks', 'that's all'), give a brief acknowledgment and stop. Do not re-summarize what was discussed.";

const SUMMARY_TEXT = 'The city council voted 6-3 on Tuesday to approve the riverfront redevelopment plan, which includes 400 units of housing, a public park, and $12M in flood-mitigation work. Construction is expected to begin in spring 2027, pending a final environmental review. Opponents argued the plan lacks sufficient affordable-housing guarantees, and two council members pledged to introduce an amendment requiring 20% affordable units before ground is broken.';

async function chatTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  results.push(await chatTask(client, model, 'C1-stop-rule',
    SOUL_SYSTEM, "thanks, that's all for now",
    reply => [
      { name: 'brief (<200 chars)', pass: reply.length > 0 && reply.length < 200 },
      { name: 'no follow-up question', pass: !reply.includes('?') },
      { name: 'no "anything else"', pass: !/anything else|let me know if|feel free to/i.test(reply) },
    ],
    ['brief (<200 chars)', 'no follow-up question', 'no "anything else"']));

  results.push(await chatTask(client, model, 'C2-exact-format',
    'You are a precise assistant. Follow formatting instructions exactly.',
    `Summarize the following in exactly 3 bullet points, nothing before or after them:\n\n${SUMMARY_TEXT}`,
    reply => {
      const lines = reply.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const bullets = lines.filter(l => /^[-*•]\s/.test(l));
      return [
        { name: 'exactly 3 bullets', pass: bullets.length === 3 },
        { name: 'nothing but bullets', pass: lines.length === bullets.length },
        { name: 'no trailing question', pass: !/\?\s*$/.test(reply) },
      ];
    },
    ['exactly 3 bullets', 'nothing but bullets', 'no trailing question']));

  results.push(await chatTask(client, model, 'C3-json-discipline',
    'You output only valid JSON when asked for JSON. No markdown fences, no commentary.',
    `Reply with ONLY a JSON object with keys "sentiment" (one of: positive, negative, neutral) and "confidence" (number 0-1) for this product review: "The battery died after two days and support never replied."`,
    reply => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(reply); } catch { /* check fenced */ }
      if (!parsed) {
        const m = reply.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch { /* no */ } }
      }
      const bare = (() => { try { JSON.parse(reply); return true; } catch { return false; } })();
      const conf = parsed?.confidence;
      return [
        { name: 'reply is bare JSON', pass: bare },
        { name: 'sentiment == negative', pass: parsed?.sentiment === 'negative' },
        { name: 'confidence in [0,1]', pass: typeof conf === 'number' && conf >= 0 && conf <= 1 },
      ];
    },
    ['reply is bare JSON', 'sentiment == negative', 'confidence in [0,1]']));

  return results;
}

// ---------------------------------------------------------------- coding tasks
// Real-world tasks someone would actually bring to a local assistant — NOT
// algorithm puzzles. Execution-verified: model code runs in a Docker sandbox
// (--network=none, memory-capped, 15s) against basic + edge test batteries.

const CODE_TIMEOUT = 300_000;
const CODE_SYSTEM = 'You are a coding assistant. Reply with a single Python code block containing ONLY the requested function (plus any helpers it needs). No usage examples, no test code, no prints.';

/** Strip common leading whitespace — fenced blocks nested under markdown list
 *  items arrive uniformly indented; Python rejects that at line 1. Any markdown
 *  renderer dedents; so do we. No-op for unindented code. */
function dedent(src: string): string {
  const lines = src.split('\n');
  const indents = lines.filter(l => l.trim().length > 0).map(l => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return min > 0 ? lines.map(l => l.slice(min)).join('\n') : src;
}

/** Extract Python source from a model reply: longest fenced block, else whole reply. */
function extractCode(reply: string): string {
  const fences = [...reply.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const block = fences.length ? fences.reduce((a, b) => (b.length > a.length ? b : a)) : reply;
  return dedent(block);
}

/** Run model code + our test harness in the sandbox. Returns stdout markers. */
function runInSandbox(code: string, testBlock: string): { ranClean: boolean; stdout: string; error?: string } {
  const program = `${code}\n\n# ---- eval harness tests ----\n${testBlock}\n`;
  const res = spawnSync('docker', [
    'run', '--rm', '--network=none', '-m', '256m', '--cpus', '1', '-i',
    'python:3.11-alpine', 'python3', '-',
  ], { input: program, timeout: 15_000, encoding: 'utf8' });
  if (res.error) return { ranClean: false, stdout: res.stdout ?? '', error: String(res.error) };
  return { ranClean: res.status === 0, stdout: res.stdout ?? '', error: res.stderr?.slice(0, 500) || undefined };
}

interface CodeTaskDef {
  id: string;
  prompt: string;
  /** Python appended below the model's code. Print BASIC_OK / EDGE_OK on group success. */
  testBlock: string;
}

const CODE_TASKS: CodeTaskDef[] = [
  {
    id: 'D1-data-wrangle',
    prompt: `Write a Python function summarize_expenses(csv_text: str) -> dict that takes raw CSV text with header "date,category,amount" and returns the total amount per category as {category: total} with totals rounded to 2 decimals.

Real-world mess it must handle:
- amounts formatted like "$1,234.56" or "1234.56" or "(45.00)" — parentheses mean NEGATIVE (accounting style)
- blank lines and rows with a missing/empty amount: skip them
- category names vary in case and whitespace ("Food ", "food" are the same category) — keys in the result must be lowercase and stripped`,
    testBlock: `
csv1 = 'date,category,amount\\n2026-08-01,Food ,"$1,234.56"\\n2026-08-02,food,45.44\\n\\n2026-08-03,Travel,"(45.00)"\\n2026-08-04,travel,145.00\\n2026-08-05,Office,\\n'
r1 = summarize_expenses(csv1)
assert abs(r1["food"] - 1280.00) < 0.01, r1
assert abs(r1["travel"] - 100.00) < 0.01, r1
assert "office" not in r1, r1
print("BASIC_OK")
r2 = summarize_expenses("date,category,amount\\n")
assert r2 == {}, r2
r3 = summarize_expenses("date,category,amount\\n2026-08-01,Fees,\\"(12.50)\\"\\n")
assert abs(r3["fees"] - (-12.50)) < 0.01, r3
print("EDGE_OK")
`,
  },
  {
    id: 'D2-debug-fix',
    prompt: `This booking-conflict function is buggy. Bookings are date ranges where the end date is the CHECKOUT day (exclusive — the room is free again that day). Dates are "YYYY-MM-DD" strings.

def bookings_conflict(start1, end1, start2, end2):
    return start1 <= end2 and start2 <= end1

Bug report: booking A = (2026-03-05 to 2026-03-10) and booking B = (2026-03-10 to 2026-03-12) are flagged as a conflict, but guest A checks out the morning of the 10th — there is no conflict.

Fix the function. Keep the same name and signature. Reply with only the corrected function.`,
    testBlock: `
assert bookings_conflict("2026-03-05","2026-03-10","2026-03-10","2026-03-12") == False
assert bookings_conflict("2026-03-05","2026-03-10","2026-03-08","2026-03-12") == True
assert bookings_conflict("2026-03-05","2026-03-10","2026-03-06","2026-03-08") == True
print("BASIC_OK")
assert bookings_conflict("2026-03-10","2026-03-12","2026-03-05","2026-03-10") == False
assert bookings_conflict("2026-03-05","2026-03-10","2026-03-05","2026-03-10") == True
assert bookings_conflict("2026-03-01","2026-03-02","2026-03-03","2026-03-04") == False
print("EDGE_OK")
`,
  },
  {
    id: 'D3-build-utility',
    prompt: `Write a Python function error_report(log_text: str) -> list that summarizes a server log. Each valid line looks like:
2026-08-11T14:23:05Z LEVEL message text here

where LEVEL is INFO, WARN, or ERROR (case-sensitive). Return a list of strings "HH: N errors" (HH = two-digit UTC hour, N = count of ERROR lines in that hour), sorted by hour ascending, including only hours that have at least one ERROR. Ignore malformed lines entirely. Return [] if there are no errors.`,
    testBlock: `
log1 = """2026-08-11T14:23:05Z ERROR db timeout
2026-08-11T14:59:59Z ERROR retry failed
2026-08-11T09:12:00Z ERROR boot loop
2026-08-11T14:30:00Z INFO recovered
garbage line without structure
2026-08-11T09:13:00Z WARN disk 80%"""
r1 = error_report(log1)
assert r1 == ["09: 1 errors", "14: 2 errors"], r1
print("BASIC_OK")
assert error_report("2026-08-11T10:00:00Z INFO all good") == []
assert error_report("") == []
r2 = error_report("2026-08-11T00:05:00Z ERROR midnight issue")
assert r2 == ["00: 1 errors"], r2
print("EDGE_OK")
`,
  },
];

async function codeTask(client: OllamaClient, model: string, def: CodeTaskDef): Promise<TaskResult> {
  return withOutageRetry(async () => {
    const start = Date.now();
    const checkNames = ['runs without error', 'basic tests pass', 'edge-case tests pass'];
    try {
      const response = await withTimeout(client.chat({
        model,
        messages: [{ role: 'system', content: CODE_SYSTEM }, { role: 'user', content: def.prompt }],
        options: { temperature: 0.2, num_predict: 3072 },
      }), CODE_TIMEOUT, `${model} ${def.id}`);
      const code = extractCode(clean(response.message?.content ?? ''));
      const run = runInSandbox(code, def.testBlock);
      const checks: CheckResult[] = [
        { name: 'runs without error', pass: run.ranClean || run.stdout.includes('BASIC_OK') },
        { name: 'basic tests pass', pass: run.stdout.includes('BASIC_OK') },
        { name: 'edge-case tests pass', pass: run.stdout.includes('EDGE_OK') },
      ];
      const raw = `CODE:\n${code.slice(0, 1800)}\n\nSANDBOX:\nstdout: ${run.stdout.slice(0, 200)}${run.error ? `\nstderr: ${run.error}` : ''}`;
      return finish(def.id, 'code', checks, start, raw);
    } catch (err) {
      return failed(def.id, 'code', checkNames, start, err);
    }
  });
}

async function codeTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const def of CODE_TASKS) results.push(await codeTask(client, model, def));
  return results;
}

// ---------------------------------------------------------------- speed

async function measureSpeedOnce(client: OllamaClient, model: string): Promise<SpeedSample> {
  const start = Date.now();
  try {
    const response = await withTimeout(client.chat({
      model,
      messages: [{ role: 'user', content: 'Write a vivid 200-word story about a lighthouse keeper who discovers something unexpected in the fog.' }],
      options: { temperature: 0.7, num_predict: 400 },
    }), 240_000, `${model} speed`);
    const r = response as unknown as { eval_count?: number; eval_duration?: number };
    const wallSec = (Date.now() - start) / 1000;
    const tokPerSec = r.eval_count && r.eval_duration
      ? r.eval_count / (r.eval_duration / 1e9)
      : r.eval_count ? r.eval_count / wallSec : null;
    return { tokPerSec: tokPerSec ? Math.round(tokPerSec * 10) / 10 : null, raw: clean(response.message?.content ?? '').slice(0, 1500) };
  } catch (err) {
    return { tokPerSec: null, raw: `SPEED TASK FAILED: ${err instanceof Error ? err.message : err}` };
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

// ---------------------------------------------------------------- aggregation

function aggregateTasks(reps: TaskResult[][]): TaskAgg[] {
  const taskIds = reps[0]?.map(t => t.id) ?? [];
  return taskIds.map(id => {
    const all = reps.map(rep => rep.find(t => t.id === id)).filter((t): t is TaskResult => !!t);
    const scored = all.filter(t => !t.unscored);
    const buckets = [...new Set(all.map(t => t.bucket).filter((b): b is FailureBucket => !!b))];
    const checkNames = [...new Set(all.flatMap(t => t.checks.map(c => c.name)))];
    const checkPassRates = checkNames.map(name => {
      const results = scored.map(t => t.checks.find(c => c.name === name)?.pass).filter((p): p is boolean => p !== undefined);
      return { name, passed: results.filter(Boolean).length, of: results.length };
    });
    const flippedChecks = checkPassRates.filter(c => c.passed > 0 && c.passed < c.of).map(c => c.name);
    return {
      id,
      dimension: all[0].dimension,
      meanScore: scored.length ? scored.reduce((s, t) => s + t.score, 0) / scored.length : 0,
      scoredReps: scored.length,
      unscoredReps: all.length - scored.length,
      buckets,
      checkPassRates,
      flippedChecks,
      meanCompletionTokens: all.length ? Math.round(all.reduce((s, t) => s + (t.completionTokens ?? 0), 0) / all.length) : 0,
    };
  });
}

// ---------------------------------------------------------------- report

interface Provenance {
  date: string;
  gitCommit: string;
  gitDirty: boolean;
  gatewayUrl: string;
  reps: number;
  models: Array<{ name: string; digest?: string; quant?: string; paramSize?: string }>;
}

function pct(n: number): string { return `${Math.round(n * 100)}%`; }

function buildReport(results: ModelResult[], pending: string[], prov: Provenance): string {
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  let md = `# Model Eval — 20-33B Field (+35B anchor)\n\n`;
  md += `**Run:** ${RUN_DIR} · **Date:** ${prov.date} · **Harness:** \`scripts/model-eval.ts\` @ ${prov.gitCommit}${prov.gitDirty ? ' (dirty)' : ''} · **Reps per task:** ${prov.reps}\n\n`;
  md += `**Serving stack:** ${prov.gatewayUrl}. ${HARDWARE_NOTE}\n\n`;
  md += `**Scoring:** deterministic code checks only, averaged over ${prov.reps} repetitions. `;
  md += `Failure taxonomy separates model behavior from infrastructure: PROVIDER_OUTAGE reps are retried once, then excluded from means (UNSCORED) — never counted as model failures. `;
  md += `TIMEOUT and SERVING_INCOMPATIBLE score 0 but are labeled (operationally real, causally different). `;
  md += `Subjective prose quality is intentionally unscored — raw outputs below.\n\n`;
  if (pending.length) md += `**In progress** — still to run: ${pending.join(', ')}\n\n`;

  md += `## Scoreboard\n\n| # | Model | Overall | Tool-loop | Extract | Chat | Code | Stability | ctok† | tok/s\\* | Load |\n|---|-------|---------|-----------|---------|------|------|-----------|-------|--------|------|\n`;
  sorted.forEach((r, i) => {
    const stability = r.flippedTotal === 0 ? 'stable' : `${r.flippedTotal} flip${r.flippedTotal > 1 ? 's' : ''}`;
    md += `| ${i + 1} | ${r.model} | **${pct(r.overall)}** | ${pct(r.dimensionScores.toolloop ?? 0)} | ${pct(r.dimensionScores.extract ?? 0)} | ${pct(r.dimensionScores.chat ?? 0)} | ${pct(r.dimensionScores.code ?? 0)} | ${stability} | ${r.batteryTokens.toLocaleString()} | ${r.tokPerSecMedian ?? '—'} | ${(r.loadMs / 1000).toFixed(1)}s |\n`;
  });
  md += `\n† ctok = mean completion tokens to finish the full task battery — a hardware-independent cost metric (a model's verbosity/rumination cost). Unlike tok/s, this transfers across serving stacks.\n`;
  md += `\n\\* median of ${SPEED_SAMPLES} samples. ${HARDWARE_NOTE}\n`;

  md += `\n## Infrastructure & serving events\n\n`;
  let anyInfra = false;
  for (const r of sorted) {
    const infra = r.taskAggs.filter(t => t.buckets.some(b => b !== 'MODEL_FAILURE'));
    if (!infra.length) continue;
    anyInfra = true;
    for (const t of infra) {
      md += `- **${r.model}** ${t.id}: ${t.buckets.join(', ')}${t.unscoredReps ? ` — ${t.unscoredReps}/${prov.reps} reps UNSCORED (outage persisted after retry)` : ''}\n`;
    }
  }
  if (!anyInfra) md += `None — all task failures in this run are attributable to model behavior.\n`;

  md += `\n## Per-task check pass rates (variance detail)\n\n`;
  for (const r of sorted) {
    const unstable = r.taskAggs.filter(t => t.flippedChecks.length > 0);
    md += `**${r.model}** — ${unstable.length === 0 ? 'no flipped checks across reps' : ''}\n`;
    for (const t of unstable) {
      for (const c of t.checkPassRates.filter(c => t.flippedChecks.includes(c.name))) {
        md += `- ${t.id} / ${c.name}: ${c.passed}/${c.of}\n`;
      }
    }
    md += `\n`;
  }

  md += `\n## Failed checks by model (aggregated)\n\n`;
  for (const r of sorted) {
    const fails = r.taskAggs.flatMap(t => t.checkPassRates.filter(c => c.passed < c.of).map(c => `${t.id}: ${c.name} (${c.passed}/${c.of})`));
    md += `**${r.model}** — ${fails.length === 0 ? 'clean sweep across all reps' : fails.map(f => `\n- ${f}`).join('')}\n\n`;
  }

  md += `\n---\n\n# Raw outputs — rep 1 (side-by-side read)\n`;
  const taskIds = results[0]?.reps[0]?.map(t => t.id) ?? [];
  for (const taskId of taskIds) {
    md += `\n## ${taskId}\n`;
    for (const r of sorted) {
      const t = r.reps[0]?.find(x => x.id === taskId);
      if (!t) continue;
      const agg = r.taskAggs.find(a => a.id === taskId);
      const checkLine = t.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`).join(' · ');
      md += `\n### ${r.model} — rep1 ${pct(t.score)}, mean ${pct(agg?.meanScore ?? 0)} (${(t.durationMs / 1000).toFixed(1)}s)\n${checkLine}\n\n\`\`\`\n${t.raw || (t.error ?? '(no output)')}\n\`\`\`\n`;
    }
  }

  md += `\n## Speed samples (lighthouse story, sample 1 of ${SPEED_SAMPLES})\n`;
  for (const r of sorted) {
    md += `\n### ${r.model} — median ${r.tokPerSecMedian ?? '?'} tok/s\\*\n\n\`\`\`\n${r.speedSamples[0]?.raw ?? ''}\n\`\`\`\n`;
  }

  md += `\n## Methodology & limitations\n\n`;
  md += `- **Engine-in-the-loop:** tool-loop tasks run inside Invarail's production ReAct engine (guardrails, repair prompts, fallback parsers included). T3 measures restraint under the engine's premature-refusal challenge, which offers an explicit no-tool exit (post-31d4701 wording) — a model that still invents tool calls despite the exit exhibits a real defect. This is a harness-fit benchmark, not a model-in-isolation benchmark.\n`;
  md += `- **Mock tools:** all tool observations are canned and identical across models and reps; results are comparable but do not measure real-API robustness.\n`;
  md += `- **Extraction budget:** 2048 tokens (not the 256 prod default) so thinking models are scored on extraction ability, not thinking brevity.\n`;
  md += `- **Coding tasks are execution-verified:** model code runs in a network-less Docker sandbox (python:3.11-alpine, 256MB, 15s) against basic + edge-case assertion batteries. Tasks are practical (data cleanup, bug fix, small utility), not algorithm puzzles.\n`;
  md += `- **Deterministic checks only:** prose quality, verbosity, and meta-reasoning leakage are not scored; raw outputs are published for human review.\n`;
  md += `- **Quantized serving:** all models run quantized (mostly Q4_K_M) through one gateway; results may differ at higher precision or on other serving engines.\n`;
  md += `- **${REPS} repetitions** at fixed temperatures (0.3 tool/chat, 0.1 extract, 0.7 speed); stochastic effects beyond ${REPS} reps are not captured.\n`;

  md += `\n## Provenance\n\n| Model | Digest | Quant | Params |\n|-------|--------|-------|--------|\n`;
  for (const m of prov.models) {
    md += `| ${m.name} | ${m.digest?.slice(0, 12) ?? '?'} | ${m.quant ?? '?'} | ${m.paramSize ?? '?'} |\n`;
  }
  return md;
}

function persist(results: ModelResult[], pending: string[], prov: Provenance): void {
  writeFileSync(join(RUN_DIR, 'results.json'), JSON.stringify({ provenance: prov, results }, null, 2));
  writeFileSync(join(RUN_DIR, 'report.md'), buildReport(results, pending, prov));
}

// ---------------------------------------------------------------- main

async function evalModel(client: OllamaClient, row: ModelRow, meta: Provenance['models'][number] | undefined): Promise<ModelResult> {
  const modelStart = Date.now();
  const model = row.name;
  currentThink = row.think;
  console.log(`\n================ ${row.label} ================`);

  const loadStart = Date.now();
  try {
    await withTimeout(client.chat({
      model, messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 4 },
    }), 300_000, `${model} warmup`);
  } catch (err) {
    console.log(`  warmup FAILED: ${err instanceof Error ? err.message : err}`);
  }
  const loadMs = Date.now() - loadStart;
  console.log(`  loaded in ${(loadMs / 1000).toFixed(1)}s`);

  const reps: TaskResult[][] = [];
  for (let rep = 0; rep < REPS; rep++) {
    console.log(`  --- rep ${rep + 1}/${REPS} ---`);
    const repTasks: TaskResult[] = [];
    for (const batch of [toolLoopTasks, extractionTasks, chatTasks, codeTasks]) {
      const batchResults = await batch(client, model);
      repTasks.push(...batchResults);
      for (const t of batchResults) {
        const tag = t.unscored ? ' [UNSCORED: outage]' : t.bucket && t.bucket !== 'MODEL_FAILURE' ? ` [${t.bucket}]` : '';
        console.log(`  ${t.id}: ${pct(t.score)} (${(t.durationMs / 1000).toFixed(1)}s)${tag}${t.error ? ` — ${t.error.slice(0, 80)}` : ''}`);
      }
    }
    reps.push(repTasks);
  }

  const speedSamples: SpeedSample[] = [];
  for (let i = 0; i < SPEED_SAMPLES; i++) speedSamples.push(await measureSpeedOnce(client, model));
  const tokPerSecMedian = median(speedSamples.map(s => s.tokPerSec).filter((n): n is number => n !== null));
  console.log(`  speed: median ${tokPerSecMedian ?? '?'} tok/s over ${SPEED_SAMPLES} samples`);

  const taskAggs = aggregateTasks(reps);
  const dims: Record<string, number> = {};
  for (const dim of ['toolloop', 'extract', 'chat', 'code'] as const) {
    const dimTasks = taskAggs.filter(t => t.dimension === dim && t.scoredReps > 0);
    dims[dim] = dimTasks.length ? dimTasks.reduce((s, t) => s + t.meanScore, 0) / dimTasks.length : 0;
  }
  const overall = (dims.toolloop + dims.extract + dims.chat + dims.code) / 4;
  const flippedTotal = taskAggs.reduce((s, t) => s + t.flippedChecks.length, 0);
  const batteryTokens = taskAggs.reduce((s, t) => s + t.meanCompletionTokens, 0);
  console.log(`  OVERALL: ${pct(overall)} (toolloop ${pct(dims.toolloop)} · extract ${pct(dims.extract)} · chat ${pct(dims.chat)} · code ${pct(dims.code)}) · ${flippedTotal} flipped checks · ${batteryTokens} ctok/battery`);

  return {
    model: row.label, thinkMode: row.think, batteryTokens,
    digest: meta?.digest, quant: meta?.quant, paramSize: meta?.paramSize,
    loadMs, speedSamples, tokPerSecMedian, reps, taskAggs,
    dimensionScores: dims, overall, flippedTotal, totalMs: Date.now() - modelStart,
  };
}

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  // Provenance: model digests from the gateway catalog
  let catalog: Array<{ name: string; model?: string; digest?: string; details?: { quantization_level?: string; parameter_size?: string } }> = [];
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`);
    catalog = ((await res.json()) as { models: typeof catalog }).models;
  } catch (err) {
    console.warn('Could not fetch /api/tags for provenance:', err instanceof Error ? err.message : err);
  }

  const args = process.argv.slice(2);
  const rows: ModelRow[] = (args.length ? args : [...DEFAULT_MODELS]).map(parseModelArg);
  if (!args.length) {
    const lightning = catalog.find(m => /nemotron.*3\.5|lightning/i.test(m.name));
    if (lightning && !rows.some(r => r.name === lightning.name)) {
      console.log(`Nemotron 3.5 Lightning detected on gateway — adding ${lightning.name} to the field`);
      rows.push({ label: lightning.name, name: lightning.name });
    }
  }
  instrumentClient(client);

  let gitCommit = 'unknown', gitDirty = false;
  try {
    gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
    gitDirty = execSync('git status --porcelain -- scripts/model-eval.ts').toString().trim().length > 0;
  } catch { /* not fatal */ }

  const prov: Provenance = {
    date: new Date().toISOString(),
    gitCommit, gitDirty,
    gatewayUrl: config.ollama.url,
    reps: REPS,
    models: [...new Set(rows.map(r => r.name))].map(name => {
      const m = catalog.find(c => c.name === name || c.model === name);
      return { name, digest: m?.digest, quant: m?.details?.quantization_level, paramSize: m?.details?.parameter_size };
    }),
  };

  // Models routed to a non-Ollama backend only get think A/B rows when the
  // backend explicitly declares supportsThink (ds4 does — verified); otherwise
  // the translation layer omits `think` and the model gets one honestly-labeled
  // default row. Never probe a backend that might silently ignore the field.
  const noThinkControl = new Set(
    (config.inference?.backends ?? []).filter(b => !b.supportsThink).flatMap(b => b.models ?? []),
  );

  const baseNames = [...new Set(rows.map(r => r.name))];
  console.log(`Model eval — ${baseNames.length} base models × ${REPS} reps (thinking models expand to think=on/off rows) -> ${RUN_DIR}`);
  const results: ModelResult[] = [];
  for (const name of baseNames) {
    const meta = prov.models.find(m => m.name === name);
    const explicit = rows.filter(r => r.name === name && r.think !== undefined);
    let modelRows: ModelRow[];
    if (explicit.length) {
      modelRows = explicit; // manual @think= override: run exactly what was asked
    } else {
      const modes = await probeThinkModes(client, name, noThinkControl);
      const capable = modes.length > 1 || modes[0] !== undefined;
      modelRows = modes.map(mode => rowFor(name, mode, capable));
    }
    for (const row of modelRows) {
      try {
        results.push(await evalModel(client, row, meta));
      } catch (err) {
        console.error(`MODEL FAILED ENTIRELY: ${row.label}:`, err instanceof Error ? err.message : err);
        results.push({
          model: row.label, thinkMode: row.think, batteryTokens: 0,
          loadMs: 0, speedSamples: [], tokPerSecMedian: null, reps: [], taskAggs: [],
          dimensionScores: { toolloop: 0, extract: 0, chat: 0, code: 0 }, overall: 0, flippedTotal: 0, totalMs: 0,
        });
      }
      persist(results, baseNames.slice(baseNames.indexOf(name) + 1), prov);
    }
  }

  console.log(`\nEVAL COMPLETE — ${results.length} models × ${REPS} reps. Report: ${join(RUN_DIR, 'report.md')}`);
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  for (const [i, r] of sorted.entries()) {
    console.log(`  ${i + 1}. ${r.model} — ${pct(r.overall)} (${r.flippedTotal} flipped checks)`);
  }
}

main().catch(err => {
  console.error('Eval failed to run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
