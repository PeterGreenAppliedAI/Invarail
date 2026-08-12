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
  /** Thinking control (2026-08 eval, runtime-probed):
   *  'toggle' — accepts AND honors think true/false
   *  'levels' — effort strings only ('low'|'medium'|'high'); ACCEPTS booleans but
   *             silently ignores false (accepts ≠ obeys — gpt-oss:120b). Boolean
   *             think on these models is a no-op at best; combined with `format`
   *             it triggers an Ollama output-discard bug. Use effort strings.
   *  'none'   — rejects the think field (Ollama 400)
   *  undefined — unprobed; treat as unknown */
  think?: 'toggle' | 'levels' | 'none';
}

const DEFAULT_CAPS: ModelCaps = { supportsFormat: true, parallelToolCalls: false, vision: false };

/** Prefix → caps. Order-independent (longest prefix wins). */
const MODEL_CAPS: Record<string, Partial<ModelCaps>> = {
  'deepseek': { supportsFormat: true, parallelToolCalls: true, think: 'toggle' }, // ds4-verified
  'deepseek-coder': { think: 'none' },
  'phi4': { supportsFormat: true, think: 'none' },
  'qwen3-embedding': { supportsFormat: false, think: 'none' },
  'qwen': { supportsFormat: true },
  'qwen2.5': { think: 'none' },
  'qwen3': { think: 'toggle' },
  'qwen3-coder': { think: 'none' },
  'qwen3.5': { think: 'toggle' },
  'qwen3.6': { think: 'toggle' },
  'gemma': { supportsFormat: true, vision: true },
  'gemma4': { supportsFormat: true, vision: true, think: 'toggle' },
  'muse-glimmer': { think: 'toggle' },
  'nemotron': { think: 'toggle' },
  'glm': { think: 'toggle' },
  'devstral': { think: 'none' },
  'llama4': { think: 'none' },
  'gpt-oss': { think: 'toggle' },          // 20b honors false (eval-verified)
  'gpt-oss:120b': { think: 'levels' },     // accepts false, silently disobeys it
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
