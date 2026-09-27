import { runDoctor, formatDoctor } from './doctor.js';

const args = process.argv.slice(2);
const configIdx = args.indexOf('--config');
const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
const quiet = args.includes('--quiet');

const result = await runDoctor({ configPath, quiet });
if (!quiet) console.log('\nInvarail doctor\n');
console.log(formatDoctor(result.checks, { quiet }));
if (result.fails > 0) {
  console.log('\n  Fix the [FAIL] lines above, then run `npm run doctor` again.');
  process.exit(1);
}
if (!quiet) console.log('\n  Ready. `npm start` boots the agent.');
