import { createInterface } from 'node:readline';
import { loadConfig } from './config/loader.js';
import { OllamaClient } from './ollama/client.js';
import { createInferenceClient } from './ollama/multi-backend.js';
import { ToolRegistry } from './tools/registry.js';
import { dispatchMessage } from './dispatch.js';
import { Orchestrator } from './orchestrator.js';
import { registerAllTools } from './tools/register-all.js';
import type { OllamaMessage } from './ollama/types.js';

// TLS safety: only disable cert verification if explicitly opted in.
// LEGACY_UNSAFE_TLS_VAR is a TEMPORARY migration shim (see DECISIONS for removal).
const LEGACY_UNSAFE_TLS_VAR = 'LOCAL' + 'CLAW_UNSAFE_TLS';
if (process.env.INVARAIL_UNSAFE_TLS === '1' || process.env[LEGACY_UNSAFE_TLS_VAR] === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (process.env[LEGACY_UNSAFE_TLS_VAR] === '1' && process.env.INVARAIL_UNSAFE_TLS !== '1') {
    console.warn(`[Invarail] DEPRECATED: ${LEGACY_UNSAFE_TLS_VAR} — use INVARAIL_UNSAFE_TLS=1`);
  }
  console.warn('[Invarail] WARNING: TLS verification disabled (INVARAIL_UNSAFE_TLS=1). Do NOT use in production.');
} else if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  // Block accidental insecure TLS — must use INVARAIL_UNSAFE_TLS instead
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  console.warn('[Invarail] Removed NODE_TLS_REJECT_UNAUTHORIZED=0. Use INVARAIL_UNSAFE_TLS=1 if you need insecure TLS, or set NODE_EXTRA_CA_CERTS for custom CAs.');
}

// Process-level safety net: a long-running personal agent must not die to a
// stray rejection from a flaky dependency (FalkorDB socket drop killed the
// process July 14; Baileys disconnects have done the same). Log LOUDLY and
// keep running — every known-fatal path already has its own handling, and
// masking is mitigated by the prominent log lines.
process.on('unhandledRejection', (reason) => {
  console.error('[Invarail] UNHANDLED REJECTION (process continues):', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Invarail] UNCAUGHT EXCEPTION (process continues):', err.stack ?? err.message);
});

async function main() {
  const config = loadConfig();

  const hasChannels = Object.values(config.channels).some(c => c.enabled);

  if (hasChannels) {
    await runOrchestrator(config);
  } else {
    await runRepl(config);
  }
}

async function runOrchestrator(config: ReturnType<typeof loadConfig>) {
  const orchestrator = new Orchestrator(config);

  // Register channel adapters (dynamic imports to avoid hard deps)
  const channelRegistry = orchestrator.getChannelRegistry();

  for (const channelId of Object.keys(config.channels)) {
    if (!config.channels[channelId]?.enabled) continue;

    try {
      switch (channelId) {
        case 'discord': {
          const { DiscordAdapter } = await import('./channels/discord/index.js');
          channelRegistry.register(new DiscordAdapter());
          break;
        }
        case 'telegram': {
          const { TelegramAdapter } = await import('./channels/telegram/index.js');
          channelRegistry.register(new TelegramAdapter());
          break;
        }
        case 'web': {
          const { WebApiAdapter } = await import('./channels/web/adapter.js');
          channelRegistry.register(new WebApiAdapter());
          break;
        }
        case 'gmail': {
          const { GmailAdapter } = await import('./channels/gmail/index.js');
          channelRegistry.register(new GmailAdapter());
          break;
        }
        default:
          console.warn(`[Invarail] Unknown channel: ${channelId}`);
      }
    } catch (err) {
      console.warn(`[Invarail] CHANNEL_CONNECT_ERROR: Failed to load ${channelId} adapter —`, err instanceof Error ? err.message : err);
    }
  }

  await orchestrator.start();

  let shuttingDown = false;
  const shutdown = async () => {
    // Second Ctrl-C while a graceful stop is in flight → exit immediately.
    if (shuttingDown) {
      console.log('\n[Invarail] Force exit.');
      process.exit(1);
    }
    shuttingDown = true;
    console.log('\n[Invarail] Shutting down... (Ctrl-C again to force)');
    // Safety net: a stuck channel disconnect (e.g. a hung socket) must never block exit.
    const forceTimer = setTimeout(() => {
      console.warn('[Invarail] Shutdown timed out after 5s — forcing exit.');
      process.exit(1);
    }, 5000);
    forceTimer.unref();
    try {
      await orchestrator.stop();
    } catch (err) {
      console.warn('[Invarail] Error during shutdown:', err instanceof Error ? err.message : err);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runRepl(config: ReturnType<typeof loadConfig>) {
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const registry = new ToolRegistry();
  const { mcpManager } = await registerAllTools(registry, config);

  const available = await client.isAvailable();
  if (!available) {
    console.error(`[Invarail] Cannot reach Ollama at ${config.ollama.url}`);
    console.error('[Invarail] Make sure Ollama is running: ollama serve');
    process.exit(1);
  }

  const models = await client.listModels();
  console.log(`[Invarail] Connected to Ollama — ${models.length} model(s) available`);
  console.log(`[Invarail] Router model: ${config.router.model}`);
  console.log(`[Invarail] Specialists: ${Object.keys(config.specialists).join(', ') || '(defaults)'}`);
  console.log(`[Invarail] Tools: ${registry.list().join(', ') || '(none)'}`);
  console.log('[Invarail] Type a message (Ctrl+C to exit)\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  const history: OllamaMessage[] = [];

  rl.prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }

    try {
      const result = await dispatchMessage({
        client,
        registry,
        config,
        message,
        history,
      });

      console.log(`\n[${result.category}/${result.classification.confidence}] (${result.iterations} step${result.iterations !== 1 ? 's' : ''})`);
      console.log(`Assistant: ${result.answer}\n`);

      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: result.answer });

      const maxTurns = config.session.maxHistoryTurns * 2;
      if (history.length > maxTurns) {
        history.splice(0, history.length - maxTurns);
      }
    } catch (err) {
      console.error(`\n[Error] ${err instanceof Error ? err.message : err}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await mcpManager?.stop();
    console.log('\n[Invarail] Goodbye!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Invarail] Fatal error:', err);
  process.exit(1);
});
