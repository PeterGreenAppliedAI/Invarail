/**
 * Every model the harness has measured, by Ollama tag, with the thinking mode that scored
 * best and its scores. Source: evals/2026-08-local-model-eval (20B–124B) and
 * evals/2026-09-small-tier (1.5B–14.7B). The wizard ranks what a machine has by THIS
 * table and by fit, instead of "the largest model present" — a 32B coder is not a chat
 * model and a 27B does not fit a 12GB card. test/setup/measured-models.test.ts checks the
 * numbers against the published results.json files so this cannot drift from the evals.
 */
import type { OllamaModel } from '../ollama/types.js';

export type ThinkPick = 'off' | 'on' | 'low' | 'none';

export interface MeasuredModel {
  /** Ollama tag as evaluated. */
  tag: string;
  /** Thinking mode of the best-scoring row. 'none' = the model has no toggle. */
  think: ThinkPick;
  overall: number;   // 0–1
  tool: number;      // 0–1
  extract: number;   // 0–1
  source: '2026-08' | '2026-09';
}

/** Score below which a model is listed but not recommended for the foreground. */
export const FOREGROUND_FLOOR = 0.8;

/** Best mode per base model. Rows under FOREGROUND_FLOOR are kept so the picker can SAY why. */
export const MEASURED: MeasuredModel[] = [
  // 2026-09 small tier
  { tag: 'qwen3.5:9b', think: 'off', overall: 0.917, tool: 1.0, extract: 1.0, source: '2026-09' },
  { tag: 'gemma4:12b', think: 'off', overall: 0.917, tool: 1.0, extract: 1.0, source: '2026-09' },
  { tag: 'qwen2.5:7b', think: 'none', overall: 0.814, tool: 0.92, extract: 1.0, source: '2026-09' },
  // below the floor — shown with their numbers so nobody picks them blind
  { tag: 'llama3.1:8b', think: 'none', overall: 0.693, tool: 0.74, extract: 0.92, source: '2026-09' },
  { tag: 'phi4:latest', think: 'none', overall: 0.667, tool: 0.0, extract: 1.0, source: '2026-09' },
  { tag: 'phi4-mini:latest', think: 'none', overall: 0.607, tool: 0.55, extract: 0.92, source: '2026-09' },
  { tag: 'mistral:7b', think: 'none', overall: 0.606, tool: 0.58, extract: 0.92, source: '2026-09' },
  { tag: 'deepseek-r1:1.5b', think: 'on', overall: 0.587, tool: 0.54, extract: 0.75, source: '2026-09' },
  { tag: 'gemma3:4b', think: 'none', overall: 0.535, tool: 0.0, extract: 0.92, source: '2026-09' },
  { tag: 'gemma3n:e4b', think: 'none', overall: 0.417, tool: 0.0, extract: 0.75, source: '2026-09' },
  // 2026-08
  { tag: 'gpt-oss:120b', think: 'low', overall: 1.0, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3.6:27b', think: 'off', overall: 1.0, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3.8:27b', think: 'on', overall: 1.0, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'gemma4:31b', think: 'on', overall: 1.0, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'muse-glimmer:latest', think: 'on', overall: 0.992, tool: 0.97, extract: 1.0, source: '2026-08' },
  { tag: 'deepseek-v4-flash', think: 'on', overall: 0.991, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'nemotron-3-nano:30b', think: 'on', overall: 0.981, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'gemma4:26b', think: 'off', overall: 0.972, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'nemotron-3.5-lightning:latest', think: 'off', overall: 0.972, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'gpt-oss:20b', think: 'on', overall: 0.972, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3:32b', think: 'off', overall: 0.954, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3-coder:30b', think: 'none', overall: 0.951, tool: 1.0, extract: 0.92, source: '2026-08' },
  { tag: 'nemotron3:33b', think: 'on', overall: 0.943, tool: 0.96, extract: 1.0, source: '2026-08' },
  { tag: 'nemotron-cascade-2:30b', think: 'on', overall: 0.938, tool: 0.97, extract: 0.97, source: '2026-08' },
  { tag: 'nemotron-3-super:latest', think: 'on', overall: 0.928, tool: 1.0, extract: 0.97, source: '2026-08' },
  { tag: 'qwen3.6:35b', think: 'on', overall: 0.926, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3-coder-next:latest', think: 'none', overall: 0.889, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'qwen3.5:27b', think: 'off', overall: 0.889, tool: 1.0, extract: 1.0, source: '2026-08' },
  { tag: 'llama4:scout', think: 'none', overall: 0.889, tool: 0.86, extract: 0.92, source: '2026-08' },
  { tag: 'devstral:24b', think: 'none', overall: 0.858, tool: 0.99, extract: 1.0, source: '2026-08' },
  { tag: 'qwen2.5-coder:32b', think: 'none', overall: 0.848, tool: 0.5, extract: 1.0, source: '2026-08' },
  { tag: 'qwen2.5:72b', think: 'none', overall: 0.833, tool: 1.0, extract: 1.0, source: '2026-08' },
];

/** Utility-tier picks (router / NER / extraction): extraction ≥ 0.92 at any size. */
export const MEASURED_UTILITY: Array<{ tag: string; extract: number; note: string }> = [
  { tag: 'phi4', extract: 1.0, note: 'extraction 100%, no native tools — router/extraction only' },
  { tag: 'phi4-mini', extract: 0.92, note: 'extraction 92%, 3.8B — the smallest that holds' },
  { tag: 'qwen2.5:7b', extract: 1.0, note: 'extraction 100%' },
  { tag: 'llama3.1:8b', extract: 0.92, note: 'extraction 92%' },
];

const base = (tag: string) => tag.replace(/:latest$/, '').toLowerCase();

export function findMeasured(tag: string): MeasuredModel | undefined {
  const b = base(tag);
  return MEASURED.find(m => base(m.tag) === b)
    // a bare family name (`mistral`) matches the one measured default-size row (`mistral:7b`)
    ?? (b.includes(':') ? undefined : MEASURED.find(m => base(m.tag).split(':')[0] === b));
}

export interface RankedModel {
  name: string;
  sizeGb: number;
  fits: boolean;
  measured?: MeasuredModel;
  /** One line for the picker: score, thinking mode, fit. */
  label: string;
}

/** Memory a model may take: 85% of VRAM when there is a GPU, else 60% of RAM. */
export function memoryBudgetGb(memory: { totalGb: number; gpuVramGb?: number } | undefined): number | undefined {
  if (!memory) return undefined;
  return memory.gpuVramGb ? memory.gpuVramGb * 0.85 : memory.totalGb * 0.6;
}

/**
 * Rank the models a machine actually has for the FOREGROUND role: measured-and-fits by
 * score, then measured-but-too-big, then unmeasured that fit (largest first), then the
 * measured-but-below-floor (with their numbers), then the rest. Every entry carries a
 * label that says why it sits where it does.
 */
export function rankForeground(available: OllamaModel[], budgetGb?: number): RankedModel[] {
  const rows: RankedModel[] = available.map(m => {
    const sizeGb = m.size / 1e9;
    const measured = findMeasured(m.name);
    const fits = budgetGb === undefined ? true : sizeGb <= budgetGb;
    const score = !measured ? 'unmeasured'
      : measured.tool === 0 ? `measured ${Math.round(measured.overall * 100)}% — NO native tool calling on Ollama, utility only`
      : measured.overall < FOREGROUND_FLOOR ? `measured ${Math.round(measured.overall * 100)}% (tool ${Math.round(measured.tool * 100)}%) — below the ${FOREGROUND_FLOOR * 100}% floor`
      : `measured ${Math.round(measured.overall * 100)}% (tool ${Math.round(measured.tool * 100)}%), thinking ${measured.think}`;
    const fit = budgetGb === undefined ? '' : fits ? ' · fits' : ` · TOO BIG for ~${budgetGb.toFixed(0)}GB usable`;
    return { name: m.name, sizeGb, fits, measured, label: `${m.name}  ${sizeGb.toFixed(1)}GB · ${score}${fit}` };
  });
  const good = (r: RankedModel) => !!r.measured && r.measured.overall >= FOREGROUND_FLOOR;
  // measured-good & fits → measured-good too big → unmeasured & fits → measured-poor → the rest
  const tier = (r: RankedModel) => (good(r) && r.fits ? 0 : good(r) ? 1 : !r.measured && r.fits ? 2 : r.measured ? 3 : 4);
  // Ties on a measured score go to the SMALLER model (same result, more room for context and
  // a faster reload); among unmeasured models the larger one is the better bet.
  return rows.sort((a, b) => tier(a) - tier(b)
    || (b.measured?.overall ?? 0) - (a.measured?.overall ?? 0)
    || (a.measured && b.measured ? a.sizeGb - b.sizeGb : b.sizeGb - a.sizeGb));
}

/** Router/utility pick: a measured utility model present on the box, else the smallest model. */
export function pickUtility(available: OllamaModel[]): string | undefined {
  for (const u of MEASURED_UTILITY) {
    const hit = available.find(m => base(m.name) === u.tag || base(m.name).startsWith(`${u.tag}:`));
    if (hit) return hit.name;
  }
  return [...available].sort((a, b) => a.size - b.size)[0]?.name;
}

/** The `think:` value a specialist block should carry for a measured pick. */
export function thinkFor(measured: MeasuredModel | undefined): boolean | undefined {
  if (!measured || measured.think === 'none') return undefined;
  return measured.think !== 'off';
}
