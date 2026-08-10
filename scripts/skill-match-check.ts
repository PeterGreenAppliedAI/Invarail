/**
 * Measure the semantic skill-match floor against the REAL embedding model.
 * Prints cosine scores for should-match and should-NOT-match probes so the
 * SKILL_MATCH_FLOOR constant is a measured number, not a guess.
 *
 * Run from the tmux lab: npx tsx scripts/skill-match-check.ts [workspacePath]
 */

import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { SkillStore } from '../src/skills/store.js';
import { findSkillBySimilarity } from '../src/skills/semantic.js';

const SHOULD_MATCH = [
  'search for the top AI stories and make me a PDF report',
  'look up GPU prices online and put together a report document',
  'find news about DGX Spark and generate a summary PDF',
];

const SHOULD_NOT_MATCH = [
  'what did we talk about yesterday',
  'remind me on Sept 15 to renew the token',
  'how are you doing today',
];

async function main(): Promise<void> {
  const workspacePath = process.argv[2] ?? 'data/workspaces/main';
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const store = new SkillStore(workspacePath);

  console.log('=== should MATCH (want scores ABOVE the floor) ===');
  for (const probe of SHOULD_MATCH) {
    const m = await findSkillBySimilarity(client, store, probe, 0); // floor 0 → raw score
    console.log(`${(m?.score ?? 0).toFixed(3)}  ${m?.slug ?? '(none)'}  ← "${probe}"`);
  }

  console.log('\n=== should NOT match (want scores BELOW the floor) ===');
  for (const probe of SHOULD_NOT_MATCH) {
    const m = await findSkillBySimilarity(client, store, probe, 0);
    console.log(`${(m?.score ?? 0).toFixed(3)}  ${m?.slug ?? '(none)'}  ← "${probe}"`);
  }

  console.log('\nCurrent floor: see SKILL_MATCH_FLOOR in src/skills/semantic.ts — set it between the two bands.');
}

main().catch(err => {
  console.error('Check failed:', err);
  process.exit(1);
});
