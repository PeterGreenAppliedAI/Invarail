/**
 * The install under test: a scratch directory holding a wizard-generated config for the model,
 * a bootstrapped workspace, and the real tool registry, pipelines and stores — with only the
 * web tools swapped for the fixed corpus.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/loader.js';
import type { InvarailConfig } from '../../src/config/types.js';
import { createInferenceClient } from '../../src/ollama/multi-backend.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerAllTools } from '../../src/tools/register-all.js';
import { PipelineRegistry } from '../../src/pipeline/registry.js';
import { registerAllPipelines } from '../../src/pipeline/definitions/index.js';
import { SessionStore } from '../../src/sessions/store.js';
import { FactStore } from '../../src/memory/fact-store.js';
import { TaskStore } from '../../src/tasks/store.js';
import { CronStore } from '../../src/cron/store.js';
import { CronService } from '../../src/cron/service.js';
import { bootstrapWorkspace } from '../../src/agents/workspace.js';
import { resolveWorkspacePath } from '../../src/agents/scope.js';
import { buildConfig, type WizardState } from '../../src/setup/steps/generate.js';
import { findMeasured, thinkFor, foregroundTier } from '../../src/setup/measured-models.js';
import { makeWebStubs } from './corpus.js';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The principal every task speaks as — the config's ownerId. */
export const OWNER = 'eval-owner';

export interface InstallOptions {
  /** `full` | `small` | `wizard` (whatever the wizard writes for this model's tier). */
  profile: 'full' | 'small' | 'wizard';
  /** `fresh` (bootstrap files only) | `lived` (USER/TOOLS/AGENTS/LEARNINGS filled in). */
  workspace: 'fresh' | 'lived';
  /** Disable the specialist reroute (router.reroute), to measure the other routing levers alone. */
  rerouteOff: boolean;
  /** Restore the pre-2026-09-29 wording of the four router categories the routing work rewrote. */
  legacyDescriptions: boolean;
  canRenderPdf: boolean;
}

/** The old category text, for the `--descriptions=legacy` A/B arm. It lives here, not in the product. */
const LEGACY_CATEGORY_TEXT: Record<string, string> = {
  web_search: 'Questions needing current internet information about external topics',
  exec: 'Run commands, edit files, system operations',
  task: 'Create, list, update, or complete tasks and to-dos',
  multi: 'Complex requests needing multiple different tools or multi-step planning',
};

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

export interface Env {
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
  /** Whether this box can render PDFs at all (LibreOffice). The research PDF check is skipped, with that reason, where it cannot. */
  canRenderPdf: boolean;
}

/** Close what holds files open, then remove the scratch install. */
export function teardown(env: Env): void {
  try { env.embeddingStore?.close(); } catch { /* already closed */ }
  process.chdir(REPO);
  rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function wizardState(model: string, ollamaUrl: string, profile: InstallOptions['profile']): WizardState {
  return {
    ollama: { url: ollamaUrl, models: [] },
    models: {
      routerModel: model, specialistModel: model, backgroundModel: model,
      categoryModels: {}, inferenceBackends: [],
      specialistThink: thinkFor(findMeasured(model)),
      foregroundTier: profile === 'wizard' ? foregroundTier(model) : profile,
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

/**
 * A fresh install in a scratch directory: wizard config for THIS model, bootstrapped
 * workspace, real registry + pipelines + stores.
 *
 * Why the process-wide `chdir` and env vars: the runtime resolves `data/…` paths against the
 * working directory and reads OLLAMA_URL / provider keys from the environment, exactly as a
 * real install does. Pointing the process at the scratch directory is what makes this the
 * real front door rather than a re-wiring of it. The cost is deliberate: installs run one at
 * a time, and `teardown` returns to the repo.
 */
export async function makeEnv(model: string, ollamaUrl: string, opts: InstallOptions): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'invarail-e2e-'));
  const configPath = join(root, 'invarail.config.json5');
  writeFileSync(configPath, buildConfig(wizardState(model, ollamaUrl, opts.profile)));
  process.env.OLLAMA_URL = ollamaUrl;
  process.env.BRAVE_API_KEY = 'stub';
  process.chdir(root);
  const config = loadConfig(configPath);
  if (opts.rerouteOff) config.router.reroute = { enabled: false };
  if (opts.legacyDescriptions) {
    for (const [name, description] of Object.entries(LEGACY_CATEGORY_TEXT)) {
      if (config.router.categories[name]) config.router.categories[name] = { ...config.router.categories[name], description };
    }
  }
  // The client the way the orchestrator builds it — from THIS config, so calls that name
  // no num_ctx (quality judge, summaries) get the generated defaultContextSize. A shared
  // client built without it sent those calls to the server's default and reloaded the
  // model between them (second A/B pass, 2026-09-27).
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, [], [], config.ollama.defaultContextSize);
  instrument(client);

  const ws = resolveWorkspacePath(config.agents.default, config);
  bootstrapWorkspace(ws, 'Invarail');
  if (opts.workspace === 'lived') seedLivedWorkspace(ws);
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
  return { root, ws, config, client, registry, pipelines, sessions, facts, tasks, cron, webLog, embeddingStore, canRenderPdf: opts.canRenderPdf };
}

/** Token and call counts across every chat call of every install — the runner diffs it per task. */
export const meter = { prompt: 0, completion: 0, calls: 0 };
function instrument(client: OllamaClient): void {
  const orig = client.chat.bind(client);
  (client as { chat: unknown }).chat = async (params: Record<string, unknown>) => {
    meter.calls++;
    const res = await orig(params as Parameters<typeof orig>[0]);
    const r = res as unknown as { eval_count?: number; prompt_eval_count?: number };
    meter.completion += r.eval_count ?? 0;
    meter.prompt += r.prompt_eval_count ?? 0;
    return res;
  };
}
