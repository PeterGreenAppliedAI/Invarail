import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { MemoryCapture, type MemoryCaptureDeps } from '../../src/services/memory-capture.js';
import type { InvarailConfig, FactInput } from '../../src/config/types.js';
import type { ConversationTurn } from '../../src/sessions/types.js';

const testDir = '/tmp/invarail-test-capture-' + Date.now();

function turns(n: number, role: ConversationTurn['role'] = 'user'): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role,
    content: `turn ${i}`,
    timestamp: new Date().toISOString(),
  })) as ConversationTurn[];
}

/** Alternating user/assistant — the realistic shape. */
function conversation(n: number): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
    timestamp: new Date().toISOString(),
  })) as ConversationTurn[];
}

function makeCapture(over: Partial<MemoryCaptureDeps> & { captureCfg?: Record<string, unknown> } = {}) {
  const written: FactInput[] = [];
  const extract = over.extract ?? vi.fn(async () => [{ text: 'Peter uses a 3060' }] as FactInput[]);
  const factStore = {
    loadRecentlyRemoved: () => [],
    writeFactsBatch: async (inputs: FactInput[]) => { written.push(...inputs); return inputs.map(i => ({ ...i })); },
    rebuildFacts: () => undefined,
  };
  const deps: MemoryCaptureDeps = {
    config: { memory: { capture: over.captureCfg ?? {} } } as unknown as InvarailConfig,
    factStore: () => factStore as never,
    graphMemory: () => undefined,
    loadTranscript: over.loadTranscript ?? (() => conversation(10)),
    extract: extract as MemoryCaptureDeps['extract'],
    workspacePathFor: () => testDir,
  };
  return { capture: new MemoryCapture(deps), written, extract };
}

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
});

describe('MemoryCapture trigger', () => {
  it('does not fire below the turn threshold', async () => {
    const { capture, extract } = makeCapture({ loadTranscript: () => conversation(6) });
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('fires once the threshold is reached, and not again until more turns land', async () => {
    let transcript = conversation(10);
    const { capture, extract } = makeCapture({ loadTranscript: () => transcript });

    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);

    // Same transcript — the window is already consumed.
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).toHaveBeenCalledTimes(1);

    // Eight more turns re-arms it.
    transcript = conversation(18);
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(1);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('stamps captured facts observed — a mid-conversation grab is never the owner confirming', async () => {
    const { capture, written } = makeCapture();
    await capture.maybeCapture('main', 's1', 'peter');
    expect(written).toHaveLength(1);
    expect(written[0].provenance).toBe('observed');
  });

  it('advances the marker when extraction finds nothing, so the window is not re-sent forever', async () => {
    const extract = vi.fn(async () => [] as FactInput[]);
    const { capture } = makeCapture({ extract: extract as never });
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('consumes an assistant-heavy window without calling the model', async () => {
    // 10 turns, only one from the user: not worth a model call, but the turns
    // must still be marked read or every later message re-triggers.
    const transcript = [...turns(1, 'user'), ...turns(9, 'assistant')];
    const { capture, extract } = makeCapture({ loadTranscript: () => transcript });
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('rewinds after !reset instead of waiting for the new session to pass the old count', async () => {
    let transcript = conversation(20);
    const { capture, extract } = makeCapture({ loadTranscript: () => transcript });
    await capture.maybeCapture('main', 's1', 'peter');
    expect(extract).toHaveBeenCalledTimes(1);

    transcript = conversation(2);           // session cleared
    await capture.maybeCapture('main', 's1', 'peter');
    expect(extract).toHaveBeenCalledTimes(1); // rewound, below threshold

    transcript = conversation(10);          // fresh conversation grows
    await capture.maybeCapture('main', 's1', 'peter');
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('does not stack runs for one session while a capture is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const extract = vi.fn(async () => { await gate; return [{ text: 'x' }] as FactInput[]; });
    const { capture } = makeCapture({ extract: extract as never });

    const first = capture.maybeCapture('main', 's1', 'peter');
    const second = await capture.maybeCapture('main', 's1', 'peter');
    expect(second).toBe(0);
    expect(extract).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('honors the config gate', async () => {
    const { capture, extract } = makeCapture({ captureCfg: { enabled: false } });
    expect(await capture.maybeCapture('main', 's1', 'peter')).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('bounds a hung extraction and releases the in-flight guard', async () => {
    const extract = vi.fn(() => new Promise<FactInput[]>(() => undefined));
    const { capture } = makeCapture({ extract: extract as never, captureCfg: { timeoutMs: 40 } });
    await expect(capture.maybeCapture('main', 's1', 'peter')).rejects.toThrow(/timed out/);
    // Guard released — a later call is allowed to try again.
    const { capture: c2, extract: e2 } = makeCapture();
    expect(await c2.maybeCapture('main', 's2', 'peter')).toBe(1);
    expect(e2).toHaveBeenCalledTimes(1);
  });

  it('schedule() never throws into the caller', async () => {
    const extract = vi.fn(async () => { throw new Error('model down'); });
    const { capture } = makeCapture({ extract: extract as never });
    expect(() => capture.schedule('main', 's1', 'peter')).not.toThrow();
    await new Promise(r => setTimeout(r, 20));
  });
});
