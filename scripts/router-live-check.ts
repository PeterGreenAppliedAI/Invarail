/**
 * Live router check — fires known-intent messages through classifyMessage
 * against the REAL gateway/model. Validates the enum-constrained call's
 * fallback path, the narrowed URL override, and overall routing quality.
 *
 * Usage: npx tsx scripts/router-live-check.ts [config] [--reps=N]
 * The client is built the way the app builds it, so a router model on a routed
 * backend (inference.ollamaBackends) is reached where it actually lives.
 */
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { classifyMessage } from '../src/router/classifier.js';

interface Case {
  message: string;
  /** Acceptable categories (some intents legitimately map to more than one) */
  expected: string[];
  note?: string;
}

const CASES: Case[] = [
  { message: 'hey how was your day', expected: ['chat'] },
  { message: 'what do you think about local-first AI agents', expected: ['chat'] },
  { message: 'search the web for the latest NVIDIA earnings', expected: ['web_search'] },
  { message: "what's the current price of bitcoin", expected: ['web_search'] },
  { message: 'https://example.com/article', expected: ['website'], note: 'bare URL → website override' },
  { message: 'check this out https://example.com/article', expected: ['website'], note: 'short wrapper URL → website' },
  { message: 'research the EV market in depth, start from https://example.com/report', expected: ['research', 'web_search', 'multi'], note: 'URL must NOT hijack — old code routed this to website' },
  { message: 'add a task to renew my passport', expected: ['task'] },
  { message: 'show my tasks', expected: ['task'] },
  { message: 'run ls -la in the workspace', expected: ['exec'] },
  { message: 'remind me every morning at 8am to check email', expected: ['cron'] },
  { message: 'remember that my dentist is Dr. Smith', expected: ['memory'] },
  { message: 'Remember this: my deployment freeze starts on 2026-09-01.', expected: ['memory'], note: 'a SAVE with a date in it — the 7B flipped this to cron (2026-09-29)' },
  { message: 'what did I tell you about my dentist?', expected: ['memory'] },
  { message: 'tell the family discord channel dinner is at 7', expected: ['message'] },
  { message: 'generate an image of a lighthouse at sunset', expected: ['image'] },
  { message: 'research the small-model agent landscape in depth for me', expected: ['research'] },
  { message: 'turn this analysis into a PDF report', expected: ['research', 'exec', 'multi'], note: 'the document category is retired; the document tool lives in exec and multi' },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reps = Number(args.find(a => a.startsWith('--reps='))?.split('=')[1] ?? 1);
  const config = loadConfig(args.find(a => !a.startsWith('--')) ?? 'invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends, config.inference?.ollamaBackends, config.ollama.defaultContextSize);

  let pass = 0;
  const failures: string[] = [];

  for (let rep = 0; rep < reps; rep++) for (const c of CASES) {
    const start = Date.now();
    const result = await classifyMessage(client, config.router, c.message);
    const ms = Date.now() - start;
    const ok = c.expected.includes(result.category);
    if (ok) pass++;
    else failures.push(`"${c.message.slice(0, 50)}" → ${result.category} (wanted ${c.expected.join('|')})${c.note ? ` [${c.note}]` : ''}`);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${result.category.padEnd(11)} ${result.confidence.padEnd(8)} ${String(ms).padStart(5)}ms  "${c.message.slice(0, 55)}"`);
  }

  console.log(`\n${pass}/${CASES.length * reps} passed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main().catch(err => {
  console.error('Live check failed to run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
