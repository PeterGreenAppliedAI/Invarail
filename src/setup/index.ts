import { printHeader, closeRL, printInfo, printPass, printWarning, getRL } from './prompts.js';
import { detect } from './detect.js';
import { runOllamaStep } from './steps/ollama.js';
import { runModelsStep } from './steps/models.js';
import { runChannelsStep } from './steps/channels.js';
import { runServicesStep } from './steps/services.js';
import { runWorkspaceStep } from './steps/workspace.js';
import { runGenerateStep } from './steps/generate.js';
import { runPreflightStep } from './steps/preflight.js';
import { runTierStep, runStarterGenerate } from './steps/tier.js';

async function main(): Promise<void> {
  getRL(); // attach the line queue BEFORE any async probe, so piped answers are never lost
  printHeader('Invarail Setup Wizard');
  printInfo('This wizard will help you configure Invarail.');
  printInfo('Press Enter to accept defaults shown in [brackets].\n');

  try {
    // Detect first, ask second: what is installed and reachable decides which questions
    // are worth asking at all (2026-09-27 — the wizard used to ask ~30 questions most of
    // which had a detectable answer).
    printInfo('--- Looking around ---');
    const report = await detect();
    const mark = (ok: boolean, label: string, detail?: string, install?: string) => {
      if (ok) printPass(`${label}${detail ? ` — ${detail}` : ''}`);
      else { printWarning(`${label}${detail ? ` — ${detail}` : ''}`); if (install) printInfo(`       install: ${install}`); }
    };
    mark(report.node.ok, `Node v${report.node.version}`, undefined, 'Node 22+ from https://nodejs.org');
    mark(report.ollama.reachable, 'Ollama', report.ollama.reachable ? `${report.ollama.models.length} model(s)` : `not reachable at ${report.ollama.url}`, report.ollama.install);
    mark(report.docker.found, 'Docker', report.docker.detail, report.docker.install);
    mark(report.falkordb.reachable, 'FalkorDB (graph memory)', report.falkordb.reachable ? 'running' : 'not running — optional, the wizard can start it');
    mark(report.libreoffice.found, 'LibreOffice (documents, research PDFs)', report.libreoffice.detail, report.libreoffice.install);
    mark(report.python.found, 'Python + matplotlib/pandas (research charts)', report.python.detail, report.python.install);
    console.log('');

    // Step 0: Tier — Starter short-circuits the full wizard
    const tier = await runTierStep();

    // Step 1: Ollama
    const ollama = await runOllamaStep(report);

    if (tier === 'starter') {
      await runStarterGenerate(ollama.models, report);
      return;
    }

    // Step 2: Models
    const models = await runModelsStep(ollama.models, report);

    // Step 3: Channels
    const channels = await runChannelsStep();

    // Step 4: Services
    const enabledChannels = Object.entries(channels)
      .filter(([k, v]) => k !== 'ownerId' && k !== 'trustedUsers' && typeof v === 'object' && 'enabled' in v && v.enabled)
      .map(([k]) => k);
    const services = await runServicesStep(ollama.models, enabledChannels, report);

    // Step 5: Workspace files (SOUL.md, USER.md, etc.)
    const workspace = await runWorkspaceStep();

    // Step 6: Generate .env + config
    const generated = await runGenerateStep({ ollama, models, channels, services });

    // Step 7: Preflight
    await runPreflightStep({ ollama, models, channels, services, generated });

    console.log('');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      // User closed stdin (Ctrl+D)
      console.log('\n\nSetup cancelled.');
    } else {
      console.error('\nSetup failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    closeRL();
  }
}

main();
