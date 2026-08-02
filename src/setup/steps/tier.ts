import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { askChoice, askYesNo, printHeader, printInfo, printSuccess, printWarning } from '../prompts.js';

export type SetupTier = 'starter' | 'custom';

/** First wizard question: how much system do you want? */
export async function runTierStep(): Promise<SetupTier> {
  printHeader('Setup style');
  printInfo('Starter — one model, web console only, nothing else to install (~15 min)');
  printInfo('Custom  — pick channels, models, and services yourself (full wizard)\n');
  const choice = await askChoice('How do you want to run LocalClaw?', ['Starter', 'Custom']);
  return choice.toLowerCase() as SetupTier;
}

/**
 * Starter short-circuit: verify Ollama, pick ONE model for every slot, write
 * the preset. The preset file is the source of truth — this only swaps the
 * model name, so preset and wizard can never drift apart.
 */
export async function runStarterGenerate(models: string[]): Promise<void> {
  const model = models.length > 0
    ? await askChoice('Which model should do everything?', models)
    : 'qwen3:8b';
  if (models.length === 0) {
    printWarning('No models found in Ollama — defaulting to qwen3:8b. Pull it with: ollama pull qwen3:8b');
  }

  let template = readFileSync('localclaw.config.starter.json5', 'utf-8');
  template = template.replaceAll('qwen3:8b', model);

  let configPath = 'localclaw.config.json5';
  if (existsSync(configPath)) {
    printWarning('localclaw.config.json5 already exists');
    const overwrite = await askYesNo('Overwrite localclaw.config.json5?', false);
    if (!overwrite) configPath = 'localclaw.config.json5.starter';
  }
  writeFileSync(configPath, template, 'utf-8');

  printSuccess(`Wrote ${configPath} (model: ${model})`);
  printInfo('\nNext steps:');
  printInfo('  npm start          → open http://localhost:3100');
  printInfo('  INSTALL.md         → the upgrade ladder (search, channels, memory graph, exec)');
  printInfo('  docker compose up  → graph memory + web search sidecars (Tier 1)');
}
