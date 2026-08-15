/**
 * Deep eval harness (tier 2) — long-horizon tasks where thinking might actually
 * earn its cost. The tier-1 battery proved "thinking models fail at budgets, not
 * tasks"; this battery asks the converse: GIVEN budgets sized for reasoning
 * (16K output, 7-10min task SLOs), does thinking buy accuracy? Tie-breaks the
 * tier-1 100% rows and gives the big models a real challenge.
 *
 * Dimensions:
 *   reasoning — constraint scheduling across timezones; ledger reconciliation
 *   code      — interaction-bug fix, stateful build (TTL+LRU), data pipeline;
 *               execution-verified in the Docker sandbox (30s, 512MB)
 *   analysis  — vendor TCO comparison with a non-compliant decoy; policy
 *               compliance requiring rule composition; figure reconciliation
 *
 * Same failure taxonomy, think A/B auto-probe, and token metering as tier 1
 * (scripts/model-eval.ts). Speed sampling intentionally omitted — tok/s lives
 * in the tier-1 run; this battery measures depth, ctok carries the cost story.
 *
 * Usage: npx tsx scripts/model-eval-deep.ts [model[@think=...] ...]
 *        (default: the tier-2 focus roster — tier-1 100% rows + newest models)
 * NOTE: node needs LAN access — run inside the `lab` tmux session.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { stripThinkingTags } from '../src/utils/text.js';
import type { OllamaClient } from '../src/ollama/client.js';

const REPS = 2;
const TASK_TOKENS = 16_384;         // budgets sized for reasoning — starvation is out of the taxonomy
const REASONING_TIMEOUT = 420_000;
const CODE_TIMEOUT = 600_000;

// ------------------------------------------------------------- think + tokens

type ThinkMode = boolean | 'low' | 'medium' | 'high';
interface ModelRow { label: string; name: string; think?: ThinkMode }

function parseModelArg(arg: string): ModelRow {
  const m = arg.match(/^(.*)@think=(true|false|on|off|low|medium|high)$/);
  if (!m) return { label: arg, name: arg };
  const v = m[2];
  const think: ThinkMode = v === 'true' || v === 'on' ? true : v === 'false' || v === 'off' ? false : v as ThinkMode;
  return { label: `${m[1]}@think=${typeof think === 'boolean' ? (think ? 'on' : 'off') : think}`, name: m[1], think };
}

const tokenMeter = { completion: 0, prompt: 0 };
let currentThink: ThinkMode | undefined;

async function probeThinkModes(client: OllamaClient, name: string, noThinkControl: Set<string>): Promise<Array<boolean | undefined>> {
  if (noThinkControl.has(name)) {
    console.log(`  ${name}: backend does not declare supportsThink — single default row`);
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
      throw err;
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

// Tier-2 focus roster: tier-1 100% rows + the newest models + the frontier
// anchor. gpt-oss:120b runs its two VALID modes explicitly (on + low; its
// think=off is leaky per the tier-1 obedience audit — never a real off).
const DEFAULT_MODELS = [
  'qwen3.6:27b',
  'qwen3.8:27b',
  'gemma4:31b',
  'gpt-oss:120b@think=on',
  'gpt-oss:120b@think=low',
  'deepseek-v4-flash',
  'muse-glimmer:latest',
  'nemotron-3.5-lightning:latest',
];

const HARDWARE_NOTE =
  'All throughput/latency figures reflect THIS serving topology only — TWO distinct paths: '
  + '(1) Ollama fleet (DGX Spark cluster) behind a FastAPI gateway proxy, Q4_K_M/MXFP4 quantizations; '
  + '(2) deepseek-v4-flash served DIRECTLY by ds4/DwarfStar (github.com/antirez/ds4, OpenAI-compat, '
  + 'per-request think honored). None of these figures are intrinsic model properties.';

const RUN_DIR = join('data', 'model-eval', `deep-run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
mkdirSync(RUN_DIR, { recursive: true });

// ---------------------------------------------------------------- failure taxonomy

type FailureBucket = 'MODEL_FAILURE' | 'TIMEOUT' | 'SERVING_INCOMPATIBLE' | 'PROVIDER_OUTAGE';

function classifyError(msg: string): FailureBucket {
  // Both our SLO race ("TIMEOUT after Ns") and the HTTP client's own request
  // timeout ("timed out after Nms") are timeouts — never MODEL_FAILURE.
  if (/^TIMEOUT after/.test(msg) || /timed out after \d+ms/i.test(msg)) return 'TIMEOUT';
  if (/503|all_providers_unavailable|ECONNREFUSED|EHOSTUNREACH|fetch failed|socket hang up/i.test(msg)) return 'PROVIDER_OUTAGE';
  if (/400 Bad Request/.test(msg)) return 'SERVING_INCOMPATIBLE';
  return 'MODEL_FAILURE';
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

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

// ---------------------------------------------------------------- result plumbing

type Dimension = 'reasoning' | 'code' | 'analysis';
interface CheckResult { name: string; pass: boolean }
interface TaskResult {
  id: string;
  dimension: Dimension;
  checks: CheckResult[];
  score: number;
  durationMs: number;
  raw: string;
  error?: string;
  bucket?: FailureBucket;
  unscored?: boolean;
  completionTokens?: number;
}
interface TaskAgg {
  id: string;
  dimension: string;
  meanScore: number;
  scoredReps: number;
  unscoredReps: number;
  buckets: FailureBucket[];
  checkPassRates: Array<{ name: string; passed: number; of: number }>;
  flippedChecks: string[];
  meanCompletionTokens: number;
}
interface ModelResult {
  model: string;
  thinkMode?: ThinkMode;
  batteryTokens: number;
  digest?: string;
  quant?: string;
  paramSize?: string;
  loadMs: number;
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

function finish(id: string, dimension: Dimension, checks: CheckResult[], start: number, raw: string, error?: string): TaskResult {
  const score = checks.length ? checks.filter(c => c.pass).length / checks.length : 0;
  const bucket = error ? classifyError(error) : undefined;
  return { id, dimension, checks, score, durationMs: Date.now() - start, raw: raw.slice(0, 4000), error, bucket };
}

function failed(id: string, dimension: Dimension, checkNames: string[], start: number, err: unknown): TaskResult {
  const msg = err instanceof Error ? err.message : String(err);
  return finish(id, dimension, checkNames.map(name => ({ name, pass: false })), start, '', msg);
}

const clean = (s: string): string => stripThinkingTags(s).trim();

// ---------------------------------------------------------------- prompt-reply tasks

async function promptTask(
  client: OllamaClient, model: string, id: string, dimension: Dimension,
  system: string, user: string,
  check: (reply: string) => CheckResult[],
  checkNames: string[],
  timeoutMs = REASONING_TIMEOUT,
): Promise<TaskResult> {
  return withOutageRetry(async () => {
    const start = Date.now();
    try {
      const response = await withTimeout(client.chat({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { temperature: 0.2, num_predict: TASK_TOKENS },
      }), timeoutMs, `${model} ${id}`);
      const reply = clean(response.message?.content ?? '');
      return finish(id, dimension, check(reply), start, reply);
    } catch (err) {
      return failed(id, dimension, checkNames, start, err);
    }
  });
}

/** Best-effort JSON extraction (bare, fenced, or embedded). */
function looseJson<T>(reply: string): T | null {
  try { return JSON.parse(reply) as T; } catch { /* try embedded */ }
  const m = reply.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]) as T; } catch { return null; } }
  return null;
}

// ---------------------------------------------------------------- reasoning tasks

const L1_PROMPT = `Schedule a 60-minute meeting for three people. It must start ON THE HOUR (:00), happen Monday Aug 17, Tuesday Aug 18, or Wednesday Aug 19, and fit EVERYONE's availability and rules.

Maya — London (UTC+1):
- Monday: free 09:00–12:00 and 13:00–16:00 local time
- Tuesday: traveling all day, unavailable
- Wednesday: free 13:00–16:00 local time

Raj — Mumbai (UTC+5:30):
- Monday and Wednesday: free 17:00–20:00 local time
- Rule: every Monday he has a family commitment starting at 18:00 local — he cannot meet at or after that time on Mondays
- Tuesday: fully booked

Sofia — Chicago (UTC-5):
- Monday and Wednesday: free 07:30–10:00 local time
- Tuesday: free 07:30–10:00 local time

Work through the timezone conversions carefully. End your reply with exactly one line in this format:
ANSWER: <Day> <start>-<end> UTC`;

const L2_LEDGER = `INTERNAL LEDGER (id, date, amount):
TXN-1041, 2026-08-01, 220.00
TXN-1043, 2026-08-01, 450.00
TXN-1045, 2026-08-02, 89.50
TXN-1047, 2026-08-02, 310.25
TXN-1047, 2026-08-02, 310.25
TXN-1049, 2026-08-03, 129.99
TXN-1051, 2026-08-03, 75.00
TXN-1053, 2026-08-04, 512.40
TXN-1055, 2026-08-04, 43.10
TXN-1057, 2026-08-05, 268.75

BANK STATEMENT (id, date, amount):
TXN-1041, 2026-08-01, 220.00
TXN-1043, 2026-08-01, 540.00
TXN-1045, 2026-08-02, 89.50
TXN-1047, 2026-08-02, 310.25
TXN-1049, 2026-08-03, 129.90
TXN-1053, 2026-08-04, 512.40
TXN-1055, 2026-08-04, 43.10
TXN-1057, 2026-08-05, 268.75
TXN-1058, 2026-08-05, 199.00`;

const L2_CLEAN = ['TXN-1041', 'TXN-1045', 'TXN-1053', 'TXN-1055', 'TXN-1057'];
const L2_EXPECTED = ['TXN-1043', 'TXN-1047', 'TXN-1049', 'TXN-1051', 'TXN-1058'];

async function reasoningTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  results.push(await promptTask(client, model, 'L1-scheduling', 'reasoning',
    'You are a careful scheduling assistant. Do the timezone arithmetic explicitly before answering.',
    L1_PROMPT,
    reply => {
      const ansLine = reply.split('\n').reverse().find(l => /ANSWER:/i.test(l)) ?? '';
      return [
        { name: 'answer line present', pass: ansLine.length > 0 },
        { name: 'day is Wednesday', pass: /wednesday/i.test(ansLine) },
        { name: 'starts 13:00 UTC', pass: /13:00/.test(ansLine) },
        { name: 'ends 14:00 UTC', pass: /14:00/.test(ansLine) },
      ];
    },
    ['answer line present', 'day is Wednesday', 'starts 13:00 UTC', 'ends 14:00 UTC']));

  results.push(await promptTask(client, model, 'L2-reconciliation', 'reasoning',
    'You are a meticulous accountant reconciling records. Find EVERY discrepancy: amount mismatches, entries missing from either side, and duplicates.',
    `${L2_LEDGER}\n\nReconcile the ledger against the bank statement. Reply with ONLY a JSON array of the transaction IDs that have any discrepancy (e.g. ["TXN-1234"]). No other text.`,
    reply => {
      const arr = looseJson<string[]>(reply);
      const ids = Array.isArray(arr) ? arr.map(s => String(s).toUpperCase().trim()) : [];
      const checks: CheckResult[] = [{ name: 'valid JSON array', pass: Array.isArray(arr) }];
      for (const id of L2_EXPECTED) checks.push({ name: `found ${id}`, pass: ids.includes(id) });
      checks.push({ name: 'no false positives', pass: ids.length > 0 && L2_CLEAN.every(id => !ids.includes(id)) });
      return checks;
    },
    ['valid JSON array', ...L2_EXPECTED.map(id => `found ${id}`), 'no false positives']));

  return results;
}

// ---------------------------------------------------------------- code tasks
// Execution-verified in the Docker sandbox — bigger box than tier 1 (30s, 512MB)
// because these solutions legitimately run longer.

const CODE_SYSTEM = 'You are a senior engineer. Reply with a single Python code block containing ONLY the requested code (plus any helpers it needs). No usage examples, no test code, no prints.';

function dedent(src: string): string {
  const lines = src.split('\n');
  const indents = lines.filter(l => l.trim().length > 0).map(l => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return min > 0 ? lines.map(l => l.slice(min)).join('\n') : src;
}

function extractCode(reply: string): string {
  const fences = [...reply.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const block = fences.length ? fences.reduce((a, b) => (b.length > a.length ? b : a)) : reply;
  return dedent(block);
}

function runInSandbox(code: string, testBlock: string): { ranClean: boolean; stdout: string; error?: string } {
  const program = `${code}\n\n# ---- eval harness tests ----\n${testBlock}\n`;
  const res = spawnSync('docker', [
    'run', '--rm', '--network=none', '-m', '512m', '--cpus', '1', '-i',
    'python:3.11-alpine', 'python3', '-',
  ], { input: program, timeout: 30_000, encoding: 'utf8' });
  if (res.error) return { ranClean: false, stdout: res.stdout ?? '', error: String(res.error) };
  return { ranClean: res.status === 0, stdout: res.stdout ?? '', error: res.stderr?.slice(0, 500) || undefined };
}

interface CodeTaskDef { id: string; prompt: string; testBlock: string }

const CODE_TASKS: CodeTaskDef[] = [
  {
    id: 'L3-interaction-bug',
    prompt: `This rate limiter has a bug that only shows up when the service creates MORE THAN ONE limiter (one per API key). Bug report: "When we added a second API key, the first key started getting rejected way below its limit. Each limiter should be completely independent."

class RateLimiter:
    def __init__(self, max_calls, window_seconds, calls=[]):
        self.max_calls = max_calls
        self.window = window_seconds
        self.calls = calls

    def allow(self, timestamp):
        while self.calls and self.calls[0] <= timestamp - self.window:
            self.calls.pop(0)
        if len(self.calls) < self.max_calls:
            self.calls.append(timestamp)
            return True
        return False

Find the root cause and fix it. Keep the class name, method names, and signatures usable the same way (constructing with (max_calls, window_seconds) must work). Reply with only the corrected class.`,
    testBlock: `
a = RateLimiter(2, 60)
b = RateLimiter(2, 60)
assert a.allow(0) == True
assert a.allow(1) == True
assert a.allow(2) == False
assert b.allow(2) == True, "limiters must be independent"
assert b.allow(3) == True
assert b.allow(4) == False
print("BASIC_OK")
assert a.allow(61) == True
assert a.allow(62) == True
assert a.allow(63) == False
c = RateLimiter(1, 10)
assert c.allow(100) == True
assert c.allow(105) == False
assert c.allow(111) == True
print("EDGE_OK")
`,
  },
  {
    id: 'L4-stateful-build',
    prompt: `Write a Python class TTLCache — an LRU cache where entries also expire after a fixed time-to-live. To keep it deterministic, all methods take explicit timestamps (numbers, seconds) instead of reading a clock.

TTLCache(capacity: int, ttl: float)
- put(key, value, now): insert or update. Updating an existing key refreshes its insert time and recency without evicting. When inserting a NEW key at capacity, evict the least-recently-used entry first (a successful get refreshes recency).
- get(key, now): return the value, or None if absent. An entry is EXPIRED when now >= insert_time + ttl; an expired entry is removed, counts as a miss, and returns None.
- stats(): return {"hits": int, "misses": int} — a hit is a successful, non-expired get; everything else is a miss.`,
    testBlock: `
c = TTLCache(2, 10)
c.put('a', 1, 0)
c.put('b', 2, 1)
assert c.get('a', 2) == 1
c.put('c', 3, 3)
assert c.get('b', 4) is None, "b should have been evicted (LRU)"
assert c.get('c', 5) == 3
print("BASIC_OK")
assert c.get('a', 12) is None, "a expired at t=10"
assert c.stats() == {'hits': 2, 'misses': 2}, c.stats()
assert c.get('c', 13) is None, "boundary: now == insert+ttl is expired"
c.put('c', 9, 14)
assert c.get('c', 15) == 9, "re-put must reset the clock"
print("EDGE_OK")
`,
  },
  {
    id: 'L5-data-pipeline',
    prompt: `Write a Python function monthly_revenue(csv_text: str) -> dict that processes raw sales-export CSV with header "id,timestamp,amount,currency" through these steps IN ORDER:

1. Skip malformed rows entirely: wrong number of columns, or an amount that is not a number.
2. Deduplicate by id: when the same id appears multiple times, keep ONLY the row with the latest timestamp (timestamps are ISO strings — string comparison works).
3. Normalize currency: amounts are USD or EUR; convert EUR to USD at exactly 1.10 (round each converted amount to 2 decimals). Skip rows with any other currency.
4. Aggregate: sum the kept amounts per month ("YYYY-MM" from the kept row's timestamp), rounding each monthly total to 2 decimals.

Return {"YYYY-MM": total} and {} for empty input.`,
    testBlock: `
csv1 = """id,timestamp,amount,currency
S-1,2026-05-03T10:00:00,100.00,USD
S-2,2026-05-04T09:00:00,50.00,EUR
S-1,2026-05-06T12:00:00,120.00,USD
S-3,2026-06-01T08:00:00,200.00,USD
garbage,row
S-4,2026-06-02T08:00:00,notanumber,USD
S-5,2026-06-03T08:00:00,80.00,EUR"""
r = monthly_revenue(csv1)
assert r == {'2026-05': 175.00, '2026-06': 288.00}, r
print("BASIC_OK")
assert monthly_revenue("id,timestamp,amount,currency\\n") == {}
r2 = monthly_revenue("id,timestamp,amount,currency\\nS-9,2026-07-01T00:00:00,10.00,GBP\\n")
assert r2 == {}, r2
r3 = monthly_revenue("id,timestamp,amount,currency\\nS-8,2026-07-02T00:00:00,10.00,USD\\nS-8,2026-07-01T00:00:00,99.00,USD\\n")
assert r3 == {'2026-07': 10.00}, r3
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
        options: { temperature: 0.2, num_predict: TASK_TOKENS },
      }), CODE_TIMEOUT, `${model} ${def.id}`);
      const code = extractCode(clean(response.message?.content ?? ''));
      const run = runInSandbox(code, def.testBlock);
      const checks: CheckResult[] = [
        { name: 'runs without error', pass: run.ranClean || run.stdout.includes('BASIC_OK') },
        { name: 'basic tests pass', pass: run.stdout.includes('BASIC_OK') },
        { name: 'edge-case tests pass', pass: run.stdout.includes('EDGE_OK') },
      ];
      const raw = `CODE:\n${code.slice(0, 2400)}\n\nSANDBOX:\nstdout: ${run.stdout.slice(0, 200)}${run.error ? `\nstderr: ${run.error}` : ''}`;
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

// ---------------------------------------------------------------- analysis tasks

const L6_PROMPT = `You are advising a 50-person company choosing a project-management vendor for a 3-year contract. Hard requirement: the tool MUST support SSO (single sign-on) — security policy, non-negotiable. Headcount is fixed at 50 for the full term.

Vendor A — "TaskFlow": $12 per user per month, billed monthly. SSO included. No other fees.

Vendor B — "ProjectHub": $5,000 per year flat covering up to 40 users, plus $150 per year for each user beyond 40. SSO included. No other fees.

Vendor C — "SprintBase": $7 per user per month with a 50-seat minimum. No SSO support (on their roadmap, no committed date). No other fees.

Compute the full 3-year total cost of ownership for each vendor, apply the requirement, and recommend one. Show the TCO figures. End your reply with exactly one line:
RECOMMENDATION: <Vendor letter> — <vendor name>`;

const L7_POLICY = `EXPENSE POLICY:
1. Meals: up to $75/person/day domestic; up to $120/person/day on international trips.
2. Alcohol is never reimbursable, even with a receipt.
3. Flights: economy class only, EXCEPT flights over 6 hours where premium economy is allowed. Business and first class are never reimbursable.
4. Hotels: up to $250/night, except in high-cost cities (New York, San Francisco, London) where the limit is $400/night.
5. Receipts are required for any expense over $25. Items over $25 without a receipt are denied.

EXPENSE ITEMS:
P1: Team dinner in Berlin (international trip), $110/person, receipt attached.
P2: Client lunch in Chicago (domestic), $82/person, receipt attached.
P3: Hotel in New York, $380/night, receipt attached.
P4: Hotel in Denver, $290/night, receipt attached.
P5: Business-class flight, 8-hour international flight, receipt attached.
P6: Premium-economy flight, 7-hour flight, receipt attached.
P7: Bottle of wine at client dinner, $45, receipt attached.
P8: Taxi from airport, $18, no receipt.

Apply the policy to each item. Reply with ONLY a JSON object mapping each item ID to "approve" or "deny" (e.g. {"P1": "approve"}). No other text.`;

const L7_EXPECTED: Record<string, string> = {
  P1: 'approve', P2: 'deny', P3: 'approve', P4: 'deny',
  P5: 'deny', P6: 'approve', P7: 'deny', P8: 'approve',
};

const L8_REPORT = `INTERNAL QUARTERLY BUSINESS REVIEW — FY2026 (DRAFT)

Overview: FY2026 was a growth year across all product lines. Headcount ended at 214 (up from 187), and operating margin improved from 14% to 18%. Customer count crossed 1,900, with net revenue retention at 112%.

Revenue detail: Q1 revenue came in at $4.2M, driven by the enterprise tier's strong renewals. Q2 accelerated to $4.8M on the back of the April pricing change. Q3 delivered $5.1M despite summer seasonality, and Q4 closed at $5.6M with the holiday campaign outperforming plan. Full-year revenue totaled $20.9M, which the board highlighted as the company's first year above the $20M mark.

Costs: hosting spend was $2.1M for the year (10% of revenue), and total OpEx landed at $17.1M. The sales team attributes roughly $1.4M of Q4 bookings to the new partner channel, which launched in Q3.

Outlook: the FY2027 plan assumes 22% revenue growth off the FY2026 base, targeting $25.5M.`;

async function analysisTasks(client: OllamaClient, model: string): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  results.push(await promptTask(client, model, 'L6-vendor-tco', 'analysis',
    'You are a rigorous procurement analyst. Compute costs exactly; apply hard requirements before price.',
    L6_PROMPT,
    reply => {
      const recLine = reply.split('\n').reverse().find(l => /RECOMMENDATION:/i.test(l)) ?? '';
      return [
        { name: 'recommends B', pass: /RECOMMENDATION:\s*B\b/i.test(recLine) || /RECOMMENDATION:.*ProjectHub/i.test(recLine) },
        { name: 'TCO A = $21,600', pass: /21[,.]?600/.test(reply) },
        { name: 'TCO B = $19,500', pass: /19[,.]?500/.test(reply) },
        { name: 'TCO C = $12,600', pass: /12[,.]?600/.test(reply) },
        { name: 'disqualifies C over SSO', pass: /sso/i.test(reply) && /(disqualif|does not meet|doesn'?t meet|fails|lacks|no sso|excluded|non-?compliant|cannot|rule[sd] out)/i.test(reply) },
      ];
    },
    ['recommends B', 'TCO A = $21,600', 'TCO B = $19,500', 'TCO C = $12,600', 'disqualifies C over SSO']));

  results.push(await promptTask(client, model, 'L7-policy-compliance', 'analysis',
    'You are an expense-compliance reviewer. Apply every applicable policy rule to each item; some items require composing two rules.',
    L7_POLICY,
    reply => {
      const obj = looseJson<Record<string, string>>(reply);
      const checks: CheckResult[] = [{ name: 'valid JSON object', pass: !!obj && typeof obj === 'object' && !Array.isArray(obj) }];
      for (const [id, expected] of Object.entries(L7_EXPECTED)) {
        const got = typeof obj?.[id] === 'string' ? obj[id].toLowerCase().trim() : '';
        checks.push({ name: `${id} = ${expected}`, pass: got === expected });
      }
      return checks;
    },
    ['valid JSON object', ...Object.entries(L7_EXPECTED).map(([id, v]) => `${id} = ${v}`)]));

  results.push(await promptTask(client, model, 'L8-figure-check', 'analysis',
    'You are a careful financial reviewer. Verify that the numbers in the document are internally consistent before it goes to the board.',
    `${L8_REPORT}\n\nReview this draft for internal numerical consistency. If any figures do not reconcile, identify exactly which, show the correct arithmetic, and state the size of the error.`,
    reply => [
      { name: 'flags an inconsistency', pass: /(discrepan|inconsisten|does\s?n[o']t (add|sum|match|reconcile)|mismatch|error|incorrect|overstat)/i.test(reply) },
      { name: 'computes correct sum $19.7M', pass: /19\.7/.test(reply) },
      { name: 'quantifies the $1.2M gap', pass: /1\.2/.test(reply) },
      { name: 'targets the revenue total (not a distractor)', pass: /20\.9/.test(reply) },
    ],
    ['flags an inconsistency', 'computes correct sum $19.7M', 'quantifies the $1.2M gap', 'targets the revenue total (not a distractor)']));

  return results;
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
  let md = `# Deep Eval (Tier 2) — Long-Horizon Battery\n\n`;
  md += `**Run:** ${RUN_DIR} · **Date:** ${prov.date} · **Harness:** \`scripts/model-eval-deep.ts\` @ ${prov.gitCommit}${prov.gitDirty ? ' (dirty)' : ''} · **Reps per task:** ${prov.reps}\n\n`;
  md += `**Question this battery asks:** tier 1 proved thinking models fail at budgets, not tasks. Given budgets sized for reasoning (${TASK_TOKENS.toLocaleString()}-token output, ${REASONING_TIMEOUT / 60000}-${CODE_TIMEOUT / 60000}min SLOs), does thinking buy accuracy on long-horizon work?\n\n`;
  md += `**Serving stack:** ${prov.gatewayUrl}. ${HARDWARE_NOTE}\n\n`;
  md += `**Scoring:** deterministic code checks only, averaged over ${prov.reps} repetitions. Same failure taxonomy as tier 1 (PROVIDER_OUTAGE → retry → UNSCORED; TIMEOUT/SERVING_INCOMPATIBLE scored 0 but labeled). Speed sampling intentionally omitted — tok/s lives in the tier-1 run.\n\n`;
  if (pending.length) md += `**In progress** — still to run: ${pending.join(', ')}\n\n`;

  md += `## Scoreboard\n\n| # | Model | Overall | Reasoning | Code | Analysis | Stability | ctok† |\n|---|-------|---------|-----------|------|----------|-----------|-------|\n`;
  sorted.forEach((r, i) => {
    const stability = r.flippedTotal === 0 ? 'stable' : `${r.flippedTotal} flip${r.flippedTotal > 1 ? 's' : ''}`;
    md += `| ${i + 1} | ${r.model} | **${pct(r.overall)}** | ${pct(r.dimensionScores.reasoning ?? 0)} | ${pct(r.dimensionScores.code ?? 0)} | ${pct(r.dimensionScores.analysis ?? 0)} | ${stability} | ${r.batteryTokens.toLocaleString()} |\n`;
  });
  md += `\n† ctok = mean completion tokens to finish the full battery — hardware-independent cost.\n`;

  md += `\n## Infrastructure & serving events\n\n`;
  let anyInfra = false;
  for (const r of sorted) {
    const infra = r.taskAggs.filter(t => t.buckets.some(b => b !== 'MODEL_FAILURE'));
    if (!infra.length) continue;
    anyInfra = true;
    for (const t of infra) {
      md += `- **${r.model}** ${t.id}: ${t.buckets.join(', ')}${t.unscoredReps ? ` — ${t.unscoredReps}/${prov.reps} reps UNSCORED` : ''}\n`;
    }
  }
  if (!anyInfra) md += `None — all task failures in this run are attributable to model behavior.\n`;

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

  md += `\n## Methodology & limitations\n\n`;
  md += `- **Budgets sized for reasoning:** ${TASK_TOKENS.toLocaleString()}-token output budget, ${REASONING_TIMEOUT / 60000}min reasoning/analysis SLO, ${CODE_TIMEOUT / 60000}min code SLO. A timeout under these budgets is a finding, not an artifact.\n`;
  md += `- **Answer keys machine-verified at build time:** the scheduling window, TCO arithmetic, reconciliation set, and figure sums were verified by script; code-task test batteries were validated against reference solutions before any model ran.\n`;
  md += `- **Coding tasks are execution-verified:** model code runs in a network-less Docker sandbox (python:3.11-alpine, 512MB, 30s) against basic + edge-case assertion batteries.\n`;
  md += `- **Deterministic checks only:** analytical prose quality is unscored; raw outputs are published for human review. Regex-based checks on analysis tasks can miss unconventional-but-correct phrasings — check raw outputs before trusting a FAIL on a prose check.\n`;
  md += `- **${REPS} repetitions** at temperature 0.2; stochastic effects beyond ${REPS} reps are not captured.\n`;

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
    for (const batch of [reasoningTasks, codeTasks, analysisTasks]) {
      const batchResults = await batch(client, model);
      repTasks.push(...batchResults);
      for (const t of batchResults) {
        const tag = t.unscored ? ' [UNSCORED: outage]' : t.bucket && t.bucket !== 'MODEL_FAILURE' ? ` [${t.bucket}]` : '';
        console.log(`  ${t.id}: ${pct(t.score)} (${(t.durationMs / 1000).toFixed(1)}s)${tag}${t.error ? ` — ${t.error.slice(0, 80)}` : ''}`);
      }
    }
    reps.push(repTasks);
  }

  const taskAggs = aggregateTasks(reps);
  const dims: Record<string, number> = {};
  for (const dim of ['reasoning', 'code', 'analysis'] as const) {
    const dimTasks = taskAggs.filter(t => t.dimension === dim && t.scoredReps > 0);
    dims[dim] = dimTasks.length ? dimTasks.reduce((s, t) => s + t.meanScore, 0) / dimTasks.length : 0;
  }
  const overall = (dims.reasoning + dims.code + dims.analysis) / 3;
  const flippedTotal = taskAggs.reduce((s, t) => s + t.flippedChecks.length, 0);
  const batteryTokens = taskAggs.reduce((s, t) => s + t.meanCompletionTokens, 0);
  console.log(`  OVERALL: ${pct(overall)} (reasoning ${pct(dims.reasoning)} · code ${pct(dims.code)} · analysis ${pct(dims.analysis)}) · ${flippedTotal} flipped checks · ${batteryTokens} ctok/battery`);

  return {
    model: row.label, thinkMode: row.think, batteryTokens,
    digest: meta?.digest, quant: meta?.quant, paramSize: meta?.paramSize,
    loadMs, reps, taskAggs,
    dimensionScores: dims, overall, flippedTotal, totalMs: Date.now() - modelStart,
  };
}

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  let catalog: Array<{ name: string; model?: string; digest?: string; details?: { quantization_level?: string; parameter_size?: string } }> = [];
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`);
    catalog = ((await res.json()) as { models: typeof catalog }).models;
  } catch (err) {
    console.warn('Could not fetch /api/tags for provenance:', err instanceof Error ? err.message : err);
  }

  const args = process.argv.slice(2);
  const rows: ModelRow[] = (args.length ? args : [...DEFAULT_MODELS]).map(parseModelArg);
  instrumentClient(client);

  let gitCommit = 'unknown', gitDirty = false;
  try {
    gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
    gitDirty = execSync('git status --porcelain -- scripts/model-eval-deep.ts').toString().trim().length > 0;
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

  const noThinkControl = new Set(
    (config.inference?.backends ?? []).filter(b => !b.supportsThink).flatMap(b => b.models ?? []),
  );

  const baseNames = [...new Set(rows.map(r => r.name))];
  console.log(`Deep eval — ${baseNames.length} base models × ${REPS} reps (thinking models expand to think=on/off rows) -> ${RUN_DIR}`);
  const results: ModelResult[] = [];
  for (const name of baseNames) {
    const meta = prov.models.find(m => m.name === name);
    const explicit = rows.filter(r => r.name === name && r.think !== undefined);
    let modelRows: ModelRow[];
    if (explicit.length) {
      modelRows = explicit;
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
          loadMs: 0, reps: [], taskAggs: [],
          dimensionScores: { reasoning: 0, code: 0, analysis: 0 }, overall: 0, flippedTotal: 0, totalMs: 0,
        });
      }
      persist(results, baseNames.slice(baseNames.indexOf(name) + 1), prov);
    }
  }

  console.log(`\nDEEP EVAL COMPLETE — ${results.length} rows × ${REPS} reps. Report: ${join(RUN_DIR, 'report.md')}`);
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  for (const [i, r] of sorted.entries()) {
    console.log(`  ${i + 1}. ${r.model} — ${pct(r.overall)} (${r.flippedTotal} flipped checks, ${r.batteryTokens} ctok)`);
  }
}

main().catch(err => {
  console.error('Deep eval failed to run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
