/**
 * Declared model capabilities — replaces scattered discovered-at-runtime
 * knowledge (e.g. the extractor's "backend rejected format" fallback flag)
 * with a lookup. Matched by model-id PREFIX (longest match wins) so version
 * suffixes don't need their own rows. Unknown models get optimistic defaults
 * plus the existing runtime fallbacks as the safety net.
 *
 * OpenWorker's matrix hard-codes parallel_tool_calls=false for all of Ollama
 * ("many fake/mishandle parallel tool calls") — kept here as the default for
 * small local models; the one-convention-per-model rule made the same call.
 */

export interface ModelCaps {
  /** Grammar-constrained decoding (Ollama `format` / vLLM guided_json) */
  supportsFormat: boolean;
  /** May emit multiple tool calls in one turn without mangling them */
  parallelToolCalls: boolean;
  vision: boolean;
}

const DEFAULT_CAPS: ModelCaps = { supportsFormat: true, parallelToolCalls: false, vision: false };

/** Prefix → caps. Order-independent (longest prefix wins). */
const MODEL_CAPS: Record<string, Partial<ModelCaps>> = {
  'deepseek': { supportsFormat: true, parallelToolCalls: true },
  'phi4': { supportsFormat: true },
  'qwen3-embedding': { supportsFormat: false },
  'qwen': { supportsFormat: true },
  'gemma': { supportsFormat: true, vision: true },
  'llava': { vision: true },
};

export function capsFor(modelId: string): ModelCaps {
  const id = modelId.toLowerCase();
  let bestPrefix = '';
  for (const prefix of Object.keys(MODEL_CAPS)) {
    if (id.startsWith(prefix) && prefix.length > bestPrefix.length) bestPrefix = prefix;
  }
  return { ...DEFAULT_CAPS, ...(bestPrefix ? MODEL_CAPS[bestPrefix] : {}) };
}
