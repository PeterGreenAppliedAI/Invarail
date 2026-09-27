import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContract, buildContractHook, wrapAnswerHonestly, type CompletionContract } from '../../src/contracts/completion-contract.js';

// Re-review N07: a verifier that THREW was counted as a pass — "file_contains" against a
// directory passed existsSync, threw on readFileSync, and the answer went out unqualified.
describe('verifier exceptions are unknown outcomes, never passes', () => {
  const ws = mkdtempSync(join(tmpdir(), 'contract-'));
  mkdirSync(join(ws, 'out'));   // a DIRECTORY where a file is expected
  const contract = { checkable: true, postconditions: [{ kind: 'file_contains', path: 'out', pattern: 'done' }] } as unknown as CompletionContract;
  const deps = { workspacePath: ws, senderId: 'peter', answer: 'All done!' } as any;

  it('checkContract reports could-not-verify, not pass', () => {
    const r = checkContract(contract, deps);
    expect(r.pass).toBe(false);
    expect(r.failed[0].errored).toBe(true);
    expect(r.failed[0].detail).toMatch(/could not verify/);
  });

  it('the hook does not send the model back for our own error, and the honest wrap carries the caveat', async () => {
    const hook = buildContractHook(contract, deps);
    expect(await hook('All done!', [], 'natural')).toEqual({ accept: true });
    const wrapped = wrapAnswerHonestly('All done!', checkContract(contract, deps).failed);
    expect(wrapped).toMatch(/could not verify/);
    expect(wrapped).toMatch(/All done!/);
  });
});
