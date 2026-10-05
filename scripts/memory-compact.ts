/**
 * Collapse reworded duplicate facts in the flat store's INDEX, for every profile in a workspace —
 * the same compaction the heartbeat's memory_cleanup now runs each cycle (DECISIONS 2026-10-05).
 *
 *   npx tsx scripts/memory-compact.ts            # dry run: what would be collapsed
 *   npx tsx scripts/memory-compact.ts --apply    # back up <workspace>/memory, then compact
 *
 * Per cluster the winner is the strongest provenance (stated > observed > inferred), then the
 * newest; it keeps the cluster's highest importance. Nothing is deleted on a dry run.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { resolveWorkspacePath } from '../src/agents/scope.js';
import { FactStore } from '../src/memory/fact-store.js';

const apply = process.argv.includes('--apply');
const config = loadConfig(process.argv.find(a => a.endsWith('.json5')) ?? 'invarail.config.json5');
const ws = resolveWorkspacePath(config.agents.default, config);
const memDir = join(ws, 'memory');
if (!existsSync(memDir)) { console.log(`No memory at ${memDir}`); process.exit(0); }

const profiles = readdirSync(memDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(memDir, d.name, 'index')))
  .map(d => d.name);
const shared = existsSync(join(memDir, 'index'));

if (apply) {
  const backup = `${memDir}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  cpSync(memDir, backup, { recursive: true });
  console.log(`Backed up ${memDir} → ${backup}`);
}

const store = new FactStore(ws);
let total = 0;
for (const sender of [...(shared ? [undefined] : []), ...profiles]) {
  const before = store.loadIndexEntries(sender).length;
  const r = store.compactDuplicates(sender, { dryRun: !apply });
  total += r.removed;
  if (r.removed === 0) { console.log(`${sender ?? '(shared)'}: ${before} facts, no reworded duplicates`); continue; }
  console.log(`\n${sender ?? '(shared)'}: ${before} facts → ${before - r.removed} (${r.removed} reworded duplicates in ${r.clusters.length} clusters)`);
  for (const c of r.clusters.slice(0, 8)) {
    console.log(`  keep: ${c.keep.slice(0, 100)}`);
    for (const d of c.drop.slice(0, 2)) console.log(`   drop: ${d.slice(0, 100)}`);
    if (c.drop.length > 2) console.log(`   … and ${c.drop.length - 2} more`);
  }
  if (r.clusters.length > 8) console.log(`  … and ${r.clusters.length - 8} more clusters`);
}
console.log(`\n${apply ? 'Removed' : 'Would remove'} ${total} reworded duplicate(s).${apply ? '' : ' Run with --apply to compact (a backup is taken first).'}`);
process.exit(0);
