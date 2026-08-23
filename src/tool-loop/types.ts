export interface ReActStep {
  thought: string;
  action?: { tool: string; params: Record<string, unknown> };
  observation?: string;
  finalAnswer?: string;
}

export interface ReActResult {
  answer: string;
  steps: ReActStep[];
  iterations: number;
  hitMaxIterations: boolean;
  /** True when the run was stopped via !stop (isCancelled) — partial work, honest exit */
  cancelled?: boolean;
  /** Total prompt tokens consumed across all iterations */
  promptTokens?: number;
  /** Total completion tokens generated across all iterations */
  completionTokens?: number;
}

export interface ReActConfig {
  maxIterations: number;
  model: string;
  temperature: number;
  maxTokens: number;
  topK?: number;
  topP?: number;
  repeatPenalty?: number;
  systemPrompt?: string;
  contextSize?: number;
  /** Skip drift detection — browser control sessions produce long responses that trigger false positives */
  skipDriftDetection?: boolean;
  /** Tool-calling convention: 'native' (API tools field, no text-format prompt block)
   *  or 'text' (prompt-described tools + Action: format, no native tools). Default 'native'. */
  toolStyle?: 'native' | 'text';
  /** Thinking control for reasoning models — passed through to Ollama `think`.
   *  Boolean toggles; 'low'|'medium'|'high' effort levels for gpt-oss-family
   *  models (their native knob; they have no off-mode). Unset = model default.
   *  Callers must only set this for thinking-capable models. */
  think?: boolean | 'low' | 'medium' | 'high';
  /** Turn-stopping checkpoint (completion contracts): code inspects the final answer at
   *  natural stop and at the iteration cap. Reject at natural stop → feedback injected as
   *  a user message, loop continues on granted iterations (default 4); reject at cap →
   *  the answer is REPLACED with the feedback (honest failure — no loops at the cap).
   *  Engine caps invocations at 3 per run regardless of the hook's own budget. */
  onFinalAnswer?: (answer: string, steps: ReActStep[], phase: 'natural' | 'cap') => Promise<{ accept: true } | { accept: false; feedback: string; grantIterations?: number }>;
}

export type ParsedReActResponse =
  | { type: 'action'; thought: string; tool: string; params: Record<string, unknown>; raw: string }
  | { type: 'final_answer'; thought: string; answer: string }
  | { type: 'fallback'; content: string };
