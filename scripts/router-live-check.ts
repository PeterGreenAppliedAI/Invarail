/**
 * Live router check — fires known-intent messages through classifyMessage
 * against the REAL gateway/model. Validates the enum-constrained call's
 * fallback path, the narrowed URL override, and overall routing quality.
 *
 * Usage: npx tsx scripts/router-live-check.ts
 */
import { loadConfig } from '../src/config/loader.js';
import { OllamaClient } from '../src/ollama/client.js';
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
  { message: 'tell the family discord channel dinner is at 7', expected: ['message'] },
  { message: 'generate an image of a lighthouse at sunset', expected: ['image'] },
  { message: 'research the small-model agent landscape in depth for me', expected: ['research'] },
  { message: 'turn this analysis into a PDF report', expected: ['document', 'research'], note: 'document keyword' },
];

async function main(): Promise<void> {
  const config = loadConfig(process.argv[2] ?? 'localclaw.config.json5');
  const client = new OllamaClient(config.ollama.url);

  let pass = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const start = Date.now();
    const result = await classifyMessage(client, config.router, c.message);
    const ms = Date.now() - start;
    const ok = c.expected.includes(result.category);
    if (ok) pass++;
    else failures.push(`"${c.message.slice(0, 50)}" → ${result.category} (wanted ${c.expected.join('|')})${c.note ? ` [${c.note}]` : ''}`);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${result.category.padEnd(11)} ${result.confidence.padEnd(8)} ${String(ms).padStart(5)}ms  "${c.message.slice(0, 55)}"`);
  }

  console.log(`\n${pass}/${CASES.length} passed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main().catch(err => {
  console.error('Live check failed to run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
