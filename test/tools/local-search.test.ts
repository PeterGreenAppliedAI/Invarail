import { describe, expect, it, vi } from 'vitest';
import { createLocalSearchTool, LOCAL_SEARCH_FLOOR } from '../../src/tools/local-search.js';
import type { EmbeddingStore } from '../../src/memory/embeddings.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { WebIndexService } from '../../src/webindex/service.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx = {} as ToolContext;

function makeTool(searchImpl: (emb: number[], k: number, floor: number, src: string) => Array<{ file: string; text: string; score: number }>) {
  const search = vi.fn(searchImpl);
  const tool = createLocalSearchTool({
    embeddings: { search } as unknown as EmbeddingStore,
    client: { embed: vi.fn(async () => [[0.1, 0.2]]) } as unknown as OllamaClient,
    embedModel: 'qwen3-embedding:8b',
    index: {
      docMeta: vi.fn(() => ({ title: 'Doc', publishedAt: new Date().toISOString(), fetchedAt: new Date().toISOString() })),
    } as unknown as WebIndexService,
    maxAgeDays: 90,
  });
  return { tool, search };
}

describe('local_search relevance floor', () => {
  it('passes the measured 0.65 floor to the embedding store — never the old 0.35', async () => {
    // 0.65 = measured on the real webindex corpus: off-domain tops out at 0.59, on-domain
    // starts at 0.70 (scripts/floor-measure.mts). The memory corpus's 0.52 did not transfer.
    const { tool, search } = makeTool(() => []);
    await tool.execute({ query: 'NYSE stock volatility' }, ctx);
    const floorArg = search.mock.calls[0][2];
    expect(floorArg).toBe(LOCAL_SEARCH_FLOOR);
    expect(floorArg).toBe(0.65);
  });

  it('below-floor queries return the explicit web_search fall-through message', async () => {
    // The store enforces the floor — an off-domain query yields zero chunks, and the tool
    // must SAY so (the research pipeline's ≥2-hit gate falls through on no URLs).
    const { tool } = makeTool(() => []);
    const out = await tool.execute({ query: 'stocks with volatility above 15' }, ctx);
    expect(out).toContain('No local index results');
    expect(out).toContain('web_search');
    expect(out).not.toMatch(/https?:\/\//); // no URLs → the hit-count gate cannot fire
  });

  it('above-floor results still rank and render', async () => {
    const { tool } = makeTool(() => [
      { file: 'https://example.com/a', text: 'relevant content', score: 0.7 },
    ]);
    const out = await tool.execute({ query: 'qwen release' }, ctx);
    expect(out).toContain('https://example.com/a');
  });
});
