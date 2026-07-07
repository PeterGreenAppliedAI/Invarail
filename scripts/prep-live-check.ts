/**
 * Live prep-proposal check — runs the briefing's prep assessment against a
 * REAL model with a synthetic calendar, materializes proposals into a TEMP
 * ledger, then confirms one through the real handleConfirmation() with a stub
 * executor. End-to-end proof of the propose → confirm loop, no app boot, no
 * real cron jobs created.
 *
 * Usage (inside tmux lab): npx tsx scripts/prep-live-check.ts [model]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { buildPrepSection } from '../src/services/prep-proposals.js';
import { handleConfirmation } from '../src/security/confirm-handler.js';
import { PendingActionStore } from '../src/security/pending-actions.js';
import type { ToolRegistry } from '../src/tools/types.js';

const MODEL = process.argv[2] ?? '';

function fakeCalendar(now: Date): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const day = tomorrow.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return [
    `- **Meeting w/ John** [TOMORROW] ${day} 2:00 PM – 3:00 PM`,
    `- **Q3 budget review** [TOMORROW] ${day} 9:00 AM – 10:00 AM (bring updated numbers)`,
    `- **Dentist** [TODAY] 5:30 PM – 6:00 PM`,
  ].join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const store = new PendingActionStore(join(mkdtempSync(join(tmpdir(), 'prep-live-')), 'pending.json'));
  const now = new Date();

  const model = MODEL || config.briefing.model;
  console.log(`=== prep assessment on REAL ${model} ===`);
  const section = await buildPrepSection({
    client,
    model,
    calendar: fakeCalendar(now),
    memory: 'The user is a solo founder; mornings are for deep work; he tends to under-prepare for budget meetings.',
    sender: 'peter',
    channel: 'livecheck',
    target: 'livecheck',
    agentId: 'main',
    timeZone: config.timezone,
    store,
    now,
  });

  console.log(`\n--- briefing prep section ---\n${section || '(empty — model proposed nothing or output unparseable)'}\n`);
  const open = store.listFor('peter');
  console.log(`ledger entries: ${open.length}`);
  for (const p of open) console.log(`  ${p.id} → ${p.tool} ${JSON.stringify(p.params).slice(0, 140)}`);

  if (open.length === 0) {
    console.log('\nVERDICT: model produced no materializable proposals — inspect section above.');
    process.exit(0);
  }

  // Confirm the first proposal through the REAL unified handler, stub executor
  const stubRegistry = {
    createScopedExecutor: () => async (tool: string, params: Record<string, unknown>) =>
      `STUB-EXECUTED ${tool}(${JSON.stringify(params).slice(0, 100)})`,
  } as unknown as ToolRegistry;

  const outcome = await handleConfirmation({
    message: `confirm ${open[0].id}`,
    senderId: '6555481980', // Telegram alias — proves principal binding end-to-end
    channel: 'livecheck',
    config,
    toolRegistry: stubRegistry as any,
    store,
  });

  console.log(`\n--- confirm via Telegram alias ---`);
  console.log(`handled: ${outcome.handled}`);
  console.log(`reply:   ${outcome.reply}`);
  console.log(`remaining entries: ${store.listFor('peter').length}`);
  const ok = outcome.handled && outcome.reply?.includes('STUB-EXECUTED');
  console.log(`\nVERDICT: ${ok ? 'PASS — propose → alias-confirm → stored-params execution all live' : 'FAIL — inspect above'}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Live check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
