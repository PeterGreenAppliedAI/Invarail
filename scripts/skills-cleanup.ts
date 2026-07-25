/**
 * One-time skill catalog cleanup + embedding backfill (July 2026 skill audit).
 *
 * - Merges the three near-duplicate web→report skills into one
 * - Archives heartbeat-born skills (predate the structural cronMode guard)
 * - Backfills embeddings for every surviving skill
 *
 * Run from the tmux lab (needs LAN access to the embedding backend):
 *   npx tsx scripts/skills-cleanup.ts [workspacePath]
 */

import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { SkillStore } from '../src/skills/store.js';
import { upsertSkillEmbedding, deleteSkillEmbedding } from '../src/skills/semantic.js';

const DUPES: Array<[string, string]> = [
  ['generate-report-from-web', 'fetch-and-format-report'],
  ['generate-report-from-web', 'generate-and-convert-content'],
];
const HEARTBEAT_BORN = ['execute-heartbeat-tasks', 'evaluate-and-report-tasks'];

async function main(): Promise<void> {
  const workspacePath = process.argv[2] ?? 'data/workspaces/main';
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const store = new SkillStore(workspacePath);

  console.log(`Before: ${store.list().map(s => s.slug).join(', ')}`);

  for (const [keep, absorb] of DUPES) {
    if (store.get(keep) && store.get(absorb)) {
      store.merge(keep, absorb);
      deleteSkillEmbedding(absorb);
    }
  }

  for (const slug of HEARTBEAT_BORN) {
    if (store.get(slug)) {
      store.archive(slug);
      deleteSkillEmbedding(slug);
    }
  }

  for (const summary of store.list()) {
    const skill = store.get(summary.slug);
    if (!skill) continue;
    await upsertSkillEmbedding(client, skill);
    console.log(`Embedded: ${skill.slug}`);
  }

  console.log(`After: ${store.list().map(s => s.slug).join(', ')}`);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
