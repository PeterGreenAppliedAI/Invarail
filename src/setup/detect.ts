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
import { platform, totalmem } from 'node:os';
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
  ollama: { url: string; reachable: boolean; models: string[]; modelSizes: Record<string, number>; install: string };
  /** RAM in GB; GPU VRAM in GB when nvidia-smi answers (NVIDIA only — Apple silicon is unified memory, counted as RAM). */
  memory: { totalGb: number; gpuVramGb?: number; gpuName?: string };
  /** Extra Ollama-native hosts from inference.ollamaBackends[] — probed individually. */
  ollamaBackends: Array<{ url: string; reachable: boolean; models: string[]; modelSizes: Record<string, number> }>;
  docker: Probe;
  falkordb: { host: string; port: number; reachable: boolean; start: string };
  searxng: { baseUrl: string; state: 'ok' | 'json-disabled' | 'unreachable'; start: string };
  libreoffice: Probe;
  python: Probe;
  /** Optional: the vault tier is a folder of markdown; Obsidian is the viewer people expect for it. */
  obsidian: Probe;
  /** Voice is present or absent by environment: Kokoro (TTS) and faster-whisper (STT), both
   *  OpenAI-compatible servers, probed at their usual local ports. Never asked for, never assumed. */
  voice: { tts: { url?: string; reachable: boolean; install: string }; stt: { url?: string; reachable: boolean; install: string } };
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
  /** The voice servers the config names (tts.url / stt.url). Probed FIRST — a server on a
   *  non-default port is still the one the owner configured. */
  voiceUrls?: { tts?: string; stt?: string };
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
  kokoro: {
    mac: 'docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest   (Kokoro TTS, OpenAI-compatible; GPU image: kokoro-fastapi-gpu)',
    linux: 'docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest   (Kokoro TTS, OpenAI-compatible; GPU image: kokoro-fastapi-gpu)',
    windows: 'docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest   (Kokoro TTS, OpenAI-compatible; GPU image: kokoro-fastapi-gpu)',
  },
  whisper: {
    mac: 'docker run -d -p 8000:8000 fedirz/faster-whisper-server:latest-cpu   (faster-whisper, OpenAI-compatible /v1/audio/transcriptions)',
    linux: 'docker run -d -p 8000:8000 fedirz/faster-whisper-server:latest-cuda   (faster-whisper, OpenAI-compatible /v1/audio/transcriptions)',
    windows: 'docker run -d -p 8000:8000 fedirz/faster-whisper-server:latest-cpu   (faster-whisper, OpenAI-compatible /v1/audio/transcriptions)',
  },
  obsidian: {
    mac: 'brew install --cask obsidian   (https://obsidian.md/download)',
    linux: 'flatpak install -y flathub md.obsidian.Obsidian   (or the AppImage from https://obsidian.md/download)',
    windows: 'winget install Obsidian.Obsidian   (https://obsidian.md/download)',
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

const OBSIDIAN_CANDIDATES: Record<Platform, string[]> = {
  mac: ['/Applications/Obsidian.app', `${process.env.HOME ?? ''}/Applications/Obsidian.app`],
  linux: ['/usr/bin/obsidian', '/usr/local/bin/obsidian', '/snap/bin/obsidian', `${process.env.HOME ?? ''}/.local/share/flatpak/exports/bin/md.obsidian.Obsidian`, '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian'],
  windows: [`${process.env.LOCALAPPDATA ?? ''}\\Obsidian\\Obsidian.exe`, `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Obsidian\\Obsidian.exe`],
};

/** The local ports the two voice servers usually sit on: TTS = the config default and Kokoro-FastAPI;
 *  STT = faster-whisper-server. An OpenAI-compatible server answers `/v1/models`. */
const TTS_CANDIDATES = ['http://127.0.0.1:5005', 'http://127.0.0.1:8880'];
const STT_CANDIDATES = ['http://127.0.0.1:8000'];

async function firstReachable(urls: string[]): Promise<string | undefined> {
  for (const u of urls) {
    for (const path of ['/v1/models', '/health', '/']) {
      try {
        const res = await fetch(`${u}${path}`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return u;
      } catch { /* next */ }
    }
  }
  return undefined;
}

/** A configured voice URL may carry an endpoint path (…/v1/audio/speech); probe the server's root. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

/**
 * The configured server first, then the usual ports. Only the defaults used to be tried, so a
 * configured server on another port read as absent: mlx-audio serves TTS AND STT on :8000, which
 * is in the STT list only — the doctor FAILed "no server answers at http://127.0.0.1:8000" on every
 * boot while that server answered (2026-10-01).
 */
export async function detectVoice(p: Platform = detectPlatform(), opts?: { offline?: boolean; ttsUrl?: string; sttUrl?: string }): Promise<DetectReport['voice']> {
  const candidates = (configured: string | undefined, defaults: string[]) =>
    [...new Set([originOf(configured), ...defaults].filter((u): u is string => !!u))];
  const tts = opts?.offline ? undefined : await firstReachable(candidates(opts?.ttsUrl, TTS_CANDIDATES));
  const stt = opts?.offline ? undefined : await firstReachable(candidates(opts?.sttUrl, STT_CANDIDATES));
  return {
    tts: { url: tts, reachable: !!tts, install: INSTALL_HINTS.kokoro[p] },
    stt: { url: stt, reachable: !!stt, install: INSTALL_HINTS.whisper[p] },
  };
}

/** Obsidian is optional — the vault is plain markdown — but it is what a vault-tier user opens. */
export async function detectObsidian(p: Platform = detectPlatform()): Promise<Probe> {
  for (const c of OBSIDIAN_CANDIDATES[p]) if (c && existsSync(c)) return { found: true, detail: c };
  const which = await run(p === 'windows' ? 'where' : 'which', ['obsidian']);
  if (which.ok && which.out) return { found: true, detail: which.out.split('\n')[0] };
  return { found: false, detail: 'Obsidian not found', install: INSTALL_HINTS.obsidian[p] };
}

/** The argv that installs Obsidian on this platform — for the wizard's offer (never run unasked). */
export function obsidianInstallArgs(p: Platform = detectPlatform()): { cmd: string; args: string[] } | undefined {
  if (p === 'mac') return { cmd: 'brew', args: ['install', '--cask', 'obsidian'] };
  if (p === 'windows') return { cmd: 'winget', args: ['install', 'Obsidian.Obsidian'] };
  if (p === 'linux') return { cmd: 'flatpak', args: ['install', '-y', 'flathub', 'md.obsidian.Obsidian'] };
  return undefined;
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
    if (opts.offline) return { url, reachable: false, models: [] as string[], modelSizes: {} as Record<string, number> };
    const client = new OllamaClient(url);
    const reachable = await client.isAvailable();
    let models: string[] = [];
    const modelSizes: Record<string, number> = {};
    if (reachable) { try { for (const m of await client.listModels()) { models.push(m.name); modelSizes[m.name] = m.size; } } catch { /* reachable, no list */ } }
    return { url, reachable, models, modelSizes };
  };
  const gpu = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 4000);
  const gpuLine = gpu.ok ? gpu.out.split('\n')[0] : '';
  const gpuMatch = gpuLine.match(/^(.*),\s*(\d+)\s*$/);
  const memory = {
    totalGb: Math.round(totalmem() / 1e9 * 10) / 10,
    ...(gpuMatch ? { gpuName: gpuMatch[1].trim(), gpuVramGb: Math.round(Number(gpuMatch[2]) / 1024 * 10) / 10 } : {}),
  };
  const ollamaBackends = await Promise.all((opts.ollamaBackendUrls ?? []).map(probeOllama));
  const [ollama, docker, falkorUp, searxngState, libreoffice, python, obsidian, voice] = await Promise.all([
    probeOllama(ollamaUrl),
    detectDocker(p),
    opts.offline ? Promise.resolve(false) : tcpReachable(falkor.host, falkor.port),
    opts.offline ? Promise.resolve<DetectReport['searxng']['state']>('unreachable') : detectSearxng(searxngUrl),
    detectLibreOffice(p),
    detectPython(p),
    detectObsidian(p),
    detectVoice(p, { offline: opts.offline, ttsUrl: opts.voiceUrls?.tts, sttUrl: opts.voiceUrls?.stt }),
  ]);

  return {
    platform: p,
    node: { version: process.versions.node, ok: nodeMajor >= 22 },
    ollama: { ...ollama, install: INSTALL_HINTS.ollama[p] },
    ollamaBackends,
    memory,
    docker,
    falkordb: { ...falkor, reachable: falkorUp, start: 'docker compose up -d falkordb' },
    searxng: { baseUrl: searxngUrl, state: searxngState, start: 'docker compose up -d searxng   (read docs/SEARXNG.md first)' },
    libreoffice,
    python,
    obsidian,
    voice,
    config: { path: configPath, present: existsSync(configPath) },
    env: { present: existsSync('.env') },
  };
}
