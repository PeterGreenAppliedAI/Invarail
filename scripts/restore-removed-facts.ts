/**
 * One-time recovery for the July 30 heartbeat-review incident: bare
 * "!heartbeat no" removed all 46 accumulated review candidates when the
 * report displayed only 2 (41 were still-valid facts). Restores 44 through
 * BOTH stores (flat writeFactsBatch + graph addFact — write-through, same
 * as !save), re-tagging importance/category via the extraction model since
 * removed.jsonl keeps only text. Skips the 2 genuinely stale facts and
 * cleans restored entries out of the removal ledger so re-extraction isn't
 * blocked forever.
 *
 * Run from the tmux lab (extraction model + embeddings need LAN):
 *   npx tsx scripts/restore-removed-facts.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { FactStore } from '../src/memory/fact-store.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';
import type { FactInput } from '../src/config/types.js';

const REMOVED_PATH = 'data/workspaces/main/memory/peter/removed.jsonl';
const WORKSPACE = 'data/workspaces/main';
const PRINCIPAL = 'peter';
const INCIDENT_DAY = '2026-07-30';

// Genuinely stale — confirmed with Peter: the birth happened; the meeting passed.
const SKIP_PATTERNS = [/expecting their third child/i, /meeting on July 14th with Atera/i];

interface RemovedEntry { text: string; reason: string; removedAt: string; expiresAt?: string }

async function main(): Promise<void> {
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  const allLines = readFileSync(REMOVED_PATH, 'utf-8').trim().split('\n');
  const entries = allLines.map(l => JSON.parse(l) as RemovedEntry);
  const todays = entries.filter(e => e.removedAt?.startsWith(INCIDENT_DAY));
  const toRestore = todays.filter(e => !SKIP_PATTERNS.some(p => p.test(e.text)));
  const skipped = todays.filter(e => SKIP_PATTERNS.some(p => p.test(e.text)));
  console.log(`Removed on ${INCIDENT_DAY}: ${todays.length} · restoring: ${toRestore.length} · skipping stale: ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP: ${s.text.slice(0, 80)}`);

  // Re-tag via the extraction model — removed.jsonl kept only text
  const extractionModel = config.memory?.extractionModel ?? config.router.model;
  console.log(`Re-tagging ${toRestore.length} facts via ${extractionModel}...`);
  const tagged = new Map<number, Partial<FactInput>>();
  try {
    const numbered = toRestore.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
    const response = await client.chat({
      model: extractionModel,
      messages: [
        {
          role: 'system',
          content: [
            'For each numbered fact, assign metadata. Return ONLY a JSON array, one object per fact, same order:',
            '[{"n":1,"category":"stable|context|decision|question","importance":1-5,"tags":["kw"],"entities":["ProperNoun"]}]',
            'IMPORTANCE: 5=critical (health/family), 4=identity (job/employer/key projects), 3=preference, 2=context, 1=ephemeral.',
          ].join('\n'),
        },
        { role: 'user', content: numbered },
      ],
      options: { temperature: 0.1, num_predict: 4096 },
    });
    const raw = response.message?.content ?? '';
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as Array<{ n: number; category?: string; importance?: number; tags?: string[]; entities?: string[] }>;
    for (const t of arr) {
      if (typeof t.n === 'number') tagged.set(t.n - 1, { category: t.category as FactInput['category'], importance: t.importance, tags: t.tags, entities: t.entities });
    }
    console.log(`Model tagged ${tagged.size}/${toRestore.length} (rest get defaults)`);
  } catch (err) {
    console.warn('Re-tagging failed — all facts get defaults (context, imp 3):', err instanceof Error ? err.message : err);
  }

  // Small-model enum drift is real (phi4 returned "business relationship") —
  // coerce to the closed set, never trust the model with a schema boundary
  const VALID_CATEGORIES = new Set(['stable', 'context', 'decision', 'question']);
  const inputs: FactInput[] = toRestore.map((e, i) => {
    const t = tagged.get(i) ?? {};
    return {
      text: e.text,
      category: (VALID_CATEGORIES.has(t.category as string) ? t.category : 'context') as FactInput['category'],
      confidence: 0.8,
      tags: t.tags ?? [],
      entities: t.entities ?? [],
      importance: Math.min(5, Math.max(1, t.importance ?? 3)),
      source: 'restore/2026-07-30-incident',
    };
  });

  // Flat store (bookkeeping layer)
  const factStore = new FactStore(WORKSPACE, client);
  const written = await factStore.writeFactsBatch(inputs, PRINCIPAL, 'restore/2026-07-30-incident');
  factStore.rebuildFacts(PRINCIPAL);
  console.log(`Flat store: ${written.length}/${inputs.length} written (dedup skips are fine)`);

  // Graph store (what the agent actually recalls) — write-through like !save
  const graph = new GraphMemoryStore(client, config.memory?.falkordb);
  let graphAdded = 0;
  for (const input of inputs) {
    try {
      const id = await graph.addFact(input, PRINCIPAL, 'restore/2026-07-30-incident');
      if (id) graphAdded++;
    } catch (err) {
      console.warn(`  graph add failed for "${input.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`Graph: ${graphAdded}/${inputs.length} added (cosine-dedup rejects are expected for survivors)`);

  // Ledger cleanup: restored facts must not stay marked user_denied (blocks re-extraction)
  const restoredTexts = new Set(toRestore.map(e => e.text));
  const keptLines = entries.filter(e => !(e.removedAt?.startsWith(INCIDENT_DAY) && restoredTexts.has(e.text)));
  writeFileSync(REMOVED_PATH, keptLines.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`removed.jsonl: ${allLines.length} → ${keptLines.length} lines (restored entries cleared, stale skips retained)`);

  console.log('\nDone. Verify: !heartbeat report next cycle + ask the bot something Val/Clearpath-related.');
  process.exit(0);
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
