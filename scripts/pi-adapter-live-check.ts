/**
 * Live Pi adapter check — drives the REAL pi_build tool (SDK adapter, real
 * sglang backend) on the roman-numeral smoke build that verified the original
 * CLI-spawn implementation. Validates: files land in the build dir (cwd
 * scoping in-process), extractor lines present, metrics rows written,
 * session JSONL exists on disk.
 *
 * Run inside the `lab` tmux session (node from SSH = EHOSTUNREACH on LAN).
 * Usage: npx tsx scripts/pi-adapter-live-check.ts
 */
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createPiBuildTool } from '../src/tools/pi-build.js';
import type { ToolContext } from '../src/tools/types.js';

const config = loadConfig('invarail.config.json5');
if (!config.pi?.enabled) { console.error('pi is disabled in config'); process.exit(1); }

const workspace = mkdtempSync(join(tmpdir(), 'pi-live-check-'));
const ctx: ToolContext = { agentId: 'livecheck', sessionKey: 'livecheck', workspacePath: workspace } as ToolContext;
const tool = createPiBuildTool(config.pi);

const PROMPT = 'Build a Python CLI that converts integers (1-3999) to roman numerals and back. '
  + 'roman.py with to_roman(n) and from_roman(s), cli entry via argparse, and a test file. '
  + 'Run the tests with python3 and iterate until they pass.';

const start = Date.now();
const out = await tool.execute({ prompt: PROMPT, projectName: 'roman-live-check' }, ctx);
const secs = ((Date.now() - start) / 1000).toFixed(0);

console.log(`\n===== pi_build output (${secs}s) =====\n${out}\n`);

const dirMatch = out.match(/Project directory: (.+)/);
const sessMatch = out.match(/session: ([a-zA-Z0-9_-]+)/);
console.log('--- checks ---');
console.log(`extractor Project directory line: ${dirMatch ? 'OK' : 'MISSING'}`);
console.log(`extractor session line:           ${sessMatch ? 'OK' : 'MISSING'}`);
const projectDir = dirMatch?.[1]?.trim();
const hasRoman = projectDir ? existsSync(join(projectDir, 'roman.py')) : false;
console.log(`roman.py in build dir:            ${hasRoman ? 'OK' : 'MISSING'} (${projectDir})`);

const metrics = readFileSync('data/metrics.jsonl', 'utf-8').trim().split('\n');
const summary = metrics.map(l => JSON.parse(l)).filter(m => m.type === 'pi_session' && m.slug === 'roman-live-check').pop();
const events = metrics.map(l => JSON.parse(l)).filter(m => m.type === 'pi_session_event' && m.slug === 'roman-live-check');
console.log(`pi_session summary row:           ${summary ? 'OK' : 'MISSING'}`);
console.log(`pi_session_event rows:            ${events.length} (${[...new Set(events.map(e => e.event))].join(', ')})`);
console.log(`sessionFile recorded:             ${summary?.sessionFile ?? 'MISSING'}`);
console.log(`sessionFile exists on disk:       ${summary?.sessionFile && existsSync(summary.sessionFile) ? 'OK' : 'MISSING'}`);
console.log(`summary: ok=${summary?.ok} turns=${summary?.turns} toolCalls=${summary?.toolCalls} toolErrors=${summary?.toolErrors} durationMs=${summary?.durationMs}`);
