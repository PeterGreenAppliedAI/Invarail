/**
 * Wire-level format probe — re-runs the eval's failing E1-cron extraction against
 * muse-glimmer, with fetch intercepted to record whether the outgoing request body
 * actually carries the `format` schema. Prints timestamps for the gateway audit log.
 *
 * Usage: npx tsx scripts/format-probe.ts [model]   (default muse-glimmer:latest)
 * Run inside the `lab` tmux session (node LAN access).
 */
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { extractParams } from '../src/pipeline/extractor.js';
import { capsFor } from '../src/ollama/model-caps.js';
import type { ExtractFieldSchema } from '../src/pipeline/types.js';

const MODEL = process.argv[2] ?? 'muse-glimmer:latest';

const CRON_SCHEMA: Record<string, ExtractFieldSchema> = {
  schedule: { type: 'string', description: '5-field cron expression (minute hour day month weekday)', required: true },
  message: { type: 'string', description: 'What the reminder should say', required: true },
  category: { type: 'string', description: 'Which category executes the job', required: true, enum: ['web_search', 'research', 'chat', 'memory', 'exec', 'multi'] },
};
const INPUT = 'Every weekday at 7:30am remind me to stretch, just a chat message is fine';

const origFetch = globalThis.fetch;
let call = 0;
globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  call++;
  const ts = new Date().toISOString();
  let hasFormat = false, formatKeys = 'n/a', model = '?';
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      model = body.model ?? '?';
      hasFormat = body.format !== undefined && body.format !== null;
      if (hasFormat && typeof body.format === 'object') {
        formatKeys = `required=[${(body.format.required ?? []).join(',')}]`;
      }
    } catch { /* non-JSON body */ }
  }
  console.log(`[WIRE] call ${call} @ ${ts} — model=${model} url=${url} format_attached=${hasFormat ? 'YES ' + formatKeys : 'NO'}`);
  if (call === 1 && init?.body && typeof init.body === 'string') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('data/format-probe-body.json', init.body);
  }
  return origFetch(url, init);
}) as typeof fetch;

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  console.log(`Probe model: ${MODEL}`);
  console.log(`capsFor(${MODEL}).supportsFormat = ${capsFor(MODEL).supportsFormat}`);
  console.log(`START ${new Date().toISOString()}`);
  try {
    const params = await extractParams(client, MODEL, CRON_SCHEMA, INPUT);
    console.log(`RESULT: ${JSON.stringify(params)}`);
    const conforms = typeof params.schedule === 'string' && params.schedule.length > 0
      && typeof params.message === 'string' && params.message.length > 0
      && typeof params.category === 'string' && ['web_search', 'research', 'chat', 'memory', 'exec', 'multi'].includes(String(params.category));
    console.log(`VERDICT: output ${conforms ? 'CONFORMS to schema' : 'VIOLATES schema (missing/invalid required fields)'}`);
  } catch (err) {
    console.log(`EXTRACTION FAILED: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`END ${new Date().toISOString()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
