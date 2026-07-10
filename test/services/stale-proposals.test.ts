import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeStaleFactsForReview } from '../../src/services/heartbeat-service.js';
import type { FactStore } from '../../src/memory/fact-store.js';

function makeFactStore(texts: string[]): FactStore {
  return {
    loadFactsJson: vi.fn().mockReturnValue(texts.map((text, i) => ({ id: `f${i}`, text, category: 'context' }))),
  } as unknown as FactStore;
}

let pendingPath: string;
beforeEach(() => {
  pendingPath = join(mkdtempSync(join(tmpdir(), 'stale-')), 'heartbeat-pending.json');
});

const FACTS = Array.from({ length: 50 }, (_, i) => `The user fact number ${i} about topic ${i}`);

describe('proposeStaleFactsForReview guards (July 10 firehose incident)', () => {
  it('distrusts the ENTIRE batch when the model nominates too many', () => {
    const proposals = proposeStaleFactsForReview(FACTS.slice(0, 40), makeFactStore(FACTS), 'peter', pendingPath);
    expect(proposals).toEqual([]);
    expect(existsSync(pendingPath)).toBe(false); // nothing written, no user homework
  });

  it('caps surfaced proposals at 3 even for trusted batch sizes', () => {
    const proposals = proposeStaleFactsForReview(FACTS.slice(0, 6), makeFactStore(FACTS), 'peter', pendingPath);
    expect(proposals).toHaveLength(3);
  });

  it('never re-proposes a fact within the cooldown window', () => {
    const store = makeFactStore(FACTS);
    const first = proposeStaleFactsForReview([FACTS[0]], store, 'peter', pendingPath);
    expect(first).toHaveLength(1);
    const second = proposeStaleFactsForReview([FACTS[0]], store, 'peter', pendingPath);
    expect(second).toEqual([]);
  });

  it('positions align with the merged pending file', () => {
    proposeStaleFactsForReview([FACTS[0], FACTS[1]], makeFactStore(FACTS), 'peter', pendingPath);
    const pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    expect(pending.facts).toHaveLength(2);
    expect(pending.facts[0].text).toBe(FACTS[0]);
  });
});
