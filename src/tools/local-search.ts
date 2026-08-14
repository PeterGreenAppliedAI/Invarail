import type { InvarailTool } from './types.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';
import type { WebIndexService } from '../webindex/service.js';

/** Recency weighting: fresh docs matter more for a news-shaped index.
 *  Half-life ~14 days on top of cosine similarity; undated docs get a mild
 *  penalty rather than exclusion. */
function recencyBoost(publishedAt: string | null | undefined, now: number): number {
  if (!publishedAt) return 0.85;
  const ageDays = (now - new Date(publishedAt).getTime()) / 86_400_000;
  if (isNaN(ageDays) || ageDays < 0) return 0.85;
  return Math.pow(0.5, ageDays / 14) * 0.4 + 0.6; // 1.0 fresh → 0.6 floor
}

export function createLocalSearchTool(deps: {
  embeddings: EmbeddingStore;
  client: OllamaClient;
  embedModel: string;
  index: WebIndexService;
  maxAgeDays: number;
}): InvarailTool {
  return {
    name: 'local_search',
    description: 'Search the LOCAL web index — a curated, continuously-refreshed archive of AI/tech sources with real publication dates. '
      + 'WHEN TO USE: FIRST, before web_search, for questions about recent releases, news, or anything the curated sources cover — results are faster, dated, and from vetted sources. '
      + 'DO NOT stop here if results are thin — fall through to web_search for the open web.',
    parameterDescription: 'query (required): what to look for. count (optional): max results (default 5).',
    example: 'local_search[{"query": "Nemotron 3.5 Lightning release"}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
    category: 'web_search',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = String(params.query ?? '').trim();
      if (!query) return 'Error: query parameter is required';
      const count = Number(params.count) || 5;

      let queryEmbedding: number[];
      try {
        [queryEmbedding] = await deps.client.embed(query, deps.embedModel);
      } catch (err) {
        return `Local index unavailable (embedding failed: ${err instanceof Error ? err.message.slice(0, 80) : err}) — use web_search.`;
      }

      // Over-fetch chunks, collapse to docs, re-rank by similarity × recency.
      const chunks = deps.embeddings.search(queryEmbedding, count * 4, 0.35, 'webindex');
      const now = Date.now();
      const maxAgeMs = deps.maxAgeDays * 86_400_000;
      const byDoc = new Map<string, { score: number; snippet: string; meta: ReturnType<WebIndexService['docMeta']> }>();
      for (const c of chunks) {
        const meta = deps.index.docMeta(c.file);
        if (!meta) continue;
        const refAge = now - new Date(meta.publishedAt ?? meta.fetchedAt).getTime();
        if (refAge > maxAgeMs) continue;
        const score = c.score * recencyBoost(meta.publishedAt, now);
        const existing = byDoc.get(c.file);
        if (!existing || score > existing.score) {
          byDoc.set(c.file, { score, snippet: c.text.slice(0, 300), meta });
        }
      }

      const ranked = [...byDoc.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, count);
      if (ranked.length === 0) return `No local index results for "${query}" — use web_search for the open web.`;

      return ranked.map(([url, r], i) => {
        const date = r.meta?.publishedAt ? r.meta.publishedAt.slice(0, 10) : `fetched ${r.meta?.fetchedAt.slice(0, 10)}`;
        return `${i + 1}. ${r.meta?.title ?? url} (${date})\n   ${url}\n   ${r.snippet}`;
      }).join('\n\n');
    },
  };
}
