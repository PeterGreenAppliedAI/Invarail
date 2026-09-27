/**
 * `invarail doctor` — the environment, checked against what the config ENABLES.
 *
 * Runs at the start of `npm start` (quiet: only warnings and failures) and on demand
 * (`npm run doctor`). Every line has a status and, where it fails, the fix. The rule
 * that made the runtime legible applies to install too: a missing dependency shows
 * up as a named check with a command beside it, not as a warning buried in a log.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { InvarailConfig } from '../config/types.js';
import { detect, type DetectReport } from './detect.js';
import { foregroundTier } from './measured-models.js';
import { memoryBackend, embeddingsEnabled, okfEnabled } from '../memory/policy.js';
import { checkBundle } from '../knowledge/okf.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail?: string;
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passes: number;
  warns: number;
  fails: number;
  report: DetectReport;
}

// The adapter binds 0.0.0.0 when `host` is unset — unset is NOT loopback.
const isLoopback = (h: string | undefined) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

/** Names a config references that must exist on the given Ollama host. */
export function ollamaModelsReferenced(config: InvarailConfig): string[] {
  const names = new Set<string>();
  const backendModels = new Set([
    ...(config.inference?.backends ?? []).flatMap(b => b.models),
    ...(config.inference?.ollamaBackends ?? []).flatMap(b => b.models),
  ]);
  const add = (m?: string) => { if (m && !backendModels.has(m)) names.add(m); };
  add((config as { defaultModel?: string }).defaultModel);
  add(config.router.model);
  for (const s of Object.values(config.specialists)) add(s.model);
  add(config.memory?.embeddingModel);
  add(config.memory?.nerModel);
  add(config.memory?.extractionModel);
  add(config.vision?.model);
  return [...names];
}

function hasModel(available: string[], name: string): boolean {
  return available.includes(name) || available.includes(`${name}:latest`) || available.some(a => a.split(':')[0] === name);
}

export function doctorChecks(report: DetectReport, config: InvarailConfig | null, configError?: string): DoctorCheck[] {
  const c: DoctorCheck[] = [];
  const push = (name: string, status: DoctorStatus, detail?: string, fix?: string) => c.push({ name, status, detail, fix });

  push('Node.js', report.node.ok ? 'PASS' : 'FAIL', `v${report.node.version}`, report.node.ok ? undefined : 'Install Node 22+ (https://nodejs.org)');

  if (!report.config.present) {
    push('Config', 'FAIL', `${report.config.path} not found`, 'npm run setup   (or: cp invarail.config.starter.json5 invarail.config.json5)');
  } else if (configError) {
    push('Config', 'FAIL', configError);
  } else {
    push('Config', 'PASS', report.config.path);
  }
  if (!report.env.present) push('.env', 'WARN', 'no .env — every ${VAR} in the config resolves to empty', 'cp .env.example .env and fill what your config references');

  // Does the foreground model fit? Ollama reports each model's on-disk size; a Q4 model
  // needs roughly that much memory plus KV headroom. Budget: 85% of VRAM when there is a
  // GPU, else 60% of RAM (the OS and the process need the rest).
  if (config && report.ollama.reachable) {
    const fg = (config as { defaultModel?: string }).defaultModel ?? config.specialists.chat?.model;
    const remote = fg ? (config.inference?.ollamaBackends ?? []).find(b => b.models.includes(fg)) : undefined;
    const size = fg ? report.ollama.modelSizes[fg] ?? report.ollama.modelSizes[`${fg}:latest`] : undefined;
    if (fg && remote) {
      const rsize = report.ollamaBackends.find(b => b.url === remote.url)?.modelSizes[fg];
      push('Foreground model fits', 'PASS', `${fg}${rsize ? ` (${(rsize / 1e9).toFixed(1)}GB)` : ''} is served by ${new URL(remote.url).host} — that box's memory, not this one's, decides`);
    } else if (fg && size) {
      const gb = size / 1e9;
      const budget = report.memory.gpuVramGb ? report.memory.gpuVramGb * 0.85 : report.memory.totalGb * 0.6;
      const where = report.memory.gpuVramGb ? `${report.memory.gpuName} ${report.memory.gpuVramGb}GB VRAM` : `${report.memory.totalGb}GB RAM, no NVIDIA GPU`;
      if (gb <= budget) push('Foreground model fits', 'PASS', `${fg} is ${gb.toFixed(1)}GB; ${where}`);
      else push('Foreground model fits', 'WARN', `${fg} is ${gb.toFixed(1)}GB — ${where} leaves ~${budget.toFixed(0)}GB usable; expect CPU offload and slow replies`, 'pick a smaller foreground model (evals/2026-09-small-tier: qwen3.5:9b at 6.6GB, gemma4:12b at 7.6GB, qwen2.5:7b at 4.7GB) or serve it from a bigger box via inference.ollamaBackends');
    }
  }

  // Prompt profile vs the foreground model's tier — config says it, this keeps it honest.
  if (config) {
    const fg = (config as { defaultModel?: string }).defaultModel ?? config.specialists.chat?.model;
    const profile = (config as { promptProfile?: string }).promptProfile ?? 'full';
    const size = fg ? report.ollama.modelSizes[fg] ?? report.ollama.modelSizes[`${fg}:latest`]
      ?? report.ollamaBackends.map(b => b.modelSizes[fg]).find(Boolean) : undefined;
    if (fg) {
      const tier = foregroundTier(fg, size ? size / 1e9 : undefined);
      if (tier === profile) push('Prompt profile', 'PASS', `${profile} — matches ${fg}${size ? ` (${(size / 1e9).toFixed(1)}GB)` : ''}`);
      else if (tier === 'small') push('Prompt profile', 'WARN', `${fg} is small-tier but promptProfile is "${profile}": chat carries the full workspace set and a 32K history budget it cannot afford`, 'set promptProfile: "small" and session.contextSize / router.contextSize / memory.extractionContextSize to 16384 (evals/2026-09-e2e)');
      else push('Prompt profile', 'WARN', `${fg} is a full-tier model but promptProfile is "small": chat is missing TOOLS.md/USER.md/AGENTS.md it could carry`, 'set promptProfile: "full"');
    }
  }

  // Memory tier requirements (src/memory/policy.ts)
  if (config) {
    const backend = memoryBackend(config);
    const embedder = config.memory?.embeddingModel;
    const embed = embeddingsEnabled(config.memory);
    if (backend === 'graph' && !report.falkordb.reachable) push('Memory tier', 'FAIL', `memory.backend is "graph" but FalkorDB is not reachable at ${report.falkordb.host}:${report.falkordb.port}`, `${report.falkordb.start}   (or set memory.backend: "flat")`);
    else if (backend === 'graph' && !embed) push('Memory tier', 'FAIL', 'memory.backend is "graph" but memory.embeddingModel is "none" — the graph needs vectors', 'set memory.embeddingModel (ollama pull qwen3-embedding:4b) or memory.backend: "flat"');
    else if (backend === 'vault' || backend === 'flat') push('Memory tier', 'PASS', `${backend}${okfEnabled(config) ? ' + OKF' : ''}${embed ? '' : ', no embedder'}`);
    else push('Memory tier', 'PASS', `${backend === 'auto' ? 'graph if FalkorDB answers, else flat' : backend}`);
    if (embed && embedder && report.ollama.reachable) {
      const size = report.ollama.modelSizes[embedder] ?? report.ollama.modelSizes[`${embedder}:latest`]
        ?? report.ollamaBackends.map(b => b.modelSizes[embedder]).find(Boolean);
      const fg = (config as { defaultModel?: string }).defaultModel ?? config.specialists.chat?.model;
      const fgSize = fg ? report.ollama.modelSizes[fg] ?? report.ollama.modelSizes[`${fg}:latest`] : undefined;
      const budget = report.memory.gpuVramGb ? report.memory.gpuVramGb * 0.85 : report.memory.totalGb * 0.6;
      if (size && fgSize && (size + fgSize) / 1e9 > budget) push('Embedding model fits beside the foreground', 'WARN', `${embedder} (${(size / 1e9).toFixed(1)}GB) + ${fg} (${(fgSize / 1e9).toFixed(1)}GB) > ~${budget.toFixed(0)}GB usable — Ollama will evict one for the other on every memory touch`, 'use a smaller embedder (ollama pull qwen3-embedding:0.6b) or memory.embeddingModel: "none"');
      else if (size) push('Embedding model fits beside the foreground', 'PASS', `${embedder} (${(size / 1e9).toFixed(1)}GB)`);
    }
    if (backend === 'vault') {
      const vp = config.vault.path;
      if (!existsSync(vp)) push('Vault folder', 'WARN', `${vp} does not exist yet`, `mkdir -p ${vp}   (point vault.path at your Obsidian vault to use it)`);
      else if (okfEnabled(config)) {
        const issues = checkBundle(vp);
        if (issues.length === 0) push('OKF bundle', 'PASS', `${vp} conforms (every note has a type)`);
        else push('OKF bundle', 'WARN', `${issues.length} note(s) without OKF front matter: ${issues.slice(0, 3).map(i => i.file).join(', ')}${issues.length > 3 ? '…' : ''}`, 'they are indexed as they are (§11: consumers tolerate); to add front matter in place, bodies untouched: npm run vault:okf -- --apply');
      } else push('Vault folder', 'PASS', vp);
    }
  }

  if (!report.ollama.reachable) {
    push('Ollama', 'FAIL', `not reachable at ${report.ollama.url}`, `start Ollama, or install: ${report.ollama.install}`);
  } else {
    push('Ollama', 'PASS', `${report.ollama.url} · ${report.ollama.models.length} model(s)`);
    if (config) {
      for (const m of ollamaModelsReferenced(config)) {
        if (hasModel(report.ollama.models, m)) push(`Model ${m}`, 'PASS');
        else push(`Model ${m}`, 'WARN', 'referenced in config, not present', `ollama pull ${m}`);
      }
    }
  }
  // Extra Ollama-native hosts: each is probed and checked for the models it is declared to serve.
  if (config) {
    for (const b of config.inference?.ollamaBackends ?? []) {
      const probe = report.ollamaBackends.find(x => x.url === b.url);
      if (!probe?.reachable) { push(`Ollama host ${b.url}`, 'FAIL', `not reachable — serves ${b.models.join(', ')}`, 'start Ollama on that host (or fix the URL)'); continue; }
      push(`Ollama host ${b.url}`, 'PASS', `${probe.models.length} model(s)`);
      for (const m of b.models) {
        if (hasModel(probe.models, m)) push(`Model ${m} @ ${new URL(b.url).host}`, 'PASS');
        else push(`Model ${m} @ ${new URL(b.url).host}`, 'WARN', 'declared for this host, not present there', `ollama pull ${m}   (on ${new URL(b.url).host})`);
      }
    }
  }

  if (config) {
    const web = config.channels.web as { enabled?: boolean; host?: string; token?: string; insecureOpen?: boolean; port?: number } | undefined;
    if (web?.enabled) {
      const port = web.port ?? 3100;
      if (isLoopback(web.host)) {
        push('Web console', 'PASS', `http://127.0.0.1:${port} (loopback only)`);
      } else if (web.token) {
        push('Web console', 'PASS', `${web.host ?? '0.0.0.0'}:${port}, bearer token required`);
      } else if (web.insecureOpen) {
        push('Web console', 'WARN', `${web.host}:${port} OPEN to the network with NO token (insecureOpen) — any web page on your LAN can act as you`, 'set channels.web.token ("${WEB_TOKEN}" + .env) and remove insecureOpen');
      } else {
        push('Web console', 'FAIL', `${web.host}:${port} would bind the network with no token — the adapter refuses to start`, 'set channels.web.token, or host: "127.0.0.1"');
      }
    }

    const search = config.tools?.web?.search;
    if (!search) {
      push('Web search', 'PASS', 'not configured (Tier 0) — chat and memory only');
    } else if (search.provider === 'searxng') {
      const base = search.baseUrl ?? '(no baseUrl)';
      if (report.searxng.state === 'ok') push('SearXNG', 'PASS', `${base} · JSON API on`);
      else if (report.searxng.state === 'json-disabled') push('SearXNG', 'FAIL', `${base} answers but the JSON format is off (403)`, 'searxng/settings.yml → search.formats: [html, json], then docker compose restart searxng');
      else push('SearXNG', 'FAIL', `${base} not reachable`, report.searxng.start);
      const ceiling = search.dailyQueryCeiling ?? 0;
      const maxCross = config.verification?.maxCrossChecks ?? 4;
      const perRun = 5 + 6 + maxCross;
      push('Search pacing', ceiling > 0 ? 'PASS' : 'WARN',
        `outbound 1 query / 1.5s · a research run spends up to ~${perRun} queries (+retries) · daily ceiling ${ceiling > 0 ? ceiling : 'NONE'}`,
        ceiling > 0 ? undefined : 'set tools.web.search.dailyQueryCeiling (e.g. 250) — a metasearch spends YOUR IP\'s reputation with every engine it fans out to (SEARXNG.md)');
      if (existsSync('searxng/settings.yml') && readFileSync('searxng/settings.yml', 'utf-8').includes('REPLACE-ME')) {
        push('SearXNG secret', 'WARN', 'searxng/settings.yml still has the placeholder secret_key', 'openssl rand -hex 32 → server.secret_key');
      }
    } else {
      const envVar = `${search.provider.toUpperCase()}_API_KEY`;
      const key = search.apiKey || process.env[envVar];
      push(`Search (${search.provider})`, key ? 'PASS' : 'WARN', key ? 'API key present' : `no API key — set ${envVar} in .env`);
    }

    if (report.falkordb.reachable) push('Graph memory (FalkorDB)', 'PASS', `${report.falkordb.host}:${report.falkordb.port}`);
    else push('Graph memory (FalkorDB)', 'WARN', 'not reachable — memory falls back to flat files (no entity traversal / vector search)', report.docker.found ? report.falkordb.start : `needs Docker: ${report.docker.install}`);

    if (config.tools?.exec?.security === 'docker') {
      push('Docker (exec sandbox)', report.docker.found ? 'PASS' : 'FAIL', report.docker.detail, report.docker.found ? undefined : `${report.docker.install} — until then exec runs on the HOST allowlist`);
    } else {
      push('Docker', report.docker.found ? 'PASS' : 'WARN', report.docker.found ? report.docker.detail : 'not available — FalkorDB/SearXNG sidecars and the exec sandbox need it', report.docker.found ? undefined : report.docker.install);
    }
  }

  push('LibreOffice', report.libreoffice.found ? 'PASS' : 'WARN', report.libreoffice.found ? report.libreoffice.detail : 'not found — document tool and research PDFs unavailable', report.libreoffice.install);
  push('Python + matplotlib/pandas', report.python.found ? 'PASS' : 'WARN', report.python.detail, report.python.found ? undefined : `${report.python.install} — research charts and code sessions need it`);

  return c;
}

export function formatDoctor(checks: DoctorCheck[], opts: { quiet?: boolean } = {}): string {
  const lines: string[] = [];
  for (const ch of checks) {
    if (opts.quiet && ch.status === 'PASS') continue;
    const tag = ch.status === 'PASS' ? '[PASS]' : ch.status === 'WARN' ? '[WARN]' : '[FAIL]';
    lines.push(`  ${tag} ${ch.name}${ch.detail ? ` — ${ch.detail}` : ''}`);
    if (ch.fix && ch.status !== 'PASS') lines.push(`         fix: ${ch.fix}`);
  }
  const passes = checks.filter(x => x.status === 'PASS').length;
  const warns = checks.filter(x => x.status === 'WARN').length;
  const fails = checks.filter(x => x.status === 'FAIL').length;
  lines.push(`\n  ${passes} passed, ${warns} warnings, ${fails} failed`);
  return lines.join('\n');
}

export async function runDoctor(opts: { configPath?: string; quiet?: boolean; offline?: boolean } = {}): Promise<DoctorResult> {
  const configPath = opts.configPath ?? 'invarail.config.json5';
  let config: InvarailConfig | null = null;
  let configError: string | undefined;
  if (existsSync(configPath)) {
    try {
      const { loadConfig } = await import('../config/loader.js');
      config = loadConfig(configPath);
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }
  const report = await detect({
    configPath,
    offline: opts.offline,
    ollamaUrl: config?.ollama.url,
    ollamaBackendUrls: (config?.inference?.ollamaBackends ?? []).map(b => b.url),
    falkordb: config?.memory?.falkordb ? { host: config.memory.falkordb.host, port: config.memory.falkordb.port } : undefined,
    searxngUrl: config?.tools?.web?.search?.baseUrl,
  });
  const checks = doctorChecks(report, config, configError);
  return {
    checks, report,
    passes: checks.filter(x => x.status === 'PASS').length,
    warns: checks.filter(x => x.status === 'WARN').length,
    fails: checks.filter(x => x.status === 'FAIL').length,
  };
}
