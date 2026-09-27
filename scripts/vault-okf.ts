/**
 * Bring an existing vault (your Obsidian folder) onto the Open Knowledge Format IN PLACE:
 * notes without a `type` get front matter (type, title, a description read off the first
 * paragraph); bodies are never touched; reserved index.md/log.md and dot-folders are skipped.
 *
 * Reports by default. Nothing is written without --apply.
 *
 *   npm run vault:okf                 # what would change
 *   npm run vault:okf -- --apply      # write the front matter
 *   npm run vault:okf -- --apply --type=Note --path=/path/to/vault
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config/loader.js';
import { convertVaultToOkf, writeIndexesReport } from '../src/knowledge/okf.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const apply = argv.includes('--apply');
let vaultPath = flag('path');
if (!vaultPath) {
  try { vaultPath = loadConfig('invarail.config.json5').vault.path; } catch { vaultPath = 'vault'; }
}
if (!existsSync(vaultPath)) { console.error(`No vault at ${vaultPath} (set vault.path, or --path=...)`); process.exit(2); }

const report = convertVaultToOkf(vaultPath, { apply, type: flag('type') });
if (report.candidates.length === 0) {
  console.log(`${vaultPath}: every note already carries OKF front matter.`);
} else if (!apply) {
  console.log(`${vaultPath}: ${report.candidates.length} note(s) without a \`type\` — front matter would be ADDED (bodies untouched):`);
  for (const f of report.candidates) console.log(`  ${f}`);
  console.log('\nRe-run with --apply to write it.');
} else {
  console.log(`${vaultPath}: added front matter to ${report.converted.length} note(s).`);
  const idx = writeIndexesReport(vaultPath);
  console.log(`index.md written in ${idx.written.length} folder(s)${idx.skipped.length ? `; left alone (yours): ${idx.skipped.join(', ')}` : ''}.`);
}
