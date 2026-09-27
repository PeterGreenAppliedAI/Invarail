import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';

/**
 * Prompt helpers for the wizard. Lines are QUEUED: readline emits a 'line' for every
 * newline it sees whether or not a question is pending, so answers piped in ahead of
 * time (`printf '1\n\ny\n' | npm run setup`, a CI smoke, an automation) used to be
 * dropped on the floor and the wizard died with ERR_USE_AFTER_CLOSE at the next
 * question (2026-09-27). Now every line lands in a queue and `ask()` takes the next.
 */
let rl: Interface | null = null;
const queue: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let closed = false;

function closedError(): NodeJS.ErrnoException {
  const err = new Error('stdin closed') as NodeJS.ErrnoException;
  err.code = 'ERR_USE_AFTER_CLOSE';
  return err;
}

export function getRL(): Interface {
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout, terminal: false });
    rl.on('line', line => {
      if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line);
    });
    rl.on('close', () => {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w(null); }
    });
  }
  return rl;
}

export function closeRL(): void {
  rl?.close();
  rl = null;
  queue.length = 0;
  waiting = null;
  closed = false;
}

async function ask(promptText: string): Promise<string> {
  getRL();
  stdout.write(promptText);
  if (queue.length > 0) {
    const line = queue.shift()!;
    stdout.write(`${line}\n`);   // echo the pre-supplied answer so transcripts read naturally
    return line;
  }
  if (closed) throw closedError();
  const line = await new Promise<string | null>(resolve => { waiting = resolve; });
  if (line === null) throw closedError();
  return line;
}

export async function askText(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await ask(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue || '';
}

export async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${prompt} ${hint}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

export async function askChoice(prompt: string, choices: string[]): Promise<string> {
  console.log(`\n${prompt}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  const answer = (await ask('  Choice: ')).trim();
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) return choices[idx];
  // Try matching by text
  const match = choices.find(c => c.toLowerCase().startsWith(answer.toLowerCase()));
  return match ?? choices[0];
}

export function printHeader(text: string): void {
  const line = '='.repeat(text.length + 4);
  console.log(`\n${line}\n  ${text}\n${line}\n`);
}

export function printStep(step: number, total: number, text: string): void {
  console.log(`\n--- Step ${step}/${total}: ${text} ---\n`);
}

export function printSuccess(text: string): void { console.log(`  [OK] ${text}`); }
export function printWarning(text: string): void { console.log(`  [WARN] ${text}`); }
export function printError(text: string): void { console.log(`  [FAIL] ${text}`); }
export function printInfo(text: string): void { console.log(`  ${text}`); }
export function printPass(text: string): void { console.log(`  [PASS] ${text}`); }
