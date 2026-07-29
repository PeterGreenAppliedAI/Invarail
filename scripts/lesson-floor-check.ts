/**
 * Measure the lesson-match floor against the REAL embedding model, once a few
 * real lessons exist (~5+). Same discipline as skill-match-check: floors are
 * measured, never guessed. Update LESSON_MATCH_FLOOR in
 * src/learnings/lesson-semantic.ts from the printed bands.
 *
 * Run from the tmux lab: npx tsx scripts/lesson-floor-check.ts [workspacePath]
 */

import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { LessonStore } from '../src/learnings/lesson-store.js';
import { findLessonBySimilarity } from '../src/learnings/lesson-semantic.js';

const SHOULD_NOT_MATCH = [
  'what did we talk about yesterday',
  'how are you doing today',
  'remind me on Sept 15 to renew the token',
];

async function main(): Promise<void> {
  const workspacePath = process.argv[2] ?? 'data/workspaces/main';
  const config = loadConfig('localclaw.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const store = new LessonStore(workspacePath);

  const lessons = store.list();
  if (lessons.length < 3) {
    console.log(`Only ${lessons.length} lesson(s) — measure once ~5 real ones exist.`);
    return;
  }

  console.log('=== should MATCH (each lesson probed with its own triggers/situation) ===');
  for (const summary of lessons) {
    const lesson = store.get(summary.slug);
    if (!lesson) continue;
    const probes = lesson.triggers.length > 0 ? lesson.triggers : [lesson.situation];
    for (const probe of probes.slice(0, 2)) {
      const m = await findLessonBySimilarity(client, store, probe, 0);
      console.log(`${(m?.score ?? 0).toFixed(3)}  ${m?.slug ?? '(none)'}  ← "${probe.slice(0, 60)}"`);
    }
  }

  console.log('\n=== should NOT match (want scores BELOW the floor) ===');
  for (const probe of SHOULD_NOT_MATCH) {
    const m = await findLessonBySimilarity(client, store, probe, 0);
    console.log(`${(m?.score ?? 0).toFixed(3)}  ${m?.slug ?? '(none)'}  ← "${probe}"`);
  }

  console.log('\nCurrent floor: LESSON_MATCH_FLOOR in src/learnings/lesson-semantic.ts — set it between the bands.');
}

main().catch(err => {
  console.error('Check failed:', err);
  process.exit(1);
});
