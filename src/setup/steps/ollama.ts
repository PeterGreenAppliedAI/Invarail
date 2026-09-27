import { askText, askYesNo, printStep, printSuccess, printError, printWarning, printInfo } from '../prompts.js';
import { testOllama, runInstallArgs } from '../connectivity.js';
import type { OllamaModel } from '../../ollama/types.js';
import type { DetectReport } from '../detect.js';

/** The starter model: the measured floor for native tool use (92% on the harness battery,
 *  evals/2026-09-small-tier) at 7.6GB. On an 8GB machine the wizard suggests qwen2.5:7b. */
export const RECOMMENDED_FIRST_MODEL = 'gemma4:12b';
export const RECOMMENDED_SMALL_MODEL = 'qwen2.5:7b';

export interface OllamaStepResult {
  url: string;
  models: OllamaModel[];
}

export async function runOllamaStep(report?: DetectReport): Promise<OllamaStepResult> {
  printStep(1, 7, 'Ollama Connection');

  const defaultUrl = report?.ollama.url ?? 'http://127.0.0.1:11434';
  printInfo(`Testing Ollama at ${defaultUrl}...`);

  let url = defaultUrl;
  let result = await testOllama(defaultUrl);

  if (result.available) {
    printSuccess(`Ollama is reachable at ${defaultUrl}`);
  } else {
    printWarning(`Ollama not found at ${defaultUrl}`);
    const customUrl = await askText('Enter Ollama URL', defaultUrl);
    url = customUrl;
    if (customUrl !== defaultUrl) {
      printInfo(`Testing Ollama at ${customUrl}...`);
      result = await testOllama(customUrl);
      if (result.available) {
        printSuccess(`Ollama is reachable at ${customUrl}`);
      } else {
        printError(`Ollama not reachable at ${customUrl}`);
        printInfo('Continuing anyway — you can fix the URL in the config later.');
        return { url: customUrl, models: [] };
      }
    } else {
      printInfo('Continuing anyway — make sure Ollama is running before starting Invarail.');
      return { url: defaultUrl, models: [] };
    }
  }

  if (result.models.length > 0) {
    printInfo(`Found ${result.models.length} model(s):`);
    for (const m of result.models) {
      const sizeMB = Math.round(m.size / 1024 / 1024);
      printInfo(`  - ${m.name} (${sizeMB} MB)`);
    }
  } else {
    printWarning('No models found in Ollama.');
    // Offer, never silently install: this pulls several GB.
    const totalGb = report?.memory.totalGb ?? 0;
    const pick = totalGb > 0 && totalGb < 12 ? RECOMMENDED_SMALL_MODEL : RECOMMENDED_FIRST_MODEL;
    const why = pick === RECOMMENDED_SMALL_MODEL ? `this machine has ${totalGb.toFixed(0)}GB — the 7B fits; the 12B would not` : 'the measured floor for tool use, ~7.6GB';
    if (await askYesNo(`Pull ${pick} now (${why})?`, true)) {
      printInfo(`Running: ollama pull ${pick}`);
      if (runInstallArgs('ollama', ['pull', pick])) {
        result = await testOllama(url);
        printSuccess(`Pulled ${pick}`);
      } else {
        printError(`Pull failed — run it yourself: ollama pull ${pick}`);
      }
    } else {
      printInfo(`Later: ollama pull ${pick}`);
    }
  }

  return { url, models: result.models };
}
