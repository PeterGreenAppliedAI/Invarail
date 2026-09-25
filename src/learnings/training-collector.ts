/**
 * Extract (message, category) training pairs from transcripts.
 * Used before session clear to preserve router training data.
 */
import { mkdirSync, appendFileSync } from 'node:fs';

const TRAINING_FILE = 'data/training/router-pairs.jsonl';

// Case-sensitive on purpose: these are the exact literals the pipelines emit. A
// user merely mentioning "context from previous steps" must not be dropped.
const SYNTHETIC_TURN = /^\s*(\[SYSTEM\]|\[Attached file|\[The user attached|\[The user sent|\[PAGE)|Context from previous steps:/;

/** A transcript "user" turn that no human typed — injected by a pipeline, a
 *  system notice, or attachment handling. Such turns must not become router
 *  training pairs: their category is the emitting pipeline's, not an intent. */
export function isSyntheticTurn(content: string): boolean {
  return SYNTHETIC_TURN.test(content);
}

export function extractTrainingPairs(transcript: Array<{ role: string; content: string; category?: string }>): void {
  const pairs: string[] = [];

  for (const entry of transcript) {
    if (entry.role !== 'user' || !entry.category || !entry.content?.trim()) continue;
    const content = entry.content.trim();
    // Skip synthetic/system messages
    if (content.startsWith('[RESEARCH PIPELINE]')) continue;
    if (content.startsWith('[DEVMESH')) continue;
    if (content.startsWith('!')) continue;
    if (content.length < 5) continue;
    // Never the user's words: plan-pipeline foreman handoffs, system notices, and
    // attachment stubs were 85 of 1,540 collected pairs and carried the category of
    // whatever pipeline emitted them (2026-09-25 router-dataset cleaning).
    if (isSyntheticTurn(content)) continue;

    pairs.push(JSON.stringify({ message: content, category: entry.category }));
  }

  if (pairs.length > 0) {
    mkdirSync('data/training', { recursive: true });
    appendFileSync(TRAINING_FILE, pairs.join('\n') + '\n');
    console.log(`[Training] Extracted ${pairs.length} router pairs before session reset`);
  }
}
