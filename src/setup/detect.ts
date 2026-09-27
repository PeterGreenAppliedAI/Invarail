/**
 * Environment detection — what is actually installed and reachable on this machine.
 *
 * One probe layer shared by the setup wizard (so it can detect instead of ask), the
 * `doctor` command (so a fresh clone gets a checklist instead of a stack trace), and
 * the console. Every probe returns found/missing plus the exact install command for
 * this OS. Probes never use a shell string — execFile with an argument array.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { platform } from 'node:os';
import { OllamaClient } from '../ollama/client.js';

export type Platform = 'mac' | 'linux' | 'windows';

export interface Probe {
  found: boolean;
  /** Human-readable version/path/state when found, reason when not. */
  detail?: string;
  /** Exact command (or URL) that installs/starts it on THIS platform. */
  install?: string;
}

export interface DetectReport {
  platform: Platform;
  node: { version: string; ok: boolean };
  ollama: { url: string; reachable: boolean; models: string[]; install: string };
  /** Extra Ollama-native hosts from inference.ollamaBackends[] — probed individually. */
  ollamaBackends: Array<{ url: string; reachable: boolean; models: string[] }>;
  docker: Probe;
  falkordb: { host: string; port: number; reachable: boolean; start: string };
  searxng: { baseUrl: string; state: 'ok' | 'json-disabled' | 'unreachable'; start: string };
  libreoffice: Probe;
  python: Probe;
  config: { path: string; present: boolean };
  env: { present: boolean };
}

export interface DetectOptions {
  ollamaUrl?: string;
  falkordb?: { host: string; port: number };
  searxngUrl?: string;
  /** URLs of inference.ollamaBackends[] to probe. */
  ollamaBackendUrls?: string[];
  configPath?: string;
  /** Skip network probes (tests, CI without services). */
  offline?: boolean;
}

export function detectPlatform(): Platform {
  const p = platform();
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

/** Per-platform install commands. Strings shown to the user, never executed blindly. */
export const INSTALL_HINTS: Record<string, Record<Platform, string>> = {
  ollama: {
    mac: 'brew install ollama && ollama serve   (or https://ollama.com/download)',
    linux: 'curl -fsSL https://ollama.com/install.sh | sh',
    windows: 'winget install Ollama.Ollama   (or https://ollama.com/download)',
  },
  docker: {
    mac: 'brew install --cask docker, then open Docker.app   (https://docs.docker.com/desktop/setup/install/mac-install/)',
    linux: 'https://docs.docker.com/engine/install/  (then: sudo usermod -aG docker $USER)',
    windows: 'winget install Docker.DockerDesktop   (https://docs.docker.com/desktop/setup/install/windows-install/)',
  },
  libreoffice: {
    mac: 'brew install --cask libreoffice',
    linux: 'sudo apt install libreoffice   (or your distro\'s package)',
    windows: 'winget install TheDocumentFoundation.LibreOffice',
  },
  python: {
    mac: 'python3 -m pip install matplotlib pandas   (python3 via brew install python)',
    linux: 'python3 -m pip install matplotlib pandas   (or apt install python3-matplotlib python3-pandas)',
    windows: 'py -m pip install matplotlib pandas   (python via winget install Python.Python.3.12)',
  },
};

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host, port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const SOFFICE_CANDIDATES: Record<Platform, string[]> = {
  mac: ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  linux: ['/usr/bin/soffice', '/usr/bin/libreoffice', '/snap/bin/libreoffice'],
  windows: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe'],
};

export async function detectLibreOffice(p: Platform = detectPlatform()): Promise<Probe> {
  if (process.env.SOFFICE_PATH && existsSync(process.env.SOFFICE_PATH)) {
    return { found: true, detail: process.env.SOFFICE_PATH };
  }
  for (const c of SOFFICE_CANDIDATES[p]) if (existsSync(c)) return { found: true, detail: c };
  const which = await run(p === 'windows' ? 'where' : 'which', ['soffice']);
  if (which.ok && which.out) return { found: true, detail: which.out.split('\n')[0] };
  return { found: false, detail: 'soffice not found', install: INSTALL_HINTS.libreoffice[p] };
}

export async function detectPython(p: Platform = detectPlatform()): Promise<Probe> {
  const bins = p === 'windows' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const bin of bins) {
    const ver = await run(bin, ['--version']);
    if (!ver.ok) continue;
    const libs = await run(bin, ['-c', 'import matplotlib, pandas; print(matplotlib.__version__, pandas.__version__)']);
    if (libs.ok) return { found: true, detail: `${ver.out} · matplotlib/pandas ${libs.out}` };
    return { found: false, detail: `${ver.out} found, matplotlib/pandas missing`, install: INSTALL_HINTS.python[p] };
  }
  return { found: false, detail: 'python not found', install: INSTALL_HINTS.python[p] };
}

export async function detectDocker(p: Platform = detectPlatform()): Promise<Probe> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], 6000);
  if (r.ok && r.out) return { found: true, detail: `server ${r.out}` };
  const client = await run('docker', ['--version'], 4000);
  if (client.ok) return { found: false, detail: 'docker CLI present but the daemon is not running — start Docker', install: INSTALL_HINTS.docker[p] };
  return { found: false, detail: 'docker not found', install: INSTALL_HINTS.docker[p] };
}

export async function detectSearxng(baseUrl: string): Promise<DetectReport['searxng']['state']> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/search?q=invarail&format=json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Invarail/doctor' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 403) return 'json-disabled';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export async function detect(opts: DetectOptions = {}): Promise<DetectReport> {
  const p = detectPlatform();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const falkor = opts.falkordb ?? { host: 'localhost', port: 6379 };
  const searxngUrl = opts.searxngUrl ?? 'http://localhost:8080';
  const configPath = opts.configPath ?? 'invarail.config.json5';

  const probeOllama = async (url: string) => {
    if (opts.offline) return { url, reachable: false, models: [] as string[] };
    const client = new OllamaClient(url);
    const reachable = await client.isAvailable();
    let models: string[] = [];
    if (reachable) { try { models = (await client.listModels()).map(m => m.name); } catch { /* reachable, no list */ } }
    return { url, reachable, models };
  };
  const ollamaBackends = await Promise.all((opts.ollamaBackendUrls ?? []).map(probeOllama));
  const [ollama, docker, falkorUp, searxngState, libreoffice, python] = await Promise.all([
    opts.offline ? Promise.resolve({ reachable: false, models: [] as string[] }) : (async () => {
      const client = new OllamaClient(ollamaUrl);
      const reachable = await client.isAvailable();
      let models: string[] = [];
      if (reachable) { try { models = (await client.listModels()).map(m => m.name); } catch { /* reachable, no list */ } }
      return { reachable, models };
    })(),
    detectDocker(p),
    opts.offline ? Promise.resolve(false) : tcpReachable(falkor.host, falkor.port),
    opts.offline ? Promise.resolve<DetectReport['searxng']['state']>('unreachable') : detectSearxng(searxngUrl),
    detectLibreOffice(p),
    detectPython(p),
  ]);

  return {
    platform: p,
    node: { version: process.versions.node, ok: nodeMajor >= 22 },
    ollama: { url: ollamaUrl, ...ollama, install: INSTALL_HINTS.ollama[p] },
    ollamaBackends,
    docker,
    falkordb: { ...falkor, reachable: falkorUp, start: 'docker compose up -d falkordb' },
    searxng: { baseUrl: searxngUrl, state: searxngState, start: 'docker compose up -d searxng   (read SEARXNG.md first)' },
    libreoffice,
    python,
    config: { path: configPath, present: existsSync(configPath) },
    env: { present: existsSync('.env') },
  };
}
