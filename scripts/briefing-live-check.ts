/**
 * REAL briefing run — no app boot, no channel connections.
 *
 * Calls runBriefing() with: real config, real tool registry (real Google
 * Calendar OAuth, real memory/FalkorDB), real DeepSeek, real task store, real
 * pending-action ledger, real session transcript append. The ONLY stub is the
 * channel registry: the briefing prints here instead of delivering to
 * Telegram/Discord. This is the production code path end-to-end.
 *
 * Side effects (intentionally real): prep proposals land in the live ledger
 * (12h TTL — confirmable from any channel later), and the briefing turn is
 * appended to the owner's session transcript.
 *
 * Usage (inside tmux lab): npx tsx scripts/briefing-live-check.ts
 */
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerAllTools } from '../src/tools/register-all.js';
import { runBriefing } from '../src/services/briefing-service.js';
import { SessionStore } from '../src/sessions/store.js';
import { TaskStore } from '../src/tasks/store.js';
import { FactStore } from '../src/memory/fact-store.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';
import { resolveWorkspacePath } from '../src/agents/scope.js';
import type { ChannelRegistry } from '../src/channels/registry.js';

async function main(): Promise<void> {
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const workspacePath = resolveWorkspacePath(config.agents.default, config);

  const factStore = new FactStore(workspacePath, client);
  const graphMemory = new GraphMemoryStore(client, { nerModel: config.memory?.nerModel });
  try {
    await graphMemory.connect();
  } catch (err) {
    console.warn('FalkorDB unavailable — briefing will use flat store:', err instanceof Error ? err.message : err);
  }
  const taskStore = new TaskStore(
    join(workspacePath, 'tasks.json'),
    join(workspacePath, 'TASKS.md'),
  );
  const sessionStore = new SessionStore(config.session.transcriptDir);

  const registry = new ToolRegistry();
  await registerAllTools(registry, config, {
    ollamaClient: client,
    factStore,
    graphMemory,
    taskStore,
    heartbeatConfig: config.heartbeat,
  });

  // The one stub: print instead of deliver
  const printRegistry = {
    send: async (target: unknown, content: { text?: string }) => {
      console.log('\n════════ BRIEFING (would deliver to', JSON.stringify(target), ') ════════\n');
      console.log(content.text ?? '(no text)');
      console.log('\n════════ END BRIEFING ════════');
    },
  } as unknown as ChannelRegistry;

  console.log(`Running REAL briefing (model=${config.briefing.model}, tz=${config.timezone})...`);
  await runBriefing({
    config,
    client,
    toolRegistry: registry,
    channelRegistry: printRegistry,
    factStore,
    taskStore,
    sessionStore,
  });

  console.log('\nDone. Any prep proposals above are in the LIVE ledger (12h TTL) — confirm or ignore.');
  process.exit(0);
}

main().catch(err => {
  console.error('Briefing live check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
