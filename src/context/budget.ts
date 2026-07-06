import type { OllamaMessage } from '../ollama/types.js';
import { estimateTokens, estimateMessagesTokens } from './tokens.js';

export interface ContextBudget {
  totalTokens: number;       // model context window (e.g., 32768)
  systemTokens: number;      // system prompt + workspace context + extra sections
  outputReserve: number;     // specialist's maxTokens (num_predict)
  historyBudget: number;     // remaining for conversation history
}

const SAFETY_MARGIN = 256;

/**
 * Compute how the model's context window should be divided.
 *
 * historyBudget = contextSize - systemTokens - currentMessageTokens - outputReserve - safetyMargin
 */
export function computeBudget(params: {
  contextSize: number;
  systemPrompt: string;
  workspaceContext: string;
  currentMessage: string;
  outputReserve: number;
  /** Additional prompt sections that consume context: serialized tool definitions,
   *  state preamble, user priming. Historically omitted, which systematically
   *  overestimated historyBudget by 3-6k tokens on tool-using specialists. */
  extraSections?: string[];
}): ContextBudget {
  const systemTokens = estimateTokens(params.systemPrompt)
    + estimateTokens(params.workspaceContext)
    + (params.extraSections ?? []).reduce((sum, s) => sum + estimateTokens(s), 0);
  const currentMessageTokens = estimateTokens(params.currentMessage);

  const historyBudget = Math.max(
    0,
    params.contextSize - systemTokens - currentMessageTokens - params.outputReserve - SAFETY_MARGIN,
  );

  return {
    totalTokens: params.contextSize,
    systemTokens,
    outputReserve: params.outputReserve,
    historyBudget,
  };
}

/**
 * Trim history from the FRONT (oldest first) until it fits the budget.
 * Drops whole turn pairs to keep the conversation shape coherent; always
 * keeps at least the most recent `minKeep` messages.
 */
export function trimHistoryToFit(
  messages: OllamaMessage[],
  budgetTokens: number,
  minKeep = 2,
): OllamaMessage[] {
  if (messages.length === 0) return messages;
  const trimmed = [...messages];
  while (trimmed.length > minKeep && estimateMessagesTokens(trimmed) > budgetTokens) {
    trimmed.splice(0, Math.min(2, trimmed.length - minKeep));
  }
  return trimmed;
}
