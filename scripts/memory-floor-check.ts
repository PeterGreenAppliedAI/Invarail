/**
 * Live memory-floor check — READ-ONLY queries against the real FalkorDB graph.
 * Validates the 0.55 similarity floor: an irrelevant query should inject
 * nothing; a relevant one should still surface facts. Prints per-result raw
 * similarity so the floor can be tuned on real data.
 *
 * Usage: npx tsx scripts/memory-floor-check.ts   (run inside the tmux lab session)
 */
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';

const QUERIES = [
  { label: 'irrelevant (expect 0 past floor)', q: 'how do I fold an origami paper crane' },
  { label: 'relevant (expect hits)', q: 'what hardware does LocalClaw run on' },
  { label: 'mid (personal-adjacent)', q: 'what projects am I working on right now' },
];

async function main(): Promise<void> {
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const store = new GraphMemoryStore(client);
  // Facts are stored under the USER's sender id (config.ownerId), not the
  // heartbeat delivery target (a channel id)
  const senderId = process.argv[2] ?? config.ownerId;
  if (!senderId) throw new Error('No senderId — pass as argv or set ownerId in config');
  console.log(`senderId: ${senderId}`);

  for (const { label, q } of QUERIES) {
    console.log(`\n=== ${label}: "${q}"`);
    const unfloored = await store.search(q, senderId, 5);
    const floored = await store.search(q, senderId, 5, { minSimilarity: 0.55 });
    console.log(`  without floor: ${unfloored.length} results`);
    for (const r of unfloored) {
      console.log(`    sim=${(r.similarity ?? 0).toFixed(3)} score=${r.score.toFixed(3)} imp=${r.importance} "${r.text.slice(0, 70)}"`);
    }
    console.log(`  WITH floor (0.55): ${floored.length} results ${floored.length < unfloored.length ? `(${unfloored.length - floored.length} filtered)` : ''}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
