/**
 * Migrate memory from per-channel sender ids to principals.
 *
 * Rewrites in FalkorDB: Fact.senderId, Turn.senderId, UserModel.senderId for
 * every alias in config.principals. Merges flat-store per-alias fact files
 * into the principal's bucket via writeFactsBatch (the store's dedup applies).
 * Alias flat files are left in place (harmless — nothing reads them once
 * dispatch resolves principals); FalkorDB is updated in place.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-principal.ts            # dry run (default)
 *   npx tsx scripts/migrate-to-principal.ts --apply    # actually migrate
 */
import { FalkorDB } from 'falkordb';
import { loadConfig } from '../src/config/loader.js';
import { FactStore } from '../src/memory/fact-store.js';
import { resolveWorkspacePath } from '../src/agents/scope.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const principals = Object.entries(config.principals ?? {});
  if (principals.length === 0) {
    console.log('No principals configured — nothing to migrate.');
    process.exit(0);
  }
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to execute)'}\n`);

  // --- Graph ---
  const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('invarail_memory');

  for (const [principal, def] of principals) {
    const aliases = def.aliases.filter(a => a !== principal);
    if (aliases.length === 0) continue;
    console.log(`== ${principal} ← [${aliases.join(', ')}]`);

    for (const label of ['Fact', 'Turn', 'UserModel']) {
      const count = await graph.query(
        `MATCH (n:${label}) WHERE n.senderId IN $aliases RETURN count(n) AS n`,
        { params: { aliases } },
      );
      const n = (count.data?.[0] as any)?.n ?? 0;
      console.log(`  graph ${label}: ${n} node(s) to rewrite`);
      if (APPLY && n > 0) {
        if (label === 'UserModel') {
          // Multiple per-alias UserModels can't merge automatically — keep the
          // most recently updated one as the principal's, leave others in place
          const rows = await graph.query(
            `MATCH (m:UserModel) WHERE m.senderId IN $aliases RETURN m.senderId AS s, m.updatedAt AS u ORDER BY u DESC`,
            { params: { aliases } },
          );
          const newest = (rows.data?.[0] as any)?.s;
          if (newest) {
            await graph.query(
              `MATCH (m:UserModel {senderId: $s}) SET m.senderId = $principal`,
              { params: { s: newest, principal } },
            );
            console.log(`  graph UserModel: kept newest (${newest}) as ${principal}`);
          }
        } else {
          await graph.query(
            `MATCH (n:${label}) WHERE n.senderId IN $aliases SET n.senderId = $principal`,
            { params: { aliases, principal } },
          );
          console.log(`  graph ${label}: rewritten`);
        }
      }
    }

    // --- Flat store ---
    const workspacePath = resolveWorkspacePath(config.agents.default, config);
    const store = new FactStore(workspacePath);
    let flatMoved = 0;
    for (const alias of aliases) {
      const facts = store.loadFactsJson(alias);
      if (facts.length === 0) continue;
      console.log(`  flat ${alias}: ${facts.length} fact(s) to merge into ${principal}`);
      if (APPLY) {
        for (const f of facts) {
          await store.writeFactsBatch(
            [{ text: f.text, category: f.category, confidence: f.confidence, importance: f.importance }],
            principal,
            `migration/${alias}`,
            f.createdAt,
          );
        }
        flatMoved += facts.length;
      }
    }
    if (APPLY && flatMoved > 0) {
      store.rebuildFacts(principal);
      console.log(`  flat: ${flatMoved} fact(s) merged (store dedup applied), rebuilt`);
    }
  }

  if (APPLY) {
    console.log('\nMigration complete. Verify with: npx tsx scripts/memory-floor-check.ts <principal>');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
