import { estimateTokens } from '../context/tokens.js';

/**
 * Keep the NEWEST lines that fit a token budget.
 *
 * Extraction prompts carry the whole condensed transcript. When that overflows
 * the model's context, Ollama truncates from the FRONT — which is where the
 * extraction instructions live — and the model, seeing only a wall of chat,
 * continues the chat instead of returning JSON (live, 2026-09-20). Dropping the
 * oldest turns ourselves keeps the instructions intact and makes the loss
 * visible: the caller logs `dropped`. Newest-first because the newest turns are
 * the ones incremental capture has not yet seen.
 */
export function fitLinesToTokenBudget(lines: string[], tokenBudget: number): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]);
    if (used + cost > tokenBudget) break;
    used += cost;
    kept.unshift(lines[i]);
  }
  return { kept, dropped: lines.length - kept.length };
}
