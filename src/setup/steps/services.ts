import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { askText, askYesNo, askChoice, printStep, printSuccess, printWarning, printInfo, printError } from '../prompts.js';
import { testHttpEndpoint, testDocker, installFalkorDB, composeUp } from '../connectivity.js';
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

  // TTS
  if (await askYesNo('Enable Text-to-Speech (TTS)?', false)) {
    result.tts.enabled = true;
    result.tts.url = await askText('TTS server URL', 'http://127.0.0.1:5005');
    printInfo(`Testing TTS at ${result.tts.url}...`);
    const ok = await testHttpEndpoint(result.tts.url);
    if (ok) {
      printSuccess('TTS server is reachable');
    } else {
      printWarning('TTS server not reachable — make sure it is running before starting Invarail');
    }
  }

  // STT
  if (await askYesNo('Enable Speech-to-Text (STT)?', false)) {
    result.stt.enabled = true;
    result.stt.url = await askText('STT server URL', 'http://127.0.0.1:8000');
    printInfo(`Testing STT at ${result.stt.url}...`);
    const ok = await testHttpEndpoint(result.stt.url);
    if (ok) {
      printSuccess('STT server is reachable');
    } else {
      printWarning('STT server not reachable — make sure it is running before starting Invarail');
    }
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

  // Graph Memory (FalkorDB) — detected, not asked, when it is already running.
  if (report?.falkordb.reachable) {
    result.graphMemory.enabled = true;
    printSuccess(`Graph memory: FalkorDB is running on ${report.falkordb.host}:${report.falkordb.port}`);
  } else if (!dockerFound) {
    printInfo('Graph memory (FalkorDB) needs Docker — memory uses flat files until then; it upgrades in place later.');
  } else if (await askYesNo('Start graph memory (FalkorDB in Docker — entity graph + vector search; flat files otherwise)?', true)) {
    printInfo('docker compose up -d falkordb ...');
    if (installFalkorDB()) {
      result.graphMemory.enabled = true;
      printSuccess('FalkorDB running on port 6379');
    } else {
      printError('docker compose failed — start it yourself: docker compose up -d falkordb');
      result.graphMemory.enabled = true; // config is right; the container just needs to come up
    }
  }

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
      result.heartbeat.target = await askText('Channel/user ID for heartbeat delivery');
      printSuccess(`Heartbeat → ${result.heartbeat.channel} (${result.heartbeat.target})`);
    } else {
      printWarning('No channels enabled — heartbeat will run but cannot deliver reports');
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
