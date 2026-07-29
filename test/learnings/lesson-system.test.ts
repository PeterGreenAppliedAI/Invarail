import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonStore, LESSON_EVIDENCE_FLOOR, type Lesson } from '../../src/learnings/lesson-store.js';
import { harvestLessonCandidates, loadHarvestMarker, saveHarvestMarker } from '../../src/learnings/lesson-harvester.js';
import { synthesizeLessons } from '../../src/learnings/lesson-synthesis.js';
import { relevantLessonLines, upsertLessonEmbedding, findLessonBySimilarity } from '../../src/learnings/lesson-semantic.js';
import { ErrorLearningStore } from '../../src/learnings/error-store.js';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { setEmbeddingStoreForTests } from '../../src/skills/semantic.js';
import type { OllamaClient } from '../../src/ollama/client.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lessons-')); });
afterEach(() => {
  setEmbeddingStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    name: 'plan-pipeline-research-boundary',
    slug: 'plan-pipeline-research-boundary',
    description: 'Research-shaped requests exhaust the plan pipeline — route them to the research pipeline instead.',
    situation: 'multi-step research report requests',
    model: 'deepseek-v4-flash',
    evidenceCount: 1,
    created: '2026-07-29',
    lastConfirmed: '2026-07-29',
    triggers: [],
    tried: 'plan pipeline decomposition',
    happened: 'hit max iterations twice',
    boundary: 'Research-shaped requests exhaust the plan pipeline — route them to the research pipeline instead.',
    ...overrides,
  };
}

/** Deterministic fake embeddings keyed on content words. */
function fakeEmbedClient(): OllamaClient {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      const t = text.toLowerCase();
      if (t.includes('research') || t.includes('report')) return [[1, 0, 0.1]];
      return [[0, 1, 0]];
    }),
  } as unknown as OllamaClient;
}

describe('LessonStore', () => {
  it('round-trips frontmatter including model tag, tool, and body sections', () => {
    const store = new LessonStore(dir);
    store.save(makeLesson({ tool: 'web_search', triggers: ['make me a GPU report'] }));
    const loaded = store.get('plan-pipeline-research-boundary')!;
    expect(loaded.model).toBe('deepseek-v4-flash');
    expect(loaded.tool).toBe('web_search');
    expect(loaded.triggers).toEqual(['make me a GPU report']);
    expect(loaded.tried).toBe('plan pipeline decomposition');
    expect(loaded.boundary).toContain('research pipeline');
  });

  it('recordEvidence bumps count, updates lastConfirmed, dedupes triggers', () => {
    const store = new LessonStore(dir);
    store.save(makeLesson());
    store.recordEvidence('plan-pipeline-research-boundary', 'weekly market report please');
    store.recordEvidence('plan-pipeline-research-boundary', 'weekly market report please');
    const loaded = store.get('plan-pipeline-research-boundary')!;
    expect(loaded.evidenceCount).toBe(3);
    expect(loaded.triggers).toEqual(['weekly market report please']);
  });
});

describe('harvestLessonCandidates', () => {
  it('groups failure evidence with the right thresholds and advances the marker', () => {
    const metricsPath = join(dir, 'metrics.jsonl');
    const deadPath = join(dir, 'unrouted.jsonl');
    const t = (n: number) => `2026-07-29T10:0${n}:00.000Z`;
    const lines = [
      { timestamp: t(1), type: 'dispatch', category: 'multi', hitMaxIterations: true, messagePreview: 'deep research on X' },
      { timestamp: t(2), type: 'tool_call', tool: 'web_fetch', category: 'deepseek-v4-flash', success: false, error: 'HTTP 403 blocked' },
      { timestamp: t(3), type: 'tool_call', tool: 'web_fetch', category: 'deepseek-v4-flash', success: false, error: 'HTTP 403 blocked' },
      { timestamp: t(4), type: 'tool_call', tool: 'web_fetch', category: 'deepseek-v4-flash', success: false, error: 'HTTP 403 blocked' },
      { timestamp: t(5), type: 'tool_call', tool: 'exec', success: false, error: 'once only' }, // below threshold
      { timestamp: t(6), type: 'autonomous_action', action: 'confirmed:send_message', outcome: 'rejected', detail: 'send to discord:123' },
    ];
    writeFileSync(metricsPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(deadPath, JSON.stringify({ at: t(7), source: 'cron', detail: 'Daily News', error: 'timeout x3' }) + '\n');

    const { candidates, newestTimestamp } = harvestLessonCandidates({ metricsPath, deadLetterPath: deadPath, sinceTimestamp: '' });
    const kinds = candidates.map(c => c.kind).sort();
    expect(kinds).toEqual(['action_rejected', 'dead_letter', 'max_iterations', 'tool_failures']);
    expect(candidates.find(c => c.kind === 'tool_failures')!.count).toBe(3);
    expect(candidates.find(c => c.kind === 'max_iterations')!.contexts[0]).toBe('deep research on X');
    expect(newestTimestamp).toBe(t(7));

    // Marker round-trip: nothing new after advancing
    const markerPath = join(dir, 'marker.json');
    saveHarvestMarker(markerPath, newestTimestamp);
    const second = harvestLessonCandidates({ metricsPath, deadLetterPath: deadPath, sinceTimestamp: loadHarvestMarker(markerPath) });
    expect(second.candidates).toHaveLength(0);
  });
});

describe('synthesizeLessons', () => {
  function synthClient(responses: string[]): OllamaClient {
    let i = 0;
    return {
      chat: vi.fn().mockImplementation(async () => ({ message: { role: 'assistant', content: responses[Math.min(i++, responses.length - 1)] } })),
      embed: vi.fn().mockResolvedValue([[0, 1, 0]]),
    } as unknown as OllamaClient;
  }

  function writeFailureEvidence(): { metricsPath: string; deadLetterPath: string } {
    const metricsPath = join(dir, 'metrics.jsonl');
    const deadLetterPath = join(dir, 'unrouted.jsonl');
    writeFileSync(metricsPath, JSON.stringify({ timestamp: '2026-07-29T10:00:00.000Z', type: 'dispatch', category: 'multi', hitMaxIterations: true, messagePreview: 'research report on X' }) + '\n');
    writeFileSync(deadLetterPath, '');
    return { metricsPath, deadLetterPath };
  }

  it('saves a worth-keeping lesson at evidence:1 and advances the marker', async () => {
    const paths = writeFailureEvidence();
    const client = synthClient(['{"name": "multi-research-boundary", "situation": "research reports", "approach": "plan pipeline", "outcome": "max iterations", "boundary": "Route research reports to the research pipeline.", "worth_keeping": true}']);
    const result = await synthesizeLessons({ client, model: 'test', workspacePath: dir, ...paths });
    expect(result.newLessons).toEqual(['multi-research-boundary']);
    const saved = new LessonStore(dir).get('multi-research-boundary')!;
    expect(saved.evidenceCount).toBe(1);
    // Marker advanced → second run finds nothing
    const again = await synthesizeLessons({ client, model: 'test', workspacePath: dir, ...paths });
    expect(again.newLessons).toHaveLength(0);
  });

  it('worth_keeping:false is skipped', async () => {
    const paths = writeFailureEvidence();
    const client = synthClient(['{"name": "blip", "situation": "x", "boundary": "y", "worth_keeping": false}']);
    const result = await synthesizeLessons({ client, model: 'test', workspacePath: dir, ...paths });
    expect(result.newLessons).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('duplicate slug reinforces instead of minting a sibling', async () => {
    const paths = writeFailureEvidence();
    new LessonStore(dir).save(makeLesson({ slug: 'multi-research-boundary', name: 'multi-research-boundary' }));
    const client = synthClient(['{"name": "multi-research-boundary", "situation": "research reports", "boundary": "Route to research pipeline.", "worth_keeping": true}']);
    const result = await synthesizeLessons({ client, model: 'test', workspacePath: dir, ...paths });
    expect(result.reinforced).toEqual(['multi-research-boundary']);
    expect(result.newLessons).toHaveLength(0);
    expect(new LessonStore(dir).get('multi-research-boundary')!.evidenceCount).toBe(2);
  });
});

describe('lesson injection gates', () => {
  beforeEach(() => {
    setEmbeddingStoreForTests(new EmbeddingStore(join(dir, 'test-memory.db')));
  });

  it('evidence:1 lesson is indexed but NOT injected; evidence:2 goes live', async () => {
    const store = new LessonStore(dir);
    const client = fakeEmbedClient();
    store.save(makeLesson());
    await upsertLessonEmbedding(client, store.get('plan-pipeline-research-boundary')!);

    expect(await relevantLessonLines(client, store, 'make a research report')).toHaveLength(0);

    store.recordEvidence('plan-pipeline-research-boundary');
    expect((await relevantLessonLines(client, store, 'make a research report'))[0]).toContain('research pipeline');
  });

  it('archived lesson embeddings are pruned on lookup', async () => {
    const store = new LessonStore(dir);
    const client = fakeEmbedClient();
    store.save(makeLesson({ evidenceCount: 3 }));
    await upsertLessonEmbedding(client, store.get('plan-pipeline-research-boundary')!);
    store.archive('plan-pipeline-research-boundary');
    expect(await findLessonBySimilarity(client, store, 'research report')).toBeNull();
    expect(await relevantLessonLines(client, store, 'research report')).toHaveLength(0);
  });

  it('tool-tagged live lessons surface through findHints ahead of raw errors', () => {
    const store = new LessonStore(dir);
    store.save(makeLesson({ tool: 'web_fetch', evidenceCount: 2, description: 'Site X blocks fetches — use browser instead.' }));
    store.save(makeLesson({ slug: 'not-live', name: 'not-live', tool: 'web_fetch', evidenceCount: 1, description: 'Unproven hunch.' }));
    const errorStore = new ErrorLearningStore(dir);
    const hints = errorStore.findHints('web_fetch', { url: 'https://x.com' });
    expect(hints.some(h => h.includes('use browser instead'))).toBe(true);
    expect(hints.some(h => h.includes('Unproven hunch'))).toBe(false);
  });
});
