/**
 * Live check: what does the graph's entity clustering actually look like?
 *
 * This is the GATE for the heartbeat synthesis pass (DECISIONS 2026-09-20,
 * "Memory Gets Its Intake Fixed"). A "so what" pass over clusters only beats
 * restating its inputs when the clusters are real themes. On 2026-09-20 they
 * were not: 24 facts, the owner hub, a corpus stopword, and NER pairings.
 *
 * Run inside the lab tmux (node from SSH has no LAN):
 *   npx tsx scripts/memory-cluster-check.ts [senderId]
 *
 * Read the output as: would a small model, handed each cluster and asked what
 * the combination implies, say anything the facts don't already say?
 */
import { loadConfig } from '../src/config/loader.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { ownerNames } from '../src/identity/principal.js';

const config = await loadConfig();
const client = createInferenceClient(
  config.ollama.url, config.ollama.keepAlive, config.inference?.backends, config.inference?.ollamaBackends,
);
const store = new GraphMemoryStore(client, {
  ownerNames: ownerNames(config),
  embeddingModel: config.memory?.embeddingModel,
  embeddingDims: config.memory?.embeddingDims,
  ...config.memory.falkordb,
});

const senderId = process.argv[2] ?? Object.keys(config.principals ?? {})[0] ?? config.ownerId;
const all = await store.getAllFacts(senderId);
const byProv = all.reduce<Record<string, number>>((a, f) => ((a[f.provenance] = (a[f.provenance] ?? 0) + 1), a), {});
console.log(`sender: ${senderId}  facts: ${all.length}  provenance: ${JSON.stringify(byProv)}\n`);

const clusters = await store.getClusters(senderId);
console.log(`clusters after hygiene: ${clusters.length}`);
for (const c of clusters) {
  console.log(`\n--- [${c.entity}] (${c.type ?? '?'}) ×${c.facts.length}  share=${(c.facts.length / Math.max(1, all.length) * 100).toFixed(0)}%`);
  for (const f of c.facts) console.log(`      ${f.slice(0, 110)}`);
}
process.exit(0);
