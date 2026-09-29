/**
 * The stubbed web. `web_search` and `web_fetch` are replaced with this fixed corpus so a run
 * is reproducible and never spends a real provider's quota (or the host IP's reputation).
 * Search ranks pages by token overlap with the query; fetch returns a page by exact URL or a
 * 404. Distinctive phrases in the bodies are what the task oracles look for.
 */
import type { InvarailTool } from '../../src/tools/types.js';

export interface Page { url: string; title: string; body: string }

/** Fixed corpus. Distinctive phrases are what the oracles look for in reports and answers. */
export const CORPUS: Page[] = [
  {
    url: 'https://gpu-inference.example/consumer-gpus-2026',
    title: 'Local LLM inference on consumer GPUs in 2026: what fits where',
    body: `Local inference in 2026 is bounded by VRAM, not compute. A 12GB card (RTX 3060 / 4070) runs 7–12B models comfortably in 4-bit GGUF; a 24GB card (RTX 3090 / 4090 / A5000) runs 27–35B models at Q4_K_M with room for a 16K context. The common rule of thumb is 0.6GB of VRAM per billion parameters at Q4 plus the KV cache. Above 24GB, two-card setups or unified memory (Apple silicon, Strix Halo) take over.\n\nThroughput on a 4090 for a 27B Q4 model is roughly 35–45 tokens per second; a 12B model on a 3060 lands near 25 tokens per second. Prompt processing (prefill) is the hidden cost: a 4K-token system prompt costs 1–2 seconds on a 3060 before the first token.`,
  },
  {
    url: 'https://quant-notes.example/gguf-quantization-guide',
    title: 'GGUF quantization guide: Q4_K_M is the default for a reason',
    body: `Q4_K_M keeps 95–98% of a model's benchmark quality at ~4.5 bits per weight and is the default download on most hubs. Q8_0 is near-lossless but doubles memory. Q3 and Q2 quants fit more parameters into the same VRAM but the quality drop is steep below 4 bits — a Q2 27B is usually worse than a Q4 12B. IQ quants (importance-matrix) recover some quality at low bit widths. For tool calling specifically, quantization below Q4 measurably increases malformed JSON arguments.`,
  },
  {
    url: 'https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama',
    title: 'llama.cpp vs vLLM vs Ollama: which serving stack for one user',
    body: `For a single user on one GPU, llama.cpp (and Ollama, which wraps it) wins on simplicity and memory efficiency; vLLM wins on batched throughput and is the choice for a shared server. Ollama added structured outputs (JSON schema constrained decoding) and native tool calling for supported chat templates; not every model's template declares tools — phi4 and the gemma3 small models return HTTP 400 on a tools request. Speculative decoding with a small draft model gives 1.5–2× on long generations in llama.cpp. vLLM's prefix caching makes repeated system prompts nearly free; llama.cpp caches the KV prefix per slot.`,
  },
  {
    url: 'https://small-models.example/9b-vs-27b-tool-use',
    title: 'How small can a tool-using agent go? 9B vs 27B in practice',
    body: `In agent loops the gap between 9B and 27B is not knowledge, it is discipline: small models call a tool when none is needed, pad arguments with fields the schema never asked for, and lose the thread after 4–5 hops. Thinking modes help 27B models and hurt 9B models on tool batteries — the reasoning burns the output budget before the call. With a short system prompt and a capped toolset a 9B holds up on 1–2 hop tasks; with a 4K-token prompt and twenty tools it degrades sharply.`,
  },
  {
    url: 'https://nodejs-history.example/timeline',
    title: 'A short history of Node.js',
    body: `Node.js was first released in 2009 by Ryan Dahl, built on Google's V8 engine. npm arrived in 2010. The io.js fork in 2014 merged back in 2015 under the Node.js Foundation, which became the OpenJS Foundation in 2019. Long-term support releases ship every October.`,
  },
  {
    url: 'https://example-docs.test/guide',
    title: 'Widget Service — Operator Guide',
    body: `# Widget Service Operator Guide\n\nThe service listens on port 8443 and requires TLS. Configuration lives in /etc/widget/config.toml and is reloaded with SIGHUP — no restart needed. Backups run nightly at 02:00 UTC to the "widget-backups" bucket and are retained for 30 days. The health endpoint is /healthz and returns 503 while a backup is in progress.`,
  },
  {
    url: 'https://unified-memory.example/apple-strix-halo',
    title: 'Unified memory for local inference: Apple silicon and Strix Halo',
    body: `Unified memory trades bandwidth for capacity: a 128GB Mac Studio or Strix Halo box loads a 70B model that no consumer card can, at a fraction of the tokens per second a 4090 gives on a model that fits. For chat that is fine; for agent loops that prefill a long prompt every turn, the lower bandwidth shows up as latency to first token. MLX on Apple silicon narrows the gap for prefill.`,
  },
];

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9.]{3,}/g) ?? []);

export function makeWebStubs(log: string[]): InvarailTool[] {
  const search: InvarailTool = {
    name: 'web_search',
    description: 'Search the web. WHEN TO USE: you need current facts, sources, or URLs you do not have. Returns titles, URLs and snippets.',
    parameterDescription: '{"query": "search terms", "count": 5}',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' }, count: { type: 'number', description: 'Number of results (default 5)' } }, required: ['query'] },
    category: 'web',
    execute: async (params) => {
      const q = String(params.query ?? '');
      log.push(`web_search(${q})`);
      const qt = tokens(q);
      const ranked = CORPUS
        .map(p => ({ p, hits: [...tokens(`${p.title} ${p.body}`)].filter(t => qt.has(t)).length }))
        .sort((a, b) => b.hits - a.hits);
      const top = ranked.slice(0, Math.min(Number(params.count ?? 4) || 4, 5)).map(r => r.p);
      return top.map((p, i) => `${i + 1}. ${p.title}\n   ${p.url}\n   ${p.body.slice(0, 160).replace(/\n/g, ' ')}…`).join('\n\n');
    },
  };
  const fetch: InvarailTool = {
    name: 'web_fetch',
    description: 'Fetch a web page by URL and return its text content. WHEN TO USE: you have a URL and need what is on the page.',
    parameterDescription: '{"url": "https://…"}',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The URL to fetch' } }, required: ['url'] },
    category: 'web',
    execute: async (params) => {
      const url = String(params.url ?? '').replace(/\/$/, '');
      log.push(`web_fetch(${url})`);
      const page = CORPUS.find(p => p.url === url);
      return page ? `# ${page.title}\n\n${page.body}` : 'Error: HTTP 404 Not Found';
    },
  };
  return [search, fetch];
}
