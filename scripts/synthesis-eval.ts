/**
 * Synthesis A/B/C/D — feed identical source material to candidate foreground
 * models, collect the analytical articles they write, and publish them BLIND
 * (shuffled A/B/C/D, mapping sealed in a separate file) for judging.
 *
 * This measures the one thing the deterministic evals deliberately don't:
 * prose — synthesis depth, analytical voice, citation discipline. Judgment is
 * human/frontier side-by-side reading, per the house rule (never trust judge
 * scores over a cold read).
 *
 * Source pack: real docs pulled from the personal web index (this week's AI
 * news — the production research workload). Prompt mirrors the research
 * pipeline's final_synthesis stage.
 *
 * Usage: npx tsx scripts/synthesis-eval.ts   (run inside the `lab` tmux)
 * Output: data/model-eval/synthesis-<ts>/{article-A..D.md, MAPPING.json, pack.md}
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { stripThinkingTags } from '../src/utils/text.js';

interface Contestant { name: string; think?: boolean | 'low' | 'medium' | 'high'; label: string }

const CONTESTANTS: Contestant[] = [
  { name: 'deepseek-v4-flash', think: undefined, label: 'deepseek-v4-flash (default thinking)' },
  { name: 'qwen3.8:27b', think: true, label: 'qwen3.8:27b@think=on' },
  { name: 'gpt-oss:120b', think: 'low', label: 'gpt-oss:120b@think=low' },
  { name: 'gemma4:31b', think: false, label: 'gemma4:31b@think=off' },
];

const PACK_URLS = [
  'https://huggingface.co/Qwen/Qwen3.8-27B-FP8',
  'https://huggingface.co/blog/state-of-open-models-summer-2026',
  'https://huggingface.co/blog/muse-glimmer',
  'https://developer.nvidia.com/blog/nvidia-nemotron-3-5-lightning-delivers-fast-accurate-specialized-task-execution-for-long-running-agents/',
  'https://developer.nvidia.com/blog/serve-qwen3-8-2-4t-a95b-a-2-4t-parameter-model-with-configurable-reasoning-on-nvidia-gb300-nvl72/',
  'https://huggingface.co/blog/LiquidAI/lfm2-5-vl-3b',
  'https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api-3-6-flash-hooks/',
  'https://huggingface.co/blog/amazon/strands-lerobot-streaming-data-loop',
];
const PER_DOC_CHARS = 2400;

const RUN_DIR = join('data', 'model-eval', `synthesis-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
mkdirSync(RUN_DIR, { recursive: true });

function buildPack(): string {
  const db = new Database('data/webindex.db', { readonly: true });
  const blocks: string[] = [];
  PACK_URLS.forEach((url, i) => {
    const row = db.prepare('SELECT title, publishedAt, text FROM docs WHERE url = ?').get(url) as { title: string; publishedAt: string | null; text: string } | undefined;
    if (!row) throw new Error(`Pack doc missing from index: ${url}`);
    const date = row.publishedAt ? row.publishedAt.slice(0, 10) : 'undated';
    blocks.push(`[${i + 1}] ${row.title} (${date})\n${url}\n\n${row.text.slice(0, PER_DOC_CHARS)}`);
  });
  db.close();
  return blocks.join('\n\n---\n\n');
}

const SYSTEM = [
  'You are a senior analyst writing the FINAL analytical article from the source pack. Write in MARKDOWN.',
  'This is ANALYSIS, not a summary. Form a clear thesis, weave findings across sources, and surface tensions.',
  'Structure: a title, a 2-4 sentence executive summary, 4-6 themed sections of real analytical prose, and a closing "Contradictions & Gaps" section naming where sources disagree or coverage is thin.',
  'Every major claim gets an inline citation like [3] referencing the numbered sources. Use ONLY the provided material — never fabricate a fact, figure, or source. If the sources do not settle something, say so.',
  'Target 1200-1600 words.',
].join('\n');

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const pack = buildPack();
  writeFileSync(join(RUN_DIR, 'pack.md'), pack);
  console.log(`Source pack: ${PACK_URLS.length} docs, ${pack.length} chars -> ${RUN_DIR}`);

  const letters = ['A', 'B', 'C', 'D'];
  // Deterministic-but-opaque shuffle: sort contestants by sha of name+run dir
  const { createHash } = await import('node:crypto');
  const shuffled = [...CONTESTANTS].sort((a, b) =>
    createHash('sha256').update(a.name + RUN_DIR).digest('hex')
      .localeCompare(createHash('sha256').update(b.name + RUN_DIR).digest('hex')));

  const mapping: Record<string, string> = {};
  for (let i = 0; i < shuffled.length; i++) {
    const c = shuffled[i];
    const letter = letters[i];
    mapping[letter] = c.label;
    console.log(`Generating article ${letter}...`);
    const start = Date.now();
    try {
      const params: Parameters<typeof client.chat>[0] = {
        model: c.name,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Today: 2026-08-15\n\nNumbered sources:\n\n${pack}\n\nWrite the analytical article on this week's AI developments.` },
        ],
        options: { temperature: 0.4, num_predict: 8192, num_ctx: 24576 },
      };
      if (c.think !== undefined) (params as Record<string, unknown>).think = c.think;
      const res = await client.chat(params);
      const article = stripThinkingTags(res.message?.content ?? '').trim();
      const tokens = (res as unknown as { eval_count?: number }).eval_count ?? 0;
      writeFileSync(join(RUN_DIR, `article-${letter}.md`), article);
      console.log(`  article ${letter}: ${article.length} chars, ${tokens} ctok, ${((Date.now() - start) / 1000).toFixed(0)}s`);
    } catch (err) {
      writeFileSync(join(RUN_DIR, `article-${letter}.md`), `GENERATION FAILED: ${err instanceof Error ? err.message : err}`);
      console.error(`  article ${letter} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  writeFileSync(join(RUN_DIR, 'MAPPING.json'), JSON.stringify(mapping, null, 2));
  console.log(`SYNTHESIS EVAL COMPLETE — articles A-${letters[shuffled.length - 1]} in ${RUN_DIR} (mapping sealed in MAPPING.json)`);
}

main().catch(err => { console.error('Synthesis eval failed:', err instanceof Error ? err.message : err); process.exit(1); });
