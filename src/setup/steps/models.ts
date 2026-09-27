import { askText, askYesNo, printStep, printSuccess, printInfo } from '../prompts.js';
import { pickRouterModel, SPECIALIST_TEMPLATES } from '../defaults.js';
import { rankForeground, memoryBudgetGb, findMeasured, thinkFor, foregroundTier, type ForegroundTier } from '../measured-models.js';
import type { OllamaModel } from '../../ollama/types.js';
import type { DetectReport } from '../detect.js';

export interface ModelsStepResult {
  routerModel: string;
  specialistModel: string;
  /** Per-category model overrides. Categories not listed use specialistModel. */
  categoryModels: Record<string, string>;
  /** OpenAI-compatible backends (e.g. vLLM). Chat calls whose model matches route here. */
  inferenceBackends: Array<{ url: string; models: string[] }>;
  /** Model for background reasoning (briefing + heartbeat). Defaults to specialistModel. */
  backgroundModel: string;
  /** `think:` for the foreground specialists when the pick is a measured model (undefined = leave the engine default). */
  specialistThink?: boolean;
  /** Prompt profile + context size the generated config carries for this foreground model. */
  foregroundTier?: ForegroundTier;
}

export async function runModelsStep(models: OllamaModel[], report?: DetectReport): Promise<ModelsStepResult> {
  printStep(2, 7, 'Model Selection');

  const modelNames = models.map(m => m.name);
  const budget = memoryBudgetGb(report?.memory);

  // Router model
  const suggestedRouter = pickRouterModel(models) ?? 'phi4-mini';
  printInfo(`Suggested router model: ${suggestedRouter}`);
  const routerModel = await askText('Router model', suggestedRouter);
  printSuccess(`Router model: ${routerModel}`);

  // Foreground model — ranked by the eval boards and by what fits this machine.
  const ranked = rankForeground(models, budget);
  if (ranked.length) {
    printInfo(`Models on this box, ranked by the evals${budget ? ` and fit (~${budget.toFixed(0)}GB usable)` : ''}:`);
    for (const r of ranked.slice(0, 8)) printInfo(`  - ${r.label}`);
  }
  const suggestedSpecialist = ranked[0]?.name ?? 'qwen3.5:9b';
  const specialistModel = await askText('Foreground model (chat + every specialist)', suggestedSpecialist);
  const measured = findMeasured(specialistModel);
  const specialistThink = thinkFor(measured);
  const pickedSize = models.find(m => m.name === specialistModel)?.size;
  const tier = foregroundTier(specialistModel, pickedSize ? pickedSize / 1e9 : undefined);
  printInfo(`Prompt profile: ${tier}${tier === 'small' ? ' — a ≤14B foreground gets the minimal workspace set and a 16K context' : ''}`);
  printSuccess(`Foreground model: ${specialistModel}${measured ? ` (measured ${Math.round(measured.overall * 100)}%, thinking ${measured.think})` : ' (unmeasured — run scripts/model-eval.ts on it)'}`);

  // OpenAI-compatible backends (vLLM) — for large models like MiniMax served outside Ollama.
  // The specialist model can point at a backend model id; calls matching it route there.
  const inferenceBackends: Array<{ url: string; models: string[] }> = [];
  const addBackend = await askYesNo('Add an OpenAI-compatible backend (e.g. vLLM for a large model)?', false);
  if (addBackend) {
    let more = true;
    while (more) {
      const url = await askText('  Backend URL (OpenAI-compatible, e.g. http://10.9.8.15:8000)', 'http://localhost:8000');
      const modelsCsv = await askText('  Model id(s) served here (comma-separated, e.g. cyankiwi/MiniMax-M2.7-AWQ-4bit)', specialistModel);
      const backendModels = modelsCsv.split(',').map(m => m.trim()).filter(Boolean);
      inferenceBackends.push({ url, models: backendModels });
      printSuccess(`  Backend ${url} → ${backendModels.join(', ')}`);
      more = await askYesNo('  Add another backend?', false);
    }
  }

  // Per-category overrides
  const categoryModels: Record<string, string> = {};
  const sameModelForAll = await askYesNo('Use same specialist model for all categories?', true);

  if (sameModelForAll) {
    printInfo(`All specialist categories will use: ${specialistModel}`);
  } else {
    printInfo('Configure model per category (Enter to keep default):');
    if (modelNames.length) {
      printInfo(`Available: ${modelNames.join(', ')}`);
    }
    for (const category of Object.keys(SPECIALIST_TEMPLATES)) {
      const chosen = await askText(`  ${category}`, specialistModel);
      if (chosen !== specialistModel) {
        categoryModels[category] = chosen;
        printSuccess(`  ${category}: ${chosen}`);
      }
    }
    const overrideCount = Object.keys(categoryModels).length;
    if (overrideCount) {
      printInfo(`${overrideCount} category override(s) set, rest use: ${specialistModel}`);
    } else {
      printInfo(`No overrides — all categories use: ${specialistModel}`);
    }
  }

  // Background reasoning model (briefing + heartbeat) — defaults to the specialist model
  const backgroundModel = await askText('Model for background jobs (briefing + heartbeat)', specialistModel);
  printSuccess(`Background jobs model: ${backgroundModel}`);

  return { routerModel, specialistModel, categoryModels, inferenceBackends, backgroundModel, specialistThink, foregroundTier: tier };
}
