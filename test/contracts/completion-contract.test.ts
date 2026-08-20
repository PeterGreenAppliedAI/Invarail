import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractContract, checkContract, contractFeedback, wrapAnswerHonestly,
  type CompletionContract,
} from '../../src/contracts/completion-contract.js';
import type { OllamaClient } from '../../src/ollama/client.js';

function clientReturning(json: unknown): OllamaClient {
  return {
    chat: vi.fn(async () => ({ message: { role: 'assistant', content: JSON.stringify(json) } })),
  } as unknown as OllamaClient;
}

describe('extractContract', () => {
  it('parses a checkable contract and drops unknown kinds (closed vocabulary)', async () => {
    const client = clientReturning({
      checkable: true,
      postconditions: [
        { kind: 'file_contains', path: 'notes/x.md', pattern: 'v0.5.17' },
        { kind: 'task_exists', pattern: 'evaluate' },
        { kind: 'summon_demon', pattern: 'asmodeus' },        // dropped
        { kind: 'file_exists' },                               // missing path → dropped
      ],
    });
    const c = await extractContract(client, 'm', 'do the thing');
    expect(c.checkable).toBe(true);
    expect(c.postconditions).toHaveLength(2);
    expect(c.postconditions.map(p => p.kind)).toEqual(['file_contains', 'task_exists']);
  });

  it('chat-shaped asks → checkable:false, and garbage output → no gate', async () => {
    const chatty = await extractContract(clientReturning({ checkable: false, postconditions: [] }), 'm', 'how are you?');
    expect(chatty.checkable).toBe(false);
    const garbage = await extractContract(clientReturning('not even json' as never), 'm', 'x');
    expect(garbage.checkable).toBe(false);
    expect(garbage.postconditions).toEqual([]);
  });

  it('checkable:true with zero valid conditions degrades to unchecked', async () => {
    const c = await extractContract(clientReturning({ checkable: true, postconditions: [{ kind: 'nope' }] }), 'm', 'x');
    expect(c.checkable).toBe(false);
  });
});

describe('checkContract', () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'contract-')); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const contract = (pcs: CompletionContract['postconditions']): CompletionContract =>
    ({ checkable: true, postconditions: pcs });

  it('file predicates check the real filesystem', () => {
    mkdirSync(join(ws, 'notes'));
    writeFileSync(join(ws, 'notes', 'x.md'), '# Release v0.5.17\nRust frontend rework\n');
    const r = checkContract(contract([
      { kind: 'file_exists', path: 'notes/x.md' },
      { kind: 'file_contains', path: 'notes/x.md', pattern: 'v0.5.17' },
      { kind: 'file_contains', path: 'notes/x.md', pattern: 'quantum blockchain' },
      { kind: 'file_exists', path: 'ghost.txt' },
    ]), { workspacePath: ws, answer: '' });
    expect(r.results.map(x => x.pass)).toEqual([true, true, false, false]);
    expect(r.pass).toBe(false);
    expect(r.failed).toHaveLength(2);
  });

  it('placeholder spam fails a content pattern — the incident case', () => {
    writeFileSync(join(ws, 'note.md'), 'a'.repeat(200000));
    const r = checkContract(contract([{ kind: 'file_contains', path: 'note.md', pattern: 'SGLang' }]), { workspacePath: ws, answer: '' });
    expect(r.pass).toBe(false);
    expect(r.failed[0].detail).toContain('200000 chars');
  });

  it('task_exists and fact_saved consult the stores; answer_mentions reads the answer', () => {
    const taskStore = { list: () => [{ title: 'Evaluate SGLang v0.5.17' } as never] };
    const factStore = { loadFactsJson: () => [{ text: 'deployment freeze starts 2026-09-01' } as never] };
    const r = checkContract(contract([
      { kind: 'task_exists', pattern: 'evaluate sglang' },
      { kind: 'fact_saved', pattern: '2026-09-01' },
      { kind: 'answer_mentions', pattern: '/v0\\.5\\.\\d+/' },
      { kind: 'task_exists', pattern: 'water the plants' },
    ]), { workspacePath: ws, answer: 'Created a task for v0.5.17.', taskStore, factStore });
    expect(r.results.map(x => x.pass)).toEqual([true, true, true, false]);
  });

  it('missing stores fail those conditions, invalid regex degrades to substring, non-checkable passes vacuously', () => {
    const r = checkContract(contract([{ kind: 'task_exists', pattern: 'x' }]), { workspacePath: ws, answer: '' });
    expect(r.pass).toBe(false);
    expect(r.failed[0].detail).toContain('unavailable');
    writeFileSync(join(ws, 'f.txt'), 'literal /open( text');
    const bad = checkContract(contract([{ kind: 'file_contains', path: 'f.txt', pattern: '/open(/' }]), { workspacePath: ws, answer: '' });
    expect(bad.results[0].pass).toBe(true); // fell back to substring 'open('
    expect(checkContract({ checkable: false, postconditions: [] }, { workspacePath: ws, answer: '' }).pass).toBe(true);
  });
});

describe('feedback + honest wrap', () => {
  it('feedback lists deficits; wrap never reads as success', () => {
    const failed = [{ condition: { kind: 'file_exists' as const, path: 'x.md' }, pass: false, detail: 'x.md does not exist' }];
    expect(contractFeedback(failed)).toContain('x.md does not exist');
    expect(contractFeedback(failed)).toContain('not placeholders');
    const wrapped = wrapAnswerHonestly('I made a valiant attempt.', failed);
    expect(wrapped).toContain('could not verify completion');
    expect(wrapped).toContain('x.md does not exist');
    expect(wrapped).toContain('valiant attempt');
  });
});
