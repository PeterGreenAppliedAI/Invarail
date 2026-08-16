/**
 * Flow duel — the FlowMCP thesis as a test: explore-then-ossify.
 *
 * Phase 1 (exploration): task with NO route given, a bag of tools with decoys,
 * run through the production ReAct engine. Deterministic checks on outcome +
 * exploration cost.
 *
 * Phase 2 (ossification): the model gets its OWN exploration transcript and
 * compiles a reusable flow (fixed JSON format, {{placeholders}}, NO loops) —
 * then the HARNESS executes the flow against an unseen customer with no model
 * involved. Generalization lint + end-to-end outcome checks. Determinism after
 * exploration, measured.
 *
 * Usage: npx tsx scripts/flow-duel.ts   (lab tmux, LAN)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { runToolLoop } from '../src/tool-loop/engine.js';
import { stripThinkingTags } from '../src/utils/text.js';
import type { OllamaClient } from '../src/ollama/client.js';
import type { ToolDefinition, ToolExecutor, ToolContext } from '../src/tools/types.js';

const RUN_DIR = join('data', 'model-eval', 'flow-duel-2026-08-16');
mkdirSync(RUN_DIR, { recursive: true });

const CONTESTANTS = [
  { id: 'deepseek', model: 'deepseek-v4-flash', think: undefined as boolean | undefined },
  { id: 'qwen38', model: 'qwen3.8:27b', think: true as boolean | undefined },
];

// ---------------------------------------------------------------- mock world

interface Dataset {
  customers: Record<string, { customerId: string }>;
  details: Record<string, { accountManagerId: string; region: string }>;
  invoices: Record<string, Array<{ id: string; status: string; amount: number }>>;
  staff: Record<string, { email: string; name: string }>;
}

const ACME: Dataset = {
  customers: { 'acme corp': { customerId: 'C-771' } },
  details: { 'C-771': { accountManagerId: 'M-12', region: 'northeast' } },
  invoices: {
    'C-771': [
      { id: 'INV-9001', status: 'unpaid', amount: 450.0 },
      { id: 'INV-9002', status: 'paid', amount: 200.0 },
      { id: 'INV-9003', status: 'unpaid', amount: 125.5 },
      { id: 'INV-9004', status: 'unpaid', amount: 300.0 },
    ],
  },
  staff: { 'M-12': { email: 'jordan@corp.example', name: 'Jordan Reyes' } },
};

const GLOBEX: Dataset = {
  customers: { 'globex inc': { customerId: 'C-802' } },
  details: { 'C-802': { accountManagerId: 'M-7', region: 'west' } },
  invoices: {
    'C-802': [
      { id: 'INV-3301', status: 'unpaid', amount: 990.25 },
      { id: 'INV-3302', status: 'unpaid', amount: 250.0 },
      { id: 'INV-3303', status: 'paid', amount: 75.0 },
    ],
  },
  staff: { 'M-7': { email: 'sam@corp.example', name: 'Sam Okafor' } },
};
const GLOBEX_TOTAL = '1240.25';

interface CallLog { tool: string; params: Record<string, unknown> }
interface SentEmail { to: string; subject: string; body: string }

function makeExecutor(data: Dataset, log: CallLog[], sent: SentEmail[]): ToolExecutor {
  return async (name, params) => {
    log.push({ tool: name, params });
    const s = (k: string): string => String(params[k] ?? '').trim();
    switch (name) {
      case 'crm_search': {
        const hit = data.customers[s('name').toLowerCase()];
        return hit ? JSON.stringify(hit) : JSON.stringify({ error: `no customer matching "${s('name')}"` });
      }
      case 'customer_lookup': {
        const d = data.details[s('customerId')];
        return d ? JSON.stringify(d) : JSON.stringify({ error: 'unknown customerId' });
      }
      case 'invoices_list': {
        const inv = data.invoices[s('customerId')];
        return inv ? JSON.stringify(inv.map(i => ({ id: i.id, status: i.status }))) : JSON.stringify({ error: 'unknown customerId' });
      }
      case 'invoice_detail': {
        const all = Object.values(data.invoices).flat();
        const hit = all.find(i => i.id === s('invoiceId'));
        return hit ? JSON.stringify(hit) : JSON.stringify({ error: 'unknown invoiceId' });
      }
      case 'invoices_totals': {
        const inv = data.invoices[s('customerId')];
        if (!inv) return JSON.stringify({ error: 'unknown customerId' });
        const status = s('status') || 'all';
        const picked = status === 'all' ? inv : inv.filter(i => i.status === status);
        return JSON.stringify({ total: Math.round(picked.reduce((a, i) => a + i.amount, 0) * 100) / 100, count: picked.length, status });
      }
      case 'staff_lookup': {
        const st = data.staff[s('managerId')];
        return st ? JSON.stringify(st) : JSON.stringify({ error: 'unknown managerId' });
      }
      case 'send_email':
        sent.push({ to: s('to'), subject: s('subject'), body: s('body') });
        return JSON.stringify({ ok: true, messageId: 'msg-001' });
      case 'billing_report':
        return 'Error: billing_report is deprecated. Use invoices_list or invoices_totals instead.';
      case 'ledger_query':
        return 'Error: permission denied — ledger access requires finance-admin role.';
      case 'cache_get':
        return '(empty — no cached value for that key)';
      case 'web_search':
        return JSON.stringify([{ title: 'Acme Corp — Wikipedia', url: 'https://en.wikipedia.org/wiki/Acme', snippet: 'Fictional company…' }]);
      default:
        return `Error: Tool "${name}" is not available.`;
    }
  };
}

const TOOLS: ToolDefinition[] = [
  { name: 'crm_search', description: 'Find a customer record by company name. Returns {customerId}.', parameterDescription: '{"name": "company name"}', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Company name' } }, required: ['name'] } },
  { name: 'customer_lookup', description: 'Fetch customer details by id. Returns {accountManagerId, region}.', parameterDescription: '{"customerId": "C-..."}', parameters: { type: 'object', properties: { customerId: { type: 'string', description: 'Customer id' } }, required: ['customerId'] } },
  { name: 'invoices_list', description: 'List invoice ids and statuses for a customer. Returns [{id, status}] — NO amounts.', parameterDescription: '{"customerId": "C-..."}', parameters: { type: 'object', properties: { customerId: { type: 'string', description: 'Customer id' } }, required: ['customerId'] } },
  { name: 'invoice_detail', description: 'Fetch one invoice. Returns {id, status, amount}.', parameterDescription: '{"invoiceId": "INV-..."}', parameters: { type: 'object', properties: { invoiceId: { type: 'string', description: 'Invoice id' } }, required: ['invoiceId'] } },
  { name: 'invoices_totals', description: 'Aggregate invoice totals for a customer, optionally filtered by status ("paid"|"unpaid"). Returns {total, count, status}.', parameterDescription: '{"customerId": "C-...", "status": "unpaid"}', parameters: { type: 'object', properties: { customerId: { type: 'string', description: 'Customer id' }, status: { type: 'string', description: 'Filter: paid | unpaid | all' } }, required: ['customerId'] } },
  { name: 'staff_lookup', description: 'Fetch a staff member by manager id. Returns {email, name}.', parameterDescription: '{"managerId": "M-..."}', parameters: { type: 'object', properties: { managerId: { type: 'string', description: 'Manager id' } }, required: ['managerId'] } },
  { name: 'send_email', description: 'Send an email.', parameterDescription: '{"to": "...", "subject": "...", "body": "..."}', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient' }, subject: { type: 'string', description: 'Subject' }, body: { type: 'string', description: 'Body' } }, required: ['to', 'subject', 'body'] } },
  { name: 'billing_report', description: 'Generate a billing report for a customer.', parameterDescription: '{"customerId": "C-..."}', parameters: { type: 'object', properties: { customerId: { type: 'string', description: 'Customer id' } }, required: ['customerId'] } },
  { name: 'ledger_query', description: 'Query the general ledger.', parameterDescription: '{"query": "..."}', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Ledger query' } }, required: ['query'] } },
  { name: 'cache_get', description: 'Read a cached value by key.', parameterDescription: '{"key": "..."}', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Cache key' } }, required: ['key'] } },
  { name: 'web_search', description: 'Search the public web.', parameterDescription: '{"query": "..."}', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
];

// ---------------------------------------------------------------- flow executor

// FlowMCP dialect (the mcp_call + template subset of the real format — see
// FlowMCP/bench/compiler/dogfood/flows/weekly_gather.flow.json5). Refs are
// {{input.x}} and {{steps.<id>.<field>}}, exactly like production flows.
interface FlowStep { id: string; kind: string; server?: string; tool?: string; args?: Record<string, unknown>; template?: string }
interface Flow { name?: string; description?: string; input?: Record<string, unknown> | string[]; steps: FlowStep[]; output?: string }

function resolvePlaceholders(value: string, scope: Record<string, unknown>): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.[\]:-]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.');
    let cur: unknown = scope;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else return `<<UNRESOLVED:${path}>>`;
    }
    return String(cur);
  });
}

async function executeFlow(flow: Flow, input: Record<string, string>, data: Dataset): Promise<{ ok: boolean; sent: SentEmail[]; calls: CallLog[]; error?: string }> {
  const calls: CallLog[] = [];
  const sent: SentEmail[] = [];
  const exec = makeExecutor(data, calls, sent);
  const steps: Record<string, unknown> = {};
  const scope: Record<string, unknown> = { input, steps };
  for (const step of flow.steps ?? []) {
    if (!step.id || !step.kind) return { ok: false, sent, calls, error: `malformed step: ${JSON.stringify(step)}` };
    if (step.kind === 'template') {
      const rendered = resolvePlaceholders(String(step.template ?? ''), scope);
      if (rendered.includes('<<UNRESOLVED:')) return { ok: false, sent, calls, error: `unresolved placeholder in template ${step.id}` };
      steps[step.id] = rendered;
      continue;
    }
    if (step.kind !== 'mcp_call') return { ok: false, sent, calls, error: `unsupported step kind "${step.kind}" (this runner supports mcp_call and template)` };
    if (!step.tool) return { ok: false, sent, calls, error: `mcp_call step ${step.id} missing tool` };
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.args ?? {})) {
      const resolved = resolvePlaceholders(String(v), scope);
      if (resolved.includes('<<UNRESOLVED:')) return { ok: false, sent, calls, error: `unresolved placeholder in ${step.id}.${k}: ${resolved}` };
      params[k] = resolved;
    }
    const out = await exec(step.tool, params, { agentId: 'flow', sessionKey: 'flow' } as ToolContext);
    let parsed: unknown;
    try { parsed = JSON.parse(out); } catch { parsed = { raw: out }; }
    if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
      return { ok: false, sent, calls, error: `step ${step.id} (${step.tool}) errored: ${(parsed as Record<string, unknown>).error}` };
    }
    steps[step.id] = parsed;
  }
  return { ok: true, sent, calls };
}

function looseJson<T>(reply: string): T | null {
  const clean = stripThinkingTags(reply);
  const candidates = [clean];
  const fence = clean.match(/```(?:json5?)?\s*\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) candidates.push(m[0]);
  for (const cand of candidates) {
    try { return JSON.parse(cand) as T; } catch { /* try json5 */ }
    try { return JSON5.parse(cand) as T; } catch { /* next candidate */ }
  }
  return null;
}

// ---------------------------------------------------------------- phases

const TASK = 'Find the total UNPAID balance for the customer "Acme Corp" and email a short summary (including the total) to their account manager. You have not done this before — discover the right tools.';

const FLOW_FORMAT = `{
  "name": "short-flow-name",
  "description": "WHEN TO USE: ...",
  "input": { "customer_name": "string" },
  "steps": [
    { "id": "s1", "kind": "mcp_call", "server": "crm", "tool": "tool_name", "args": { "paramName": "{{input.customer_name}}" } },
    { "id": "s2", "kind": "mcp_call", "server": "crm", "tool": "tool_name", "args": { "paramName": "{{steps.s1.fieldFromS1Output}}" } },
    { "id": "msg", "kind": "template", "template": "text with {{steps.s2.someField}} embedded" }
  ],
  "output": "{{steps.msg}}"
}`;

interface Check { name: string; pass: boolean; detail?: string }

async function runContestant(client: OllamaClient, c: typeof CONTESTANTS[number]): Promise<void> {
  console.log(`\n================ ${c.id} (${c.model}) ================`);
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string): void => { checks.push({ name, pass, detail }); console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

  // ---- phase 1: exploration
  const calls: CallLog[] = [];
  const sent: SentEmail[] = [];
  const start = Date.now();
  const result = await runToolLoop({
    client,
    config: { model: c.model, maxIterations: 16, temperature: 0.2, maxTokens: 4096, contextSize: 24576, systemPrompt: 'You are an operations assistant. Use the available tools to complete the task. Some tools may be dead ends — recover and find another way.', toolStyle: 'native', ...(c.think !== undefined ? { think: c.think } : {}) },
    tools: TOOLS,
    executor: makeExecutor(ACME, calls, sent),
    toolContext: { agentId: 'flow-duel', sessionKey: `flow-${c.id}` } as ToolContext,
    userMessage: TASK,
  });
  const answer = stripThinkingTags(result.answer ?? '');
  const p1secs = ((Date.now() - start) / 1000).toFixed(0);
  const email = sent[sent.length - 1];
  add('P1: email sent', sent.length > 0);
  add('P1: to account manager', email?.to === 'jordan@corp.example', email?.to);
  add('P1: correct total 875.50 in email', /875\.5/.test(email?.body ?? '') || /875\.5/.test(email?.subject ?? ''), (email?.body ?? '').slice(0, 60));
  add('P1: efficient exploration (<=12 calls)', calls.length <= 12, `${calls.length} calls`);
  add('P1: no fabricated total', !/875\.5/.test(answer) || sent.length > 0);
  const transcript = calls.map((cl, i) => `${i + 1}. ${cl.tool}(${JSON.stringify(cl.params)})`).join('\n');
  console.log(`  P1 done in ${p1secs}s, ${calls.length} calls`);

  // ---- phase 2: ossification (compile from own trace)
  currentThink = c.think;
  const compileResp = await client.chat({
    model: c.model,
    messages: [
      { role: 'system', content: 'You compile exploration traces into reusable, deterministic flows. Precision matters: the flow will be executed by a machine with NO model in the loop.' },
      { role: 'user', content: `You just completed this task by exploration:\nTASK: ${TASK}\n\nYour tool-call trace (in order):\n${transcript}\n\nThe last email you sent: to=${email?.to} subject=${JSON.stringify(email?.subject)} body=${JSON.stringify(email?.body?.slice(0, 200))}\n\nNow compile a REUSABLE FlowMCP flow so this task never needs rediscovery — it must work for ANY customer name, not just Acme Corp. Format (JSON only, no prose):\n${FLOW_FORMAT}\n\nRules:\n- "input" declares the parameters a caller provides (customer_name).\n- {{input.x}} references caller input; {{steps.<id>.<field>}} references a field of that step's JSON output.\n- Step kinds available: "mcp_call" (server is always "crm") and "template". NO loops (no "map"), NO conditionals — steps run once, in order. Choose tools accordingly.\n- Do NOT hardcode any Acme-specific ids, totals, or addresses — the flow must generalize.\n- The email must be SENT by the flow itself (a send_email mcp_call step) with the total embedded via placeholder.\nReply with ONLY the JSON flow.` },
    ],
    ...(c.think !== undefined ? { think: c.think } : {}),
    options: { temperature: 0.2, num_predict: 8192, num_ctx: 24576 },
  } as Parameters<OllamaClient['chat']>[0]);
  currentThink = undefined;
  const flowRaw = compileResp.message?.content ?? '';
  let flow = looseJson<Flow>(flowRaw);
  add('P2: valid flow JSON', !!flow && Array.isArray(flow.steps) && flow.steps.length > 0, flow ? `${flow.steps?.length} steps` : 'unparseable');

  // Dry-run against the KNOWN customer (production ossification: compile from
  // trace → dry-run → repair once on the executor's error → only then trust).
  let repaired = false;
  if (flow) {
    const dry = await executeFlow(flow, { customer_name: 'Acme Corp' }, ACME);
    if (!dry.ok) {
      console.log(`  P2 dry-run failed (${dry.error}) — one repair round`);
      currentThink = c.think;
      const fixResp = await client.chat({
        model: c.model,
        messages: [
          { role: 'system', content: 'You compile exploration traces into reusable, deterministic flows. Precision matters: the flow is executed by a machine with NO model in the loop.' },
          { role: 'user', content: `Your compiled flow failed a dry run.\n\nFLOW:\n${JSON.stringify(flow, null, 2)}\n\nEXECUTOR ERROR:\n${dry.error}\n\nTool output schemas (from your exploration): crm_search -> {customerId}; customer_lookup -> {accountManagerId, region}; invoices_totals -> {total, count, status}; staff_lookup -> {email, name}.\n\nFix the flow. Reply with ONLY the corrected JSON flow.` },
        ],
        ...(c.think !== undefined ? { think: c.think } : {}),
        options: { temperature: 0.2, num_predict: 8192, num_ctx: 24576 },
      } as Parameters<OllamaClient['chat']>[0]);
      currentThink = undefined;
      const fixed = looseJson<Flow>(fixResp.message?.content ?? '');
      if (fixed && Array.isArray(fixed.steps)) { flow = fixed; repaired = true; }
    }
  }
  add('P2: compiled correctly first try (no repair needed)', !!flow && !repaired);

  let hardcodeFree = false, generalized = false, execOk = false, rightEmail = false, rightTotal = false;
  if (flow) {
    const flowStr = JSON.stringify(flow);
    hardcodeFree = !/C-771|875\.5|jordan@|INV-9\d{3}|M-12/.test(flowStr);
    generalized = /\{\{\s*input\.customer_name\s*\}\}/.test(flowStr);
    const run = await executeFlow(flow, { customer_name: 'Globex Inc' }, GLOBEX);
    execOk = run.ok && run.sent.length > 0;
    const gEmail = run.sent[run.sent.length - 1];
    rightEmail = gEmail?.to === 'sam@corp.example';
    rightTotal = new RegExp(GLOBEX_TOTAL.replace('.', '\\.')).test(`${gEmail?.subject} ${gEmail?.body}`);
    if (!run.ok) console.log(`  P2 execution error: ${run.error}`);
  }
  add('P2: no hardcoded Acme values', hardcodeFree);
  add('P2: parameterized on input.customer_name', generalized);
  add('P2: flow executes on UNSEEN customer (no model)', execOk);
  add('P2: email to Globex manager', rightEmail);
  add('P2: correct Globex total 1240.25', rightTotal);

  const score = checks.filter(ch => ch.pass).length;
  console.log(`  SCORE: ${score}/${checks.length}`);
  writeFileSync(join(RUN_DIR, `${c.id}.json`), JSON.stringify({ checks, calls, sent, answer: answer.slice(0, 2000), flow: flow ?? flowRaw.slice(0, 3000), p1secs }, null, 2));
  // The ossified artifact itself, in FlowMCP's on-disk shape — wire a real CRM
  // downstream server later and this file is production-loadable.
  if (flow) writeFileSync(join(RUN_DIR, `${c.id}.flow.json5`), JSON.stringify(flow, null, 2));
}

// think plumbing for the raw chat call in phase 2 (phase 1 goes through the engine's config)
let currentThink: boolean | undefined;

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  // Answer-key discipline: validate the flow executor with a reference flow first.
  const reference: Flow = {
    name: 'unpaid-balance-email', input: { customer_name: 'string' },
    steps: [
      { id: 's1', kind: 'mcp_call', server: 'crm', tool: 'crm_search', args: { name: '{{input.customer_name}}' } },
      { id: 's2', kind: 'mcp_call', server: 'crm', tool: 'invoices_totals', args: { customerId: '{{steps.s1.customerId}}', status: 'unpaid' } },
      { id: 's3', kind: 'mcp_call', server: 'crm', tool: 'customer_lookup', args: { customerId: '{{steps.s1.customerId}}' } },
      { id: 's4', kind: 'mcp_call', server: 'crm', tool: 'staff_lookup', args: { managerId: '{{steps.s3.accountManagerId}}' } },
      { id: 'msg', kind: 'template', template: 'Total unpaid for {{input.customer_name}}: ${{steps.s2.total}} across {{steps.s2.count}} invoice(s).' },
      { id: 's5', kind: 'mcp_call', server: 'crm', tool: 'send_email', args: { to: '{{steps.s4.email}}', subject: 'Unpaid balance for {{input.customer_name}}', body: '{{steps.msg}}' } },
    ],
  };
  const ref = await executeFlow(reference, { customer_name: 'Globex Inc' }, GLOBEX);
  const refEmail = ref.sent[0];
  if (!ref.ok || refEmail?.to !== 'sam@corp.example' || !refEmail.body.includes(GLOBEX_TOTAL)) {
    throw new Error(`Reference flow failed validation: ${JSON.stringify({ ok: ref.ok, error: ref.error, email: refEmail })}`);
  }
  console.log('Reference flow validated: executor + answer key sound.');

  for (const c of CONTESTANTS) await runContestant(client, c);
  console.log('\nFLOW DUEL COMPLETE — artifacts in', RUN_DIR);
}

main().catch(err => { console.error('Flow duel failed:', err instanceof Error ? err.message : err); process.exit(1); });
