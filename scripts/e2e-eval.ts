/**
 * End-to-end model eval — the SAME front door a user's message takes.
 *
 * `scripts/model-eval.ts` measures the ENGINE (runToolLoop + extractParams with mock tools and
 * a fifteen-token system prompt). It cannot see what a small model does under the real thing:
 * the router, a wizard-generated config, the specialist prompts, the workspace context, the
 * real tool schemas, the six security layers, the confirm ledger, session history, the
 * pipelines. This harness can. Every task goes through `dispatchMessage` with the config the
 * wizard would generate for the model under test, in a scratch directory that IS the install.
 *
 *   scripts/e2e/install.ts  the scratch install (wizard config, workspace, registry, stores)
 *   scripts/e2e/corpus.ts   the stubbed web: a fixed corpus behind web_search / web_fetch
 *   scripts/e2e/tasks.ts    the twelve tasks, their code oracles, and reference performers
 *   scripts/e2e/report.ts   the published report (mean score + pass rate with a Wilson interval)
 *
 * Only the WEB is stubbed. Scoring is code oracles, never a judge. `--selftest` runs every
 * task's scripted perfect performer through its oracles with no model (CI runs it on Linux and
 * Windows), so a wrong check cannot masquerade as a model failure. A provider outage is
 * retried once and then left unscored, never counted against the model.
 *
 * Usage:
 *   npx tsx scripts/e2e-eval.ts <model> [model ...] [flags]
 *   npx tsx scripts/e2e-eval.ts --selftest [--task=...]
 *
 * Flags:
 *   --reps=N                 repetitions of the battery (default 1)
 *   --task=a,b               run only these task ids
 *   --profile=wizard|full|small   prompt profile (default: whatever the wizard writes for the model)
 *   --workspace=fresh|lived  bootstrap-only workspace, or one grown to ~3K tokens of context
 *   --label=name             suffix for the output directory, so A/B arms don't overwrite each other
 *   --reroute=off            disable the specialist reroute
 *   --descriptions=legacy    restore the pre-2026-09-29 router category wording
 *
 * OLLAMA_URL picks the model host (default http://localhost:11434). Results land in
 * data/model-eval/e2e-<date>-<profile>-<workspace>[-label]/ with the host redacted.
 * NOTE for the reference lab: node spawned over SSH is denied LAN access by macOS — run it
 * inside the `lab` tmux session.
 */
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { dispatchMessage, type DispatchResult } from '../src/dispatch.js';
import { findMeasured, thinkFor, foregroundTier, contextSizeForTier } from '../src/setup/measured-models.js';
import { detectLibreOffice } from '../src/setup/detect.js';
import { REPO, OWNER, makeEnv, teardown, meter, type Env, type InstallOptions } from './e2e/install.js';
import { TASKS, has, clean, type E2ETask, type CheckResult, type TaskCtx } from './e2e/tasks.js';
import { report, type TaskRecord, type ModelRecord } from './e2e/report.js';
import { pct } from './e2e/stats.js';
import { redactUrl } from './e2e/redact.js';

const USAGE = 'usage: npx tsx scripts/e2e-eval.ts <model> [model ...] [--reps=N] [--task=a,b] [--profile=wizard|full|small] [--workspace=fresh|lived] [--label=name] [--reroute=off] [--descriptions=legacy] | --selftest';
const DATE = new Date().toISOString().slice(0, 10);
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const REPS = Number(flag('reps') ?? 1);
const TASK_FILTER = flag('task')?.split(',').map(t => t.trim()).filter(Boolean);
const PROFILE = (flag('profile') ?? 'wizard') as InstallOptions['profile'];
const WORKSPACE = (flag('workspace') ?? 'fresh') as InstallOptions['workspace'];
const LABEL = flag('label');
const REROUTE_OFF = flag('reroute') === 'off';
const LEGACY_DESCRIPTIONS = flag('descriptions') === 'legacy';
const RUN_DIR = join(REPO, 'data', 'model-eval', `e2e-${DATE}-${PROFILE}-${WORKSPACE}${LABEL ? `-${LABEL}` : ''}`);
const SELFTEST = argv.includes('--selftest');
const MODELS = argv.filter(a => !a.startsWith('--'));
/** Resolved once at startup: whether this box can render PDFs at all. */
let canRenderPdf = false;

const installOptions = (): InstallOptions => ({ profile: PROFILE, workspace: WORKSPACE, rerouteOff: REROUTE_OFF, legacyDescriptions: LEGACY_DESCRIPTIONS, canRenderPdf });

// ---------------------------------------------------------------- running

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
  const env = await makeEnv(model, ollamaUrl, installOptions());
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
    id: task.id, expected: task.expect, routed: result?.category, routedBy: result?.classification?.confidence, reroutedFrom: result?.reroutedFrom,
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
    if (TASK_FILTER && !TASK_FILTER.includes(task.id)) continue;
    const env = await makeEnv('selftest-model', 'http://127.0.0.1:1', installOptions());
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

async function main(): Promise<void> {
  canRenderPdf = (await detectLibreOffice()).found;
  if (!canRenderPdf) console.log('No LibreOffice on this box — the research PDF check is skipped with that reason (the pipeline cannot render one here)');
  if (SELFTEST) { await selftest(); return; }
  if (!MODELS.length) { console.error(USAGE); process.exit(2); }
  mkdirSync(RUN_DIR, { recursive: true });
  // Never the live config: this is a fresh install's view. OLLAMA_URL picks the host.
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const warm = createInferenceClient(ollamaUrl, undefined, [], [], undefined);   // warmup only; every task builds its own from its config
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { /* not fatal */ }
  const tasks = TASK_FILTER ? TASKS.filter(t => TASK_FILTER.includes(t.id)) : TASKS;
  // Everything needed to reproduce the run — and nothing that locates the lab (the host is redacted).
  const prov = {
    date: new Date().toISOString(), gitCommit, ollamaUrl: redactUrl(ollamaUrl), reps: REPS, profile: PROFILE, workspace: WORKSPACE,
    label: LABEL, reroute: REROUTE_OFF ? 'off' : 'on', descriptions: LEGACY_DESCRIPTIONS ? 'legacy' : 'current', tasks: tasks.map(t => t.id),
  };
  console.log(`E2E eval — ${MODELS.length} model(s) × ${tasks.length} task(s) × ${REPS} rep(s) · profile=${PROFILE} workspace=${WORKSPACE} → ${relative(REPO, RUN_DIR)}`);

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
        console.log(`  ${rec.id}: ${rec.unscored ? 'UNSCORED' : pct(rec.score)} routed=${rec.routed ?? '—'}${rec.reroutedFrom ? ` (rerouted from ${rec.reroutedFrom})` : ''} calls=${rec.modelCalls} ptok=${rec.promptTokens} ${(rec.durationMs / 1000).toFixed(0)}s${bad ? ` — ✗ ${bad}` : ''}${rec.error ? ` [${rec.bucket}] ${rec.error.slice(0, 80)}` : ''}`);
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
      const ids = tasks.filter(t => t.expect[0] === cat && taskScores[t.id] !== undefined).map(t => t.id);
      if (ids.length) categoryScores[cat] = ids.reduce((s, id) => s + taskScores[id], 0) / ids.length;
    }
    const overall = Object.values(taskScores).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(taskScores).length);
    const think = thinkFor(findMeasured(model));
    results.push({ model, profile: PROFILE === 'wizard' ? `wizard→${foregroundTier(model)}` : PROFILE, think, reps, taskScores, categoryScores, overall, totalMs: Date.now() - modelStart });
    console.log(`  OVERALL: ${pct(overall)} · ${Object.entries(categoryScores).map(([k, v]) => `${k} ${pct(v)}`).join(' · ')} · ${((Date.now() - modelStart) / 60000).toFixed(1)}m`);
    writeFileSync(join(RUN_DIR, 'results.json'), JSON.stringify({ provenance: prov, results }, null, 2));
    writeFileSync(join(RUN_DIR, 'report.md'), report(results, prov, { date: DATE, profile: PROFILE, workspace: WORKSPACE, reps: REPS, tasks }));
  }
  console.log(`\nE2E COMPLETE — report: ${relative(REPO, join(RUN_DIR, 'report.md'))}`);
}

// registerAllTools opens stores with timers (quota, ledger, sqlite) that keep the loop alive — exit explicitly.
main().then(() => process.exit(0)).catch(err => { console.error('E2E eval failed to run:', err instanceof Error ? err.stack ?? err.message : err); process.exit(1); });
