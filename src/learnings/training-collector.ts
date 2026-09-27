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

export interface TrainingTurn { role: string; content: string; category?: string; routedBy?: string }

/** Whether a transcript turn is a usable (message, category) router pair. */
export function isTrainingPair(entry: TrainingTurn): boolean {
  if (entry.role !== 'user' || !entry.category || !entry.content?.trim()) return false;
  const content = entry.content.trim();
  // Skip synthetic/system messages
  if (content.startsWith('[RESEARCH PIPELINE]')) return false;
  if (content.startsWith('[DEVMESH')) return false;
  if (content.startsWith('!')) return false;
  if (content.length < 5) return false;
  // Never the user's words: plan-pipeline foreman handoffs, system notices, and
  // attachment stubs were 85 of 1,540 collected pairs and carried the category of
  // whatever pipeline emitted them (2026-09-25 router-dataset cleaning).
  if (isSyntheticTurn(content)) return false;
  // A sticky decision is a carry-over, not a judgment about THIS message: 20 turns of
  // small talk labeled `memory` went into the set on 2026-09-26 because the session
  // was stuck there. Turns older than the `routedBy` field (undefined) still harvest.
  if (entry.routedBy === 'sticky') return false;
  return true;
}

export function extractTrainingPairs(transcript: TrainingTurn[]): void {
  const pairs: string[] = [];

  for (const entry of transcript) {
    if (!isTrainingPair(entry)) continue;
    pairs.push(JSON.stringify({ message: entry.content.trim(), category: entry.category }));
  }

  if (pairs.length > 0) {
    mkdirSync('data/training', { recursive: true });
    appendFileSync(TRAINING_FILE, pairs.join('\n') + '\n');
    console.log(`[Training] Extracted ${pairs.length} router pairs before session reset`);
  }
}
