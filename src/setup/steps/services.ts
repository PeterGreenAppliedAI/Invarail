import { randomBytes } from 'node:crypto';
import { convertVaultToOkf } from '../../knowledge/okf.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { askText, askYesNo, askChoice, printStep, printSuccess, printWarning, printInfo, printError } from '../prompts.js';
import { testDocker, installFalkorDB, composeUp, runInstallArgs } from '../connectivity.js';
import { obsidianInstallArgs } from '../detect.js';
import { findVisionModels, findReasoningModels } from '../defaults.js';
import { detectSearxng, type DetectReport } from '../detect.js';
import type { OllamaModel } from '../../ollama/types.js';

export const SEARXNG_WARNING = [
  'SearXNG is a metasearch proxy: every query is forwarded to Google, Bing, DuckDuckGo, Brave',
  'and others FROM YOUR IP ADDRESS. Engines rate-limit and CAPTCHA-flag IPs that search faster',
  'than a human, and an agent researching a topic sends bursts. Two days of research traffic',
  'earned this project a DuckDuckGo CAPTCHA flag and Brave/Wikidata suspensions.',
  'Invarail paces itself (1 query / 1.5s) and caps volume (250 queries/day, in config), and',
  'the shipped searxng/settings.yml is a conservative SUGGESTED profile. Keep the instance',
  'private, point nothing else at it, and read SEARXNG.md — it explains what being flagged',
  'looks like and the alternatives that do not spend your IP (a hosted key, the local index).',
].join('\n  ');

/** Put a real secret into the shipped settings.yml if it still carries the placeholder. */
export function ensureSearxngSecret(path = 'searxng/settings.yml'): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf-8');
  if (!text.includes('secret_key: "REPLACE-ME"')) return false;
  writeFileSync(path, text.replace('secret_key: "REPLACE-ME"', `secret_key: "${randomBytes(32).toString('hex')}"`));
  return true;
}

export interface WebSearchResult {
  enabled: boolean;
  provider?: 'searxng' | 'brave' | 'perplexity' | 'grok' | 'tavily';
  apiKey?: string;
  /** searxng only */
  baseUrl?: string;
  /** Outbound queries per day, all providers. The wizard writes 250. */
  dailyQueryCeiling?: number;
}

export interface TTSResult {
  enabled: boolean;
  url?: string;
}

export interface STTResult {
  enabled: boolean;
  url?: string;
}

export interface VisionResult {
  enabled: boolean;
  model?: string;
}

export interface BrowserResult {
  enabled: boolean;
  headless: boolean;
}

export interface ExecResult {
  security: 'allowlist' | 'docker';
}

export interface GraphMemoryResult {
  enabled: boolean;
}

/** The memory tier the generated config carries (src/memory/policy.ts). */
export interface MemoryTierResult {
  backend: 'graph' | 'flat' | 'vault';
  /** Embedding model tag, or 'none' — an 8GB card cannot hold an 8B embedder beside its chat model. */
  embeddingModel: string;
  vaultPath?: string;
  okf?: boolean;
}

export interface HeartbeatResult {
  enabled: boolean;
  channel?: string;
  target?: string;
}

export interface ReasoningResult {
  enabled: boolean;
  model?: string;
}

export interface ImageGenResult {
  enabled: boolean;
  url?: string;
  model?: string;
}

export interface PiResult {
  enabled: boolean;
  model?: string;
}

export interface ServicesStepResult {
  webSearch: WebSearchResult;
  tts: TTSResult;
  stt: STTResult;
  vision: VisionResult;
  browser: BrowserResult;
  exec: ExecResult;
  graphMemory: GraphMemoryResult;
  memory: MemoryTierResult;
  heartbeat: HeartbeatResult;
  reasoning: ReasoningResult;
  imageGen: ImageGenResult;
  pi: PiResult;
}

export async function runServicesStep(models: OllamaModel[], enabledChannels: string[], report?: DetectReport): Promise<ServicesStepResult> {
  printStep(4, 7, 'Services & Features');
  const dockerFound = report ? report.docker.found : await testDocker();

  const result: ServicesStepResult = {
    webSearch: { enabled: false },
    tts: { enabled: false },
    stt: { enabled: false },
    vision: { enabled: false },
    browser: { enabled: false, headless: true },
    exec: { security: 'allowlist' },
    graphMemory: { enabled: false },
    memory: { backend: 'flat', embeddingModel: 'none' },
    heartbeat: { enabled: false },
    reasoning: { enabled: false },
    imageGen: { enabled: false },
    pi: { enabled: false },
  };

  // Web Search — SearXNG (self-hosted, no key) is offered first when Docker can run it,
  // behind an explicit-consent warning; hosted providers spend THEIR reputation instead.
  if (await askYesNo('Enable Web Search?', false)) {
    const searxngLabel = 'searxng (self-hosted, no API key — needs Docker; spends YOUR IP\'s reputation)';
    const choices = dockerFound ? [searxngLabel, 'brave', 'perplexity', 'grok', 'tavily'] : ['brave', 'perplexity', 'grok', 'tavily'];
    const chosen = await askChoice('Search provider:', choices);
    const provider = chosen.startsWith('searxng') ? 'searxng' : chosen;
    if (provider === 'searxng') {
      printWarning('Before you choose SearXNG:');
      printInfo(SEARXNG_WARNING);
      if (!await askYesNo('I have read this and want to run SearXNG', false)) {
        printInfo('Skipping web search — pick a hosted provider later under tools.web.search, or enable the local index.');
      } else {
        result.webSearch.enabled = true;
        result.webSearch.provider = 'searxng';
        result.webSearch.baseUrl = 'http://localhost:8080';
        result.webSearch.dailyQueryCeiling = 250;
        const state = report && !report.searxng.state.includes('unreachable') ? report.searxng.state : await detectSearxng(result.webSearch.baseUrl);
        if (state === 'ok') {
          printSuccess('SearXNG is already running with the JSON API on');
        } else if (state === 'json-disabled') {
          printWarning('SearXNG is running but its JSON API is off — searxng/settings.yml has it on; docker compose restart searxng');
        } else if (await askYesNo('Start SearXNG now (docker compose up -d searxng, with the suggested settings)?', true)) {
          if (ensureSearxngSecret()) printInfo('Wrote a random secret_key into searxng/settings.yml');
          if (composeUp('searxng')) printSuccess('SearXNG started on http://localhost:8080');
          else printError('docker compose failed — start it yourself: docker compose up -d searxng');
        } else {
          printInfo('Start it when ready: docker compose up -d searxng');
        }
      }
    } else {
      result.webSearch.enabled = true;
      result.webSearch.provider = provider as WebSearchResult['provider'];
      result.webSearch.apiKey = await askText(`${provider} API key`);
      result.webSearch.dailyQueryCeiling = 250;
      printSuccess(`Web search: ${provider}`);
    }
  }

  // Voice — present or absent by environment, never asked for. Kokoro (TTS) and
  // faster-whisper (STT) are the supported stack; both are OpenAI-compatible servers.
  if (report?.voice.tts.reachable && report.voice.tts.url) {
    result.tts.enabled = true;
    result.tts.url = report.voice.tts.url;
    printSuccess(`Text-to-speech: server found at ${result.tts.url} (Kokoro-compatible)`);
  } else {
    printInfo(`Text-to-speech: no server found — voice replies off. Kokoro is the supported TTS: ${report?.voice.tts.install ?? 'see INSTALL.md'}`);
  }
  if (report?.voice.stt.reachable && report.voice.stt.url) {
    result.stt.enabled = true;
    result.stt.url = report.voice.stt.url;
    printSuccess(`Speech-to-text: server found at ${result.stt.url} (faster-whisper-compatible)`);
  } else {
    printInfo(`Speech-to-text: no server found — voice input off. faster-whisper is the supported STT: ${report?.voice.stt.install ?? 'see INSTALL.md'}`);
  }

  // Vision
  if (await askYesNo('Enable Vision?', false)) {
    result.vision.enabled = true;
    const visionModels = findVisionModels(models);
    if (visionModels.length > 0) {
      printInfo('Vision-capable models found:');
      for (const m of visionModels) {
        printInfo(`  - ${m.name}`);
      }
      result.vision.model = await askText('Vision model', visionModels[0].name);
    } else {
      printInfo('No vision models found in Ollama. You can pull one: ollama pull qwen3-vl:8b');
      result.vision.model = await askText('Vision model', 'qwen3-vl:8b');
    }
    printSuccess(`Vision model: ${result.vision.model}`);
  }

  // Browser
  if (await askYesNo('Enable Browser tool?', false)) {
    result.browser.enabled = true;
    result.browser.headless = await askYesNo('Run browser headless?', true);
    printSuccess(`Browser: enabled (headless: ${result.browser.headless})`);
  }

  // Exec security — the sandbox is only offered when Docker can actually provide it.
  if (dockerFound) {
    const execChoice = await askChoice('Code execution security:', ['docker (sandboxed — recommended)', 'allowlist (host commands)']);
    result.exec.security = execChoice.startsWith('docker') ? 'docker' : 'allowlist';
  } else {
    result.exec.security = 'allowlist';
    printInfo(`Exec sandbox needs Docker (${report?.docker.install ?? 'https://docs.docker.com/get-docker/'}) — using the host allowlist until then.`);
  }
  printSuccess(`Exec security: ${result.exec.security}`);

  // Memory tier — four ways to remember, for machines that are not the reference box.
  // Detect first: FalkorDB running, Docker present, an embedding model pulled, memory budget.
  const embedders = (report?.ollama.models ?? []).filter(m => /embed/i.test(m));
  const smallBox = (report?.memory.gpuVramGb ?? report?.memory.totalGb ?? 0) > 0
    && (report!.memory.gpuVramGb ? report!.memory.gpuVramGb < 16 : report!.memory.totalGb < 16);
  const graphPossible = !!report?.falkordb.reachable || dockerFound;
  const tiers = [
    `graph — FalkorDB entity graph + vector search${report?.falkordb.reachable ? ' (FalkorDB is running)' : dockerFound ? ' (starts FalkorDB in Docker)' : ' (needs Docker — not available)'}; needs an embedding model`,
    'flat — facts in JSONL files, keyword recall; no sidecar, no embedder (works on anything)',
    'vault — flat facts + your markdown folder (edit it in Obsidian), exact-word search over your notes; no embedder',
    'vault + OKF — the vault as an Open Knowledge Format bundle: facts mirrored as notes with provenance, index.md per folder the model navigates, log.md history',
  ];
  const defaultTier = report?.falkordb.reachable && embedders.length ? 0 : smallBox ? 1 : graphPossible && !smallBox ? 0 : 1;
  printInfo(`Memory: ${report?.falkordb.reachable ? 'FalkorDB running' : 'no FalkorDB'}; ${embedders.length ? `embedding models pulled: ${embedders.join(', ')}` : 'no embedding model pulled'}${smallBox ? '; this box is under 16GB — the 8B embedder would not fit beside the chat model' : ''}`);
  const ordered = [tiers[defaultTier], ...tiers.filter((_, i) => i !== defaultTier)];
  const chosen = await askChoice('How should Invarail remember?', ordered);
  const tierIndex = tiers.indexOf(chosen);
  if (tierIndex === 0) {
    result.memory.backend = 'graph';
    if (!report?.falkordb.reachable) {
      if (dockerFound) {
        printInfo('docker compose up -d falkordb ...');
        if (installFalkorDB()) printSuccess('FalkorDB running on port 6379');
        else printError('docker compose failed — start it yourself: docker compose up -d falkordb');
      } else {
        printWarning('FalkorDB needs Docker — the config will say graph; `npm run doctor` will FAIL until it is up.');
      }
    }
    result.graphMemory.enabled = true;
  } else {
    result.memory.backend = tierIndex === 1 ? 'flat' : 'vault';
    if (tierIndex >= 2) {
      result.memory.vaultPath = await askText('Vault folder (your Obsidian vault, or a new folder)', 'vault');
      result.memory.okf = tierIndex === 3;
      // The folder is just markdown: create it if it is new (not an install, no question).
      if (!existsSync(result.memory.vaultPath)) {
        mkdirSync(result.memory.vaultPath, { recursive: true });
        printSuccess(`Created ${result.memory.vaultPath}`);
      }
      // Obsidian is the viewer people expect for it — optional, detected, offered, never silently installed.
      if (report?.obsidian.found) {
        printSuccess(`Obsidian: ${report.obsidian.detail}`);
      } else if (report) {
        printInfo(`Obsidian is not installed — the vault works with any editor; Obsidian is the nicest way to read and edit it.`);
        const cmd = obsidianInstallArgs(report.platform);
        if (cmd && await askYesNo(`Install Obsidian now (${cmd.cmd} ${cmd.args.join(' ')})?`, false)) {
          if (runInstallArgs(cmd.cmd, cmd.args)) printSuccess('Obsidian installed');
          else printError(`Install failed — do it yourself: ${report.obsidian.install}`);
        } else {
          printInfo(`Later: ${report.obsidian.install}`);
        }
      }
      printInfo(`When setup finishes: open Obsidian → "Open folder as vault" → ${result.memory.vaultPath}. The indexes, log and fact notes Invarail writes appear there as ordinary notes with properties.`);
      if (result.memory.okf && result.memory.vaultPath && existsSync(result.memory.vaultPath)) {
        const pending = convertVaultToOkf(result.memory.vaultPath, { apply: false }).candidates;
        if (pending.length > 0) {
          printInfo(`${pending.length} existing note(s) in ${result.memory.vaultPath} have no OKF front matter. They are indexed and listed as they are either way.`);
          if (await askYesNo(`Add front matter to them now (type: Note, title, a one-line description read off the first paragraph — bodies untouched)?`, false)) {
            const done = convertVaultToOkf(result.memory.vaultPath, { apply: true }).converted;
            printSuccess(`Front matter added to ${done.length} note(s)`);
          } else {
            printInfo('Later: npm run vault:okf -- --apply');
          }
        }
      }
    }
  }
  // The embedder is a separate decision: graph requires one; the others are better with one and fine without.
  if (result.memory.backend === 'graph') {
    result.memory.embeddingModel = embedders[0] ?? await askText('Embedding model (pull it: ollama pull qwen3-embedding:4b)', smallBox ? 'qwen3-embedding:0.6b' : 'qwen3-embedding:8b');
  } else if (embedders.length && await askYesNo(`Use ${embedders[0]} for semantic search too (it takes GPU memory beside the chat model)?`, !smallBox)) {
    result.memory.embeddingModel = embedders[0];
  } else {
    result.memory.embeddingModel = 'none';
  }
  printSuccess(`Memory: ${result.memory.backend}${result.memory.okf ? ' + OKF' : ''}${result.memory.vaultPath ? ` at ${result.memory.vaultPath}` : ''}, embeddings: ${result.memory.embeddingModel}`);

  // Detected-only capabilities: nothing to ask, just say what will and won't work.
  if (report) {
    if (report.libreoffice.found) printSuccess(`Documents / research PDFs: LibreOffice at ${report.libreoffice.detail}`);
    else printInfo(`Documents / research PDFs need LibreOffice — ${report.libreoffice.install}`);
    if (report.python.found) printSuccess(`Research charts: ${report.python.detail}`);
    else printInfo(`Research charts need Python + matplotlib/pandas — ${report.python.install}`);
  }

  // Heartbeat
  if (await askYesNo('Enable autonomous heartbeat? (memory review, task management every 2 hours)', true)) {
    result.heartbeat.enabled = true;
    if (enabledChannels.length > 0) {
      if (enabledChannels.length === 1) {
        result.heartbeat.channel = enabledChannels[0];
      } else {
        result.heartbeat.channel = await askChoice('Deliver heartbeat reports to:', enabledChannels);
      }
      result.heartbeat.target = await askText('Channel/user ID for heartbeat delivery (required — where the 2-hourly report goes)');
      if (!result.heartbeat.target) {
        // A heartbeat with nowhere to deliver is a config the loader rejects (delivery.target is
        // required). Leave it off rather than write an invalid file — the Windows wizard smoke
        // caught exactly this on its first run (2026-09-28).
        result.heartbeat.enabled = false;
        printWarning('No delivery target given — heartbeat left DISABLED. Enable it later: heartbeat: { enabled: true, delivery: { channel, target } }');
      } else {
        printSuccess(`Heartbeat → ${result.heartbeat.channel} (${result.heartbeat.target})`);
      }
    } else {
      result.heartbeat.enabled = false;
      printWarning('No channels enabled — heartbeat left DISABLED (it needs a channel to deliver reports to)');
    }
  }

  // Reasoning model
  const reasoningModels = findReasoningModels(models);
  if (reasoningModels.length > 0) {
    printInfo('Reasoning-capable models found:');
    for (const m of reasoningModels) {
      printInfo(`  - ${m.name}`);
    }
    if (await askYesNo('Enable reasoning model for deep analysis?', true)) {
      result.reasoning.enabled = true;
      result.reasoning.model = await askText('Reasoning model', reasoningModels[0].name);
      printSuccess(`Reasoning model: ${result.reasoning.model}`);
    }
  } else if (await askYesNo('Enable reasoning model? (none auto-detected)', false)) {
    result.reasoning.enabled = true;
    result.reasoning.model = await askText('Reasoning model name');
    printSuccess(`Reasoning model: ${result.reasoning.model}`);
  }

  // Image generation
  if (await askYesNo('Enable image generation?', false)) {
    result.imageGen.enabled = true;
    result.imageGen.url = await askText('Image generation server URL');
    result.imageGen.model = await askText('Image generation model', 'flux2-klein:4b-fp8');
    printSuccess(`Image gen: ${result.imageGen.model} at ${result.imageGen.url}`);
  }

  // Pi coding agent (picoder) — headless, bundled as an npm dependency (no separate install).
  if (await askYesNo('Enable the Pi coding agent (code generation)?', false)) {
    result.pi.enabled = true;
    result.pi.model = await askText('Pi model (provider/id from ~/.pi/agent/models.json)', 'vllm/deepseek-v4-flash');
    printSuccess(`Pi enabled: ${result.pi.model}`);
    printInfo('Configure the model provider in ~/.pi/agent/models.json (Ollama/vLLM OpenAI-compatible endpoint).');
  }

  return result;
}
