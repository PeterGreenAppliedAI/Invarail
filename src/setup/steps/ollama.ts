import { askText, askYesNo, printStep, printSuccess, printError, printWarning, printInfo } from '../prompts.js';
import { testOllama, runInstallArgs } from '../connectivity.js';
import type { OllamaModel } from '../../ollama/types.js';
import type { DetectReport } from '../detect.js';

/** The model the starter tier assumes; small enough for an 8GB machine. */
export const RECOMMENDED_FIRST_MODEL = 'qwen3:8b';

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
    if (await askYesNo(`Pull ${RECOMMENDED_FIRST_MODEL} now (a capable general model, ~5GB)?`, true)) {
      printInfo(`Running: ollama pull ${RECOMMENDED_FIRST_MODEL}`);
      if (runInstallArgs('ollama', ['pull', RECOMMENDED_FIRST_MODEL])) {
        result = await testOllama(url);
        printSuccess(`Pulled ${RECOMMENDED_FIRST_MODEL}`);
      } else {
        printError(`Pull failed — run it yourself: ollama pull ${RECOMMENDED_FIRST_MODEL}`);
      }
    } else {
      printInfo(`Later: ollama pull ${RECOMMENDED_FIRST_MODEL}`);
    }
  }

  return { url, models: result.models };
}
