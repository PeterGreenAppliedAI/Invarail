/**
 * Minimal client for a System-One decision server (Laya's `/v1/systemone`, wire-
 * compatible with TypeSafe Jev). It asks ONE typed question — "which specialist
 * should handle this message?" — and gets back a choice with a probability per
 * option in a single forward pass. Nothing is generated, so there is nothing to
 * parse, no thinking to strip, and no `format` to collide with.
 *
 * Deliberately not an OllamaClient: this is not a chat backend and must never be
 * mistaken for one. The only consumer today is the router shadow.
 */

/** Must match the instruction the checkpoint was trained with
 *  (~/laya-eval/router_question.py QUESTION.instructions). */
export const ROUTER_QUESTION_INSTRUCTIONS = 'Which specialist should handle `message`?';

export interface SystemOneDecision {
  choice: string;
  /** Probability of the chosen option (0-1). Calibration is the model's claim, not ours. */
  confidence: number;
  probabilities: Record<string, number>;
  ms: number;
}

export class SystemOneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly apiKey?: string,
  ) {}

  /**
   * Route `message` against `categories` (name → description; the descriptions are
   * the option text the model reads, so they must be the exact strings it was
   * trained on). Returns null on any failure — callers decide whether that matters.
   */
  async route(message: string, categories: Record<string, string>): Promise<SystemOneDecision | null> {
    const t0 = Date.now();
    const body = {
      state: { message },
      questions: {
        category: { type: 'choice', instructions: ROUTER_QUESTION_INSTRUCTIONS, criteria: categories },
      },
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.warn('[SystemOne] request failed:', err instanceof Error ? err.message : err);
      return null;
    }
    if (!res.ok) {
      console.warn(`[SystemOne] ${res.status} ${res.statusText}`);
      return null;
    }
    const json = (await res.json().catch(() => null)) as { answers?: { category?: { choice?: unknown; probabilities?: unknown } } } | null;
    const answer = json?.answers?.category;
    if (!answer || typeof answer.choice !== 'string') {
      console.warn('[SystemOne] malformed answer:', JSON.stringify(json).slice(0, 200));
      return null;
    }
    const probabilities: Record<string, number> = {};
    if (answer.probabilities && typeof answer.probabilities === 'object') {
      for (const [k, v] of Object.entries(answer.probabilities as Record<string, unknown>)) {
        if (typeof v === 'number') probabilities[k] = v;
      }
    }
    return {
      choice: answer.choice,
      confidence: probabilities[answer.choice] ?? 0,
      probabilities,
      ms: Date.now() - t0,
    };
  }
}
