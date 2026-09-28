import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCapture, type MemoryCaptureDeps } from '../../src/services/memory-capture.js';
import type { InvarailConfig, FactInput } from '../../src/config/types.js';
import type { ConversationTurn } from '../../src/sessions/types.js';

function conversation(n: number): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}`, timestamp: new Date().toISOString() })) as ConversationTurn[];
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function make(extract: MemoryCaptureDeps['extract']) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-race-'));
  const written: FactInput[] = [];
  const deps: MemoryCaptureDeps = {
    config: { memory: { capture: {} } } as unknown as InvarailConfig,
    factStore: () => ({ loadRecentlyRemoved: () => [], writeFactsBatch: async (f: FactInput[]) => { written.push(...f); return f; }, rebuildFacts: () => undefined }) as never,
    graphMemory: () => undefined,
    loadTranscript: () => conversation(10),
    extract,
    workspacePathFor: () => dir,
  };
  const state = () => JSON.parse(readFileSync(join(dir, 'memory', 'capture-state.json'), 'utf-8'));
  return { capture: new MemoryCapture(deps), written, state };
}

// Re-review N03/N04 (2026-09-27): the whole state file was loaded before the await and
// written back after — two sessions' captures clobbered each other, and a reset during a
// capture was undone when the old extraction finished.
describe('MemoryCapture under concurrency and reset', () => {
  it('two sessions capturing at once both keep their records', async () => {
    const a = deferred<FactInput[]>(); const b = deferred<FactInput[]>();
    const extract: MemoryCaptureDeps['extract'] = async (t) => (t[0].content === 'turn 0' && !a.settled ? (a.settled = true, a.promise) : b.promise);
    (a as any).settled = false;
    const { capture, state } = make(extract);
    const pA = capture.maybeCapture('main', 'sA', 'peter');
    const pB = capture.maybeCapture('main', 'sB', 'peter');
    a.resolve([{ text: 'fact A' } as FactInput]); await pA;
    b.resolve([{ text: 'fact B' } as FactInput]); await pB;
    const s = state();
    expect(s.sA.captured.map((c: any) => c.text)).toEqual(['fact A']);
    expect(s.sB.captured.map((c: any) => c.text)).toEqual(['fact B']);
  });

  it('a capture that started before a reset drops its result and does not recreate the marker', async () => {
    const d = deferred<FactInput[]>();
    const { capture, written, state } = make(async () => d.promise);
    const p = capture.maybeCapture('main', 's1', 'peter');
    const tail = capture.takeSessionTail('main', 's1', conversation(10));   // the !reset
    expect(tail.captured).toEqual([]);
    d.resolve([{ text: 'stale fact' } as FactInput]);
    expect(await p).toBe(0);
    expect(written).toEqual([]);
    expect(state().s1).toBeUndefined();
  });
});

describe('reset during the WRITE (third review N04)', () => {
  it('facts already written stay, but the marker for the reset conversation is not recreated', async () => {
    const gate = deferred<void>();
    const dir = mkdtempSync(join(tmpdir(), 'capture-race-'));
    const written: FactInput[] = [];
    const deps: MemoryCaptureDeps = {
      config: { memory: { capture: {} } } as unknown as InvarailConfig,
      factStore: () => ({ loadRecentlyRemoved: () => [], writeFactsBatch: async (f: FactInput[]) => { await gate.promise; written.push(...f); return f; }, rebuildFacts: () => undefined }) as never,
      graphMemory: () => undefined,
      loadTranscript: () => conversation(10),
      extract: async () => [{ text: 'observed before reset' } as FactInput],
      workspacePathFor: () => dir,
    };
    const capture = new MemoryCapture(deps);
    const p = capture.maybeCapture('main', 's1', 'peter');
    await new Promise(r => setTimeout(r, 20));           // extraction done, write suspended
    capture.takeSessionTail('main', 's1', conversation(10));   // the !reset lands mid-write
    gate.resolve();
    expect(await p).toBe(1);                             // the fact was observed and kept
    const state = JSON.parse(readFileSync(join(dir, 'memory', 'capture-state.json'), 'utf-8'));
    expect(state.s1).toBeUndefined();                    // no marker for a conversation that no longer exists
  });
});
