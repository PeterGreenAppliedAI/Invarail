import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { capsFor } from '../../ollama/model-caps.js';
import { join, resolve } from 'node:path';
import { mapQueriesToLenses, appendGatherSignal } from '../../mcp/registry-feed.js';
import type { PipelineDefinition, PipelineContext } from '../types.js';
import { markdownToHtml } from '../../utils/markdown-to-html.js';
import type { VerificationConfig } from '../../config/types.js';
import {
  type Claim, type VerificationResult,
  extractClaimsPrompt, parseClaims, CLAIMS_JSON_SCHEMA, pickRelevantSources, entailmentPrompt, parseVerdict,
  shouldEscalate, escalationPriority, tier1Query, tier1JudgePrompt, parseTier1, applyTier1,
  buildPatchSet, locateClaimSentence, sentenceCorrectionPrompt, verificationSection, needsCorrection, stripStrikethrough, guardRewrite,
} from '../verification.js';

/**
 * Research pipeline — REAL research, not a search.
 *
 * Flow: decompose topic into facets → investigate each facet in parallel
 * (search → deep fetch → per-facet synthesis) → gap-check + supplementary →
 * analytical final synthesis (markdown) → deterministic HTML render → PDF.
 *
 * The model writes MARKDOWN (its strength); code converts it to valid HTML and
 * assembles the report (no LLM-authored HTML). Output is always a PDF.
 * Gated to explicit "research/report/deep-dive" requests by the router.
 */

const CHART_RULES = `Chart rules:
- import matplotlib; matplotlib.use('Agg')
- Save each chart to: data/workspaces/main/research/<SLUG>/<chart_name>.png
- Create the dir first: os.makedirs('data/workspaces/main/research/<SLUG>', exist_ok=True)
- EVERY chart MUST have: a descriptive title, labeled axes, a legend if multiple series, and data labels.
- Call plt.tight_layout() then plt.close() after saving each figure.
- Use ONLY the data provided in the chart specs — never invent numbers.

Styling boilerplate (use a clean light theme suitable for a printed PDF report):
\`\`\`python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'figure.facecolor':'#ffffff','axes.facecolor':'#ffffff','font.size':11,'axes.titlesize':13,'axes.labelsize':11,'figure.figsize':(8,4.5),'savefig.dpi':130})
\`\`\``;

const REPORT_CSS = `
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; margin: 0; padding: 0; line-height: 1.7; }
.report { max-width: 780px; margin: 0 auto; padding: 40px 50px; }
h1 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 28px; font-weight: 700; color: #111; border-bottom: 3px solid #2563eb; padding-bottom: 12px; margin-bottom: 8px; }
.report-meta { font-size: 13px; color: #666; margin-bottom: 30px; }
h2 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 20px; font-weight: 600; color: #1e40af; margin-top: 32px; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
h3 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 16px; font-weight: 600; color: #374151; margin-top: 20px; }
p { margin: 10px 0; font-size: 14px; }
ul, ol { margin: 10px 0 10px 20px; font-size: 14px; }
li { margin-bottom: 6px; }
blockquote { border-left: 4px solid #f59e0b; background: #fffbeb; margin: 16px 0; padding: 8px 16px; font-size: 14px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
th { background: #1e40af; color: #fff; padding: 10px 14px; text-align: left; font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 600; }
td { padding: 8px 14px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tr:nth-child(even) td { background: #f9fafb; }
img { max-width: 100%; height: auto; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 4px; page-break-inside: avoid; }
code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
a { color: #2563eb; }
@media print { .report { padding: 20px; } h2 { page-break-after: avoid; } }
`;

const REPORT_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>${REPORT_CSS}</style></head>
<body><div class="report">${body}</div></body></html>`;

// --- helpers ---
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research';
}
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\/no_?think/gi, '').trim();
}
function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)"\]]+/g) ?? [])];
}
function wantsFreshness(text: string): boolean {
  return /\b(recent|latest|newest|current|today|this year|2026|2025|now|upcoming)\b/i.test(text);
}

/** Recency-shaped topics get a discovery sweep before decompose: a static-knowledge
 *  model CANNOT know what happened recently — left to its prior it manufactures
 *  facets about the archetypal entities it remembers (live failure 2026-08-14: a
 *  weekly AI-news run asked about Gemma/Llama while missing that week's actual
 *  releases). Discovery-first: search generically, ground the facets in results. */
export function isRecencyShaped(text: string): boolean {
  return wantsFreshness(text) || /\b(news|this week|this month|announce|releases?[sd]?\b)/i.test(text);
}

const STOPWORDS = new Set(('what are the is was were this that how why which who when whom or and for of in on to a an ' +
  'have has had do does did been being with from by at as its their they we i you it be will would should could can ' +
  'may might must about into over under between per each any some more most other than then there here also just only ' +
  'happened happening please me my our your').split(' '));

/** Condense a question-shaped facet to a keyword query. Long natural-language
 *  questions over-constrain metasearch (SearXNG returns nothing for them,
 *  especially with a freshness filter) — the same failure class as the old
 *  Brave site:-filter finding. Keeps content words, drops function words. */
export function condenseToKeywords(text: string, maxTerms = 7): string {
  return text
    .replace(/[?!.,;:()"']/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, maxTerms)
    .join(' ');
}

/** Generic sweep queries for a recency-shaped topic — deliberately broad so the
 *  RESULTS supply the entity names, not the model's frozen prior. */
export function buildSweepQueries(topic: string, now: Date): string[] {
  // Temporal words are redundant in the sweep (the freshness param covers
  // recency) — drop them, case-aware so proper nouns like "New England" survive.
  const core = condenseToKeywords(topic, 6)
    .split(' ')
    .filter(w => !/^(week|month|year|today)$/i.test(w) && !/^(new|latest|newest)$/.test(w))
    .slice(0, 5)
    .join(' ');
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return [
    `${core} news`,
    `${core} announcements ${monthYear}`,
  ];
}

interface AngleResult { angle: string; findings: string; sources: string[]; }

export interface FlowFacet { angle: string; urls: string[]; }
interface FlowMention { tool: string; flow: string; registryLog?: string; }

/** Parse a gathering flow's markdown into facets: "## <section>" headers become
 *  facet names, URLs in the lines beneath become that facet's source pool.
 *  Sections without URLs are dropped. Pure function — testable against the
 *  real weekly_gather output shape. */
export function parseFlowGather(md: string): FlowFacet[] {
  const facets: FlowFacet[] = [];
  let current: FlowFacet | null = null;
  for (const line of md.split('\n')) {
    const header = line.match(/^##\s+(.+)/);
    if (header) {
      if (current && current.urls.length > 0) facets.push(current);
      current = { angle: header[1].trim(), urls: [] };
      continue;
    }
    if (!current) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
      const url = m[0].replace(/[.,;:]+$/, '');
      if (!current.urls.includes(url)) current.urls.push(url);
    }
  }
  if (current && current.urls.length > 0) facets.push(current);
  return facets;
}

/** Run async fn over items with bounded concurrency (avoid bursting external rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Verdict-shaped internal calls (claim extraction, entailment judge, Tier-1
 *  judge) suppress thinking when the model supports it: their output is an enum
 *  contract nobody reads the reasoning of, and default-high thinking turned
 *  single entailment checks into 300s timeouts (live, 2026-08-14). The
 *  user-facing prose calls (facet findings, final synthesis, sentence
 *  corrections) keep the model's default — the owner reads those. */
const noThink = (model: string): { think?: false } =>
  capsFor(model).think === 'toggle' ? { think: false } : {};

/** Serialize the heavy facet-synthesis LLM calls: fetches run in parallel, but
 *  three concurrent 284B generations on one box split its throughput three
 *  ways and time each other out. Search has a politeness throttle; this is
 *  the same courtesy pointed at our own inference. */
let synthesisChain: Promise<unknown> = Promise.resolve();
function serializeSynthesis<T>(fn: () => Promise<T>): Promise<T> {
  const run = synthesisChain.then(fn, fn);
  synthesisChain = run.catch(() => {});
  return run;
}

/** Investigate ONE facet: search → deep fetch → focused synthesis.
 *  With presetUrls (flow-gathered), the search step is skipped — the compiled
 *  flow already selected the sources; fetch/cache/synthesis are identical. */
async function researchAngle(ctx: PipelineContext, angle: string, presetUrls?: string[]): Promise<AngleResult> {
  const label = angle.slice(0, 45);
  try {
    let urls: string[];
    if (presetUrls && presetUrls.length > 0) {
      urls = presetUrls.slice(0, 3);
    } else {
      // LOCAL-FIRST: the curated index answers before the open web is asked.
      // Additive, never a boundary (anti-search-buckets doctrine): thin local
      // results fall straight through to normal web search. local_search is
      // absent/erroring → identical fallthrough.
      try {
        const local = await ctx.executor('local_search', { query: angle, count: 4 }, ctx.toolContext);
        const localUrls = typeof local === 'string' && !local.startsWith('Error') ? extractUrls(local) : [];
        if (localUrls.length >= 2) {
          console.log(`[Research] Facet "${label}": ${localUrls.length} local-index hits — skipping web search`);
          urls = localUrls.slice(0, 3);
          ctx.params._localSourced = true;
          return await fetchAndSynthesize(ctx, angle, label, urls);
        }
      } catch { /* no local index — fall through */ }

      // Plain facet query (no source bucket — it over-constrained queries). Research is
      // recency-biased: default to a 1-year window, tighten to a month when the ask signals "latest".
      const recency = wantsFreshness(angle) || wantsFreshness(ctx.params.topic as string);
      const searchParams: Record<string, unknown> = {
        query: angle,
        count: '6',
        freshness: recency ? 'month' : 'year',
      };

      const searchResult = await ctx.executor('web_search', searchParams, ctx.toolContext);
      urls = extractUrls(searchResult).slice(0, 3);
      if (urls.length === 0) {
        // Question-shaped queries over-constrain metasearch — condense to
        // keywords and retry ONCE before declaring the facet dry (degrade,
        // never abort — same philosophy as extraction repair).
        const condensed = condenseToKeywords(angle);
        if (condensed && condensed.split(' ').length >= 2 && condensed !== angle) {
          console.warn(`[Research] Facet "${label}": no results — retrying condensed: "${condensed}"`);
          const retryResult = await ctx.executor('web_search', { ...searchParams, query: condensed }, ctx.toolContext);
          urls = extractUrls(retryResult).slice(0, 3);
        }
        if (urls.length === 0) {
          console.warn(`[Research] Facet "${label}": no search results (${searchResult.slice(0, 80)})`);
          return { angle, findings: '', sources: [] };
        }
      }
    }

    return await fetchAndSynthesize(ctx, angle, label, urls);
  } catch (err) {
    console.warn(`[Research] Angle failed "${angle.slice(0, 50)}":`, err instanceof Error ? err.message : err);
    return { angle, findings: '', sources: [] };
  }
}

/** Fetch a facet's chosen urls and synthesize findings — shared by the
 *  local-index, flow-preset, and web-search paths. */
async function fetchAndSynthesize(ctx: PipelineContext, angle: string, label: string, urls: string[]): Promise<AngleResult> {
    // Fetch sequentially (small N) to avoid a fetch burst across facets
    const fetched: Array<{ url: string; content: string }> = [];
    for (const url of urls) {
      try {
        const content = await ctx.executor('web_fetch', { url, extractMode: 'text' }, ctx.toolContext);
        fetched.push({ url, content });
      } catch { fetched.push({ url, content: '' }); }
    }
    const valid = fetched.filter(f => f.content && !f.content.startsWith('Error') && f.content.length > 120);
    if (valid.length === 0) {
      console.warn(`[Research] Facet "${label}": ${urls.length} urls, 0 fetched usable content`);
      return { angle, findings: '', sources: [] };
    }

    // Cache the raw fetched text so the verification stage can check claims against the
    // exact pages they were built from — no re-fetch, no extra search.
    const sourceText = ctx.params._sourceText as Record<string, string> | undefined;
    if (sourceText) for (const f of valid) if (!sourceText[f.url]) sourceText[f.url] = f.content;

    const sourceBlocks = valid.map((f, i) => `[Source ${i + 1}: ${f.url}]\n${f.content}`).join('\n\n---\n\n');
    const resp = await serializeSynthesis(() => ctx.client.chat({
      model: ctx.model,
      messages: [
        { role: 'system', content: [
          'You are a research analyst investigating ONE facet of a larger topic.',
          'From the sources below, extract the concrete findings, data points, specs, dates, and claims relevant to THIS facet only.',
          'Cite every claim inline with its source as [n] (matching the [Source n] blocks).',
          'Be factual. If sources disagree, say so explicitly. Do NOT fabricate — only use what the sources say.',
          'Output concise markdown — short paragraphs or bullets. No preamble, no conclusion. /no_think',
        ].join('\n') },
        { role: 'user', content: `Facet: ${angle}\n\nSources:\n${sourceBlocks}` },
      ],
      // Facet synthesis is EXTRACTION (the prompt says so) — think off. The
      // analytical thinking belongs to final_synthesis alone (blind-A/B winner).
      // Facet phase was ~20 of a 35-min run with thinking on (2026-08-16).
      ...noThink(ctx.model),
      options: { temperature: 0.3, num_predict: 1600, ...(ctx.contextSize ? { num_ctx: ctx.contextSize } : {}) },
    }));
    return { angle, findings: stripThinking(resp.message?.content ?? ''), sources: valid.map(f => f.url) };
}

export const researchPipeline: PipelineDefinition = {
  name: 'research',
  stages: [
    // 0. Extract topic + slug
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        topic: { type: 'string', description: 'The research topic or question', required: true },
        slug: { type: 'string', description: 'URL-safe slug for the output filename' },
      },
      examples: [
        { input: 'research the EV battery market and make me a PDF', output: { topic: 'EV battery market', slug: 'ev-battery-market' } },
        { input: 'deep dive on local inference hardware in 2026', output: { topic: 'local inference hardware in 2026', slug: 'local-inference-hardware-2026' } },
      ],
    },

    // 1. Defaults + conversational downgrade guard
    {
      name: 'defaults',
      type: 'code',
      execute: (ctx) => {
        if (!ctx.params.topic) ctx.params.topic = ctx.userMessage;
        if (!ctx.params.slug) ctx.params.slug = slugify(ctx.params.topic as string);
        // If we're mid-conversation and the user didn't actually ask for a report/deep-dive,
        // abort and let dispatch re-route to the fast web_search pipeline.
        if (ctx.conversational) {
          const wantsArtifact = /\b(report|deep.?dive|research|analy[sz]e|analysis|pdf|brief|write.?up|memo|market|teardown)\b/i.test(ctx.userMessage);
          if (!wantsArtifact) {
            ctx.abort = true;
            ctx.answer = '__DOWNGRADE_TO_WEB_SEARCH__';
            console.log('[Research] Conversational, no artifact intent — downgrading to web_search');
          }
        }
      },
    },

    // 1b. Flow-first gathering: when the user explicitly named a flow tool
    // (code gate — no semantic guessing), call it ONCE; its sections become
    // the facets and its links the source pool. Any failure falls through to
    // the normal decompose path — degrade, never abort.
    {
      name: 'flow_gather',
      progressLabel: '› Running the gathering flow…',
      type: 'code',
      when: (ctx) => ((ctx.params._explicitFlowMentions as FlowMention[] | undefined) ?? []).length > 0,
      execute: async (ctx) => {
        const mention = (ctx.params._explicitFlowMentions as FlowMention[])[0];
        try {
          const md = await ctx.executor(mention.tool, {}, ctx.toolContext);
          if (typeof md !== 'string' || md.startsWith('Error')) {
            console.warn(`[Research] Flow gather "${mention.tool}" failed (${String(md).slice(0, 100)}) — falling back to search`);
            return;
          }
          const facets = parseFlowGather(md);
          if (facets.length === 0) {
            console.warn(`[Research] Flow gather "${mention.tool}" returned no parseable facets — falling back to search`);
            return;
          }
          ctx.params._flowFacets = facets;
          ctx.params._flowGatherInfo = mention;
          ctx.params._angles = facets.map(f => f.angle);
          const urlCount = facets.reduce((n, f) => n + f.urls.length, 0);
          console.log(`[Research] Flow gather via ${mention.tool}: ${facets.length} facets, ${urlCount} urls`);
        } catch (err) {
          console.warn(`[Research] Flow gather "${mention.tool}" errored — falling back to search:`, err instanceof Error ? err.message : err);
        }
      },
    },

    // 1c. Discovery sweep: for recency-shaped topics, search GENERICALLY first
    // so the decompose model facets over what the search FOUND, not over the
    // archetypal entities in its frozen training prior (which cannot contain
    // this week's news by definition). Failure degrades to plain decompose.
    {
      name: 'discovery_sweep',
      progressLabel: '› Scanning for what actually happened…',
      type: 'code',
      when: (ctx) => !ctx.params._flowFacets && isRecencyShaped(ctx.params.topic as string),
      execute: async (ctx) => {
        const queries = buildSweepQueries(ctx.params.topic as string, new Date());
        const chunks: string[] = [];
        for (const query of queries) {
          try {
            const result = await ctx.executor('web_search',
              { query, count: '8', freshness: 'month' }, ctx.toolContext);
            if (typeof result === 'string' && !result.startsWith('No results') && !result.startsWith('Error')) {
              chunks.push(result.slice(0, 1400));
            }
          } catch (err) {
            console.warn(`[Research] Discovery sweep "${query}" failed:`, err instanceof Error ? err.message : err);
          }
        }
        if (chunks.length === 0) {
          console.warn('[Research] Discovery sweep found nothing — decompose falls back to model prior');
          return;
        }
        ctx.params._discoveryDigest = chunks.join('\n---\n');
        console.log(`[Research] Discovery sweep: ${chunks.length}/${queries.length} queries produced material for grounding`);
      },
    },

    // 2. Decompose the topic into 4-6 distinct facets (skipped when a flow
    // already provided them). Grounded in the discovery digest when one exists.
    {
      name: 'decompose',
      progressLabel: '› Planning the research…',
      type: 'llm',
      when: (ctx) => !ctx.params._flowFacets,
      temperature: 0.3,
      maxTokens: 1200,
      // Structured output — thinking counts against the budget and starved this
      // stage into a one-facet report (2026-08-16). Facet QUALITY comes from the
      // discovery digest, not deliberation.
      think: false,
      buildPrompt: (ctx) => {
        const digest = ctx.params._discoveryDigest as string | undefined;
        return {
          system: [
            'You are a senior research analyst scoping an investigation.',
            'Break the topic into 4-6 DISTINCT sub-questions/facets that together give comprehensive coverage.',
            'Each facet should be a different angle (not a paraphrase): e.g. current state, key players/options, performance/benchmarks, costs/tradeoffs, recent developments, outlook.',
            'If the topic names multiple entities to compare, ensure each gets dedicated coverage.',
            ...(digest ? [
              'FRESH SEARCH RESULTS are provided below. Your internal knowledge of "recent" events is stale by definition — build facets around the SPECIFIC names, products, and events that appear in the results, not around entities you remember. A facet naming something from the results beats a generic facet.',
            ] : []),
            'Facets should be SHORT keyword-style search queries (3-8 words), not full sentences — long questions return nothing from the search engine.',
            'Output ONLY a JSON array of facet strings.',
            'Example: ["AMD local inference options 2026", "ROCm vs CUDA benchmark comparison", ...]',
            'Return ONLY the JSON array. /no_think',
          ].join('\n'),
          user: `Topic: ${ctx.params.topic}\nCurrent year: ${new Date().getFullYear()}`
            + (digest ? `\n\nFresh search results (ground facets in these):\n${digest}` : ''),
        };
      },
    },

    // 3. Parse facets (skipped when a flow already provided them)
    {
      name: 'parse_angles',
      type: 'code',
      when: (ctx) => !ctx.params._flowFacets,
      execute: (ctx) => {
        const raw = stripThinking(ctx.stageResults.decompose as string);
        let angles: string[] = [];
        try {
          const m = raw.match(/\[[\s\S]*\]/);
          if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) angles = arr.filter(a => typeof a === 'string' && a.length > 5); }
        } catch { /* fall through */ }
        if (angles.length === 0) angles = [ctx.params.topic as string];
        if (angles.length < 2) console.warn(`[Research] DEGENERATE decompose — ${angles.length} facet(s); report coverage will be thin. Raw head: ${raw.slice(0, 120)}`);
        ctx.params._angles = angles.slice(0, 6);
        console.log(`[Research] Facets (${(ctx.params._angles as string[]).length}): ${(ctx.params._angles as string[]).map(a => a.slice(0, 40)).join(' | ')}`);
      },
    },

    // 4. Investigate each facet in parallel (search → fetch → synthesize)
    {
      name: 'research_angles',
      progressLabel: '› Searching the web and reading sources…',
      type: 'code',
      execute: async (ctx) => {
        const flowFacets = ctx.params._flowFacets as FlowFacet[] | undefined;
        const angles = ctx.params._angles as string[];
        console.log(`[Research] Investigating ${angles.length} facets (max 3 concurrent${flowFacets ? ', flow-gathered urls' : ''})...`);
        // url → raw page text, shared across facets so verification can reuse fetched pages.
        ctx.params._sourceText = {};
        // Bounded concurrency: 3 facets at a time avoids bursting Brave / fetch rate limits.
        const results = flowFacets
          ? await mapLimit(flowFacets, 3, f => researchAngle(ctx, f.angle, f.urls))
          : await mapLimit(angles, 3, a => researchAngle(ctx, a));
        const withFindings = results.filter(r => r.findings.trim().length > 0);
        ctx.params._angleResults = withFindings;
        const allSources = [...new Set(withFindings.flatMap(r => r.sources))];
        ctx.params._allSources = allSources;
        console.log(`[Research] ${withFindings.length}/${angles.length} facets produced findings; ${allSources.length} unique sources`);
      },
    },

    // 4b. EVIDENCE GATE: zero facets with findings → no report, full stop.
    // Without this, synthesis writes the entire "report" from the model's
    // frozen prior — fabricated versions, benchmarks, and URLs wearing a
    // Sources section (live failure 2026-08-14 during a SearXNG upstream
    // outage: the model even confessed "live search returned no indexed
    // results" and then invented Llama 4.5). Degrade honestly, NEVER fabricate.
    {
      name: 'evidence_gate',
      type: 'code',
      execute: (ctx) => {
        const findings = ctx.params._angleResults as AngleResult[];
        if (findings.length > 0) return;
        ctx.abort = true;
        ctx.answer = `I couldn't produce the research report on "${ctx.params.topic}" — every web search came back empty, so there is no source material to work from. `
          + 'This usually means the search provider is down or rate-limited (check SearXNG engine health). '
          + 'I won\'t write a report from memory: for a current-events topic that guarantees stale or invented content. Try again once search is healthy.';
        console.warn('[Research] EVIDENCE GATE: 0 facets with findings — aborting before synthesis (no report from prior)');
      },
    },

    // 5. Gap check → supplementary queries
    {
      name: 'gap_check',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 600,
      think: false,  // structured verdict, small budget — same starvation class as decompose
      buildPrompt: (ctx) => {
        const digest = ctx.params._discoveryDigest as string | undefined;
        return {
          system: [
            'You review research coverage. Given facet findings, identify what is MISSING, thin, or unverified for a thorough report on the topic.',
            'A gap must be grounded in the TOPIC or the provided material — an aspect that was searched but came back thin, or a thread the findings raise and drop.',
            'CRITICAL: the absence of an entity you remember (a company, model, or product from your training data) is NOT a gap. Your knowledge of the current landscape is stale by definition — entities you expect may no longer be relevant, and their absence from fresh results is evidence of that, not a hole to fill. Never nominate a query for an entity that neither the findings nor the fresh results mention.',
            'Output ONLY a JSON array of 0-2 additional short keyword search queries (3-8 words) that would fill the biggest grounded gaps. If coverage is already strong, output [].',
            'Return ONLY the JSON array. /no_think',
          ].join('\n'),
          user: `Topic: ${ctx.params.topic}\n\nFindings so far:\n${(ctx.params._angleResults as AngleResult[]).map(r => `### ${r.angle}\n${r.findings.slice(0, 600)}`).join('\n\n')}`
            + (digest ? `\n\nFresh search results from the discovery sweep (what the world currently mentions):\n${digest.slice(0, 1200)}` : ''),
        };
      },
    },
    {
      name: 'supplementary',
      type: 'code',
      execute: async (ctx) => {
        let queries: string[] = [];
        try {
          const m = stripThinking(ctx.stageResults.gap_check as string).match(/\[[\s\S]*\]/);
          if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) queries = arr.filter(q => typeof q === 'string' && q.length > 5).slice(0, 2); }
        } catch { /* none */ }
        if (queries.length === 0) { console.log('[Research] No gaps flagged'); return; }
        console.log(`[Research] Supplementary: ${queries.join(' | ')}`);

        // Flow-gathered run needing gap patches = a consumer-side staleness
        // observation. Emit it to the flow's registry log (FlowMCP v0.6 open
        // contract) with STABLE lens names (facet names come from the flow's
        // fixed sections) — persistent same-lens signals across runs are the
        // upstream recompile-nomination trigger.
        const gatherInfo = ctx.params._flowGatherInfo as FlowMention | undefined;
        const flowFacets = ctx.params._flowFacets as FlowFacet[] | undefined;
        if (gatherInfo?.registryLog && flowFacets) {
          const lenses = mapQueriesToLenses(queries, flowFacets.map(f => f.angle));
          appendGatherSignal(gatherInfo.registryLog, gatherInfo.flow, lenses);
        }
        const extra = await Promise.all(queries.map(q => researchAngle(ctx, q)));
        const merged = [...(ctx.params._angleResults as AngleResult[]), ...extra.filter(r => r.findings.trim())];
        ctx.params._angleResults = merged;
        ctx.params._allSources = [...new Set(merged.flatMap(r => r.sources))];
      },
    },

    // 6. Final analytical synthesis → markdown report (+ optional charts spec)
    {
      name: 'final_synthesis',
      progressLabel: '› Writing the report…',
      type: 'llm',
      temperature: 0.4,
      maxTokens: 8192,
      buildPrompt: (ctx) => {
        const findings = (ctx.params._angleResults as AngleResult[])
          .map((r, i) => `## Facet ${i + 1}: ${r.angle}\n${r.findings}\nSources: ${r.sources.join(', ')}`)
          .join('\n\n');
        const sources = (ctx.params._allSources as string[]);
        return {
          system: [
            'You are a senior analyst writing the FINAL research report from facet findings. Write in MARKDOWN (never HTML).',
            'This is ANALYSIS, not a summary. Form a clear thesis, weave findings across facets, and surface tensions.',
            '',
            'Structure:',
            '- `# {Report Title}` (one line)',
            '- A 2-4 sentence executive summary paragraph (no heading).',
            '- `## {Theme}` sections (4-7) with real analytical prose. Each major claim gets an inline citation like [3] referencing the numbered Sources list.',
            '- A `## Contradictions & Gaps` section naming where sources disagree or coverage is thin/uncertain. Do not paper over uncertainty.',
            '- A `## Sources` section: a numbered markdown list where item [n] is the URL (and title if known). Citation numbers in the body MUST match this list.',
            '',
            'If a chart would materially help, insert a placeholder line `{{chart:short_name}}` where it belongs, and at the VERY END append a fenced block:',
            '```charts',
            '[{"name":"short_name","title":"Chart Title","description":"what it shows","data":{"labels":["A","B"],"values":[1,2]}}]',
            '```',
            'Only propose charts you have real numeric data for. If none, omit the charts block entirely.',
            '',
            'Rules: never fabricate data or sources. Use only the findings provided. Be specific (numbers, dates, names).',
            ...(ctx.params._localSourced ? [
              '',
              'SOURCE PROVENANCE: some or all facets were gathered from a small PERSONAL CRAWLED INDEX (a couple dozen curated feeds), not an open web search. Its coverage is intentionally narrow. Therefore: absence of a topic, product, or release from these sources is WEAK evidence — it usually means "not in our crawl", not "does not exist". Never conclude that something is nonexistent, unreleased, or "a phantom" from source silence alone; write "not covered by the gathered sources" and treat it as a coverage gap in Contradictions & Gaps. Existence denials require positive evidence, not absence.',
            ] : []),
            '/no_think',
          ].join('\n'),
          user: `Topic: ${ctx.params.topic}\nToday: ${new Date().toISOString().split('T')[0]}\n\nNumbered sources:\n${sources.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\n\nFacet findings:\n${findings}`,
        };
      },
    },

    // 7. Split markdown report from the charts spec; fail loud if empty
    {
      name: 'parse_final',
      type: 'code',
      execute: (ctx) => {
        const raw = stripThinking(ctx.stageResults.final_synthesis as string);
        let charts: any[] = [];
        const chartBlock = raw.match(/```charts\s*([\s\S]*?)```/);
        if (chartBlock) {
          try { const arr = JSON.parse(chartBlock[1].trim()); if (Array.isArray(arr)) charts = arr.filter(c => c?.name); } catch { /* no charts */ }
        }
        let reportMarkdown = raw.replace(/```charts[\s\S]*?```/g, '').trim();
        // Code owns the Sources section. The model was GIVEN the numbered URL list,
        // but it occasionally mints near-miss URLs when transcribing it (ollama.co
        // for ollama.com, two runs straight). Body [n] citations refer to the list
        // we handed the model, so regenerating Sources from that same list is
        // always numbering-correct — and an invented URL can never publish.
        const allSources = ctx.params._allSources as string[] | undefined;
        if (allSources && allSources.length > 0) {
          const generated = `## Sources\n\n${allSources.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
          const srcIdx = reportMarkdown.search(/^## Sources\s*$/m);
          if (srcIdx !== -1) {
            const after = reportMarkdown.slice(srcIdx);
            const nextSection = after.slice(10).search(/^## /m);
            const end = nextSection === -1 ? reportMarkdown.length : srcIdx + 10 + nextSection;
            reportMarkdown = `${reportMarkdown.slice(0, srcIdx)}${generated}\n\n${reportMarkdown.slice(end)}`.trim();
          } else {
            reportMarkdown = `${reportMarkdown}\n\n${generated}`;
          }
        }
        ctx.params._reportMarkdown = reportMarkdown;
        ctx.params._charts = charts;
        // Fail loud: never emit a blank PDF
        if (reportMarkdown.replace(/[#*\->\s]/g, '').length < 200) {
          ctx.abort = true;
          ctx.answer = `I researched "${ctx.params.topic}" but couldn't gather enough reliable source material to produce a report. Try narrowing the topic or rephrasing.`;
          console.warn('[Research] Final synthesis too thin — aborting before render');
        }
      },
    },

    // 7b. Extract atomic, checkable claims from the draft (fast model)
    {
      name: 'extract_claims',
      type: 'code',
      when: (ctx) => (ctx.params._verification as VerificationConfig | undefined)?.enabled !== false,
      execute: async (ctx) => {
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const maxClaims = vcfg?.maxClaims ?? 12;
        const model = vcfg?.extractorModel || ctx.routerModel || ctx.model;
        try {
          const { system, user } = extractClaimsPrompt(ctx.params._reportMarkdown as string, maxClaims);
          const chatParams = {
            model,
            messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }],
            ...noThink(model),
            options: { temperature: 0.1, num_predict: 2000 },
          };
          let resp;
          try {
            // Grammar-constrained: output must match the claims array schema
            resp = await ctx.client.chat({ ...chatParams, format: CLAIMS_JSON_SCHEMA });
          } catch {
            resp = await ctx.client.chat(chatParams);
          }
          const claims = parseClaims(resp.message?.content ?? '', maxClaims);
          ctx.params._claims = claims;
          console.log(`[Verify] extracted ${claims.length} checkable claim(s)`);
        } catch (err) {
          console.warn('[Verify] claim extraction failed (skipping verification):', err instanceof Error ? err.message : err);
          ctx.params._claims = [];
        }
      },
    },

    // 7c. Check each claim against the cached sources that actually mention it (broader corpus,
    //     not the single — often mis-numbered — cited URL). No independent search.
    {
      name: 'verify_claims',
      progressLabel: '› Verifying claims against sources…',
      type: 'code',
      when: (ctx) => ((ctx.params._claims as Claim[] | undefined)?.length ?? 0) > 0,
      execute: async (ctx) => {
        const claims = ctx.params._claims as Claim[];
        const sources = (ctx.params._allSources as string[]) ?? [];
        const sourceText = (ctx.params._sourceText as Record<string, string>) ?? {};
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const model = vcfg?.judgeModel || ctx.model;
        const results = await mapLimit(claims, 3, async (claim): Promise<VerificationResult> => {
          const citedUrl = claim.citation && sources[claim.citation - 1] ? sources[claim.citation - 1] : undefined;
          // Top cached pages that mention the claim's tokens, plus the cited page if any.
          const candidateUrls = pickRelevantSources(claim, sourceText, 3, citedUrl);
          let candidates = candidateUrls.map(u => ({ url: u, text: sourceText[u] })).filter(c => c.text);
          // Fallback: nothing cached matched — fetch the cited page on demand.
          if (candidates.length === 0 && citedUrl) {
            try {
              const c = await ctx.executor('web_fetch', { url: citedUrl, extractMode: 'text' }, ctx.toolContext);
              if (c && !c.startsWith('Error') && c.length > 120) candidates = [{ url: citedUrl, text: c }];
            } catch { /* leave empty */ }
          }
          if (candidates.length === 0) {
            return { claim_id: claim.claim_id, claim: claim.claim, verdict: 'AMBIGUOUS', cited_source: citedUrl, supported_elements: [], unsupported_elements: [], reason: 'No cached source available to check against — left as drafted.', recommended_action: 'keep' };
          }
          try {
            const { system, user } = entailmentPrompt(claim, candidates);
            const resp = await ctx.client.chat({
              model,
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
              ...noThink(model),
              options: { temperature: 0.2, num_predict: 600 },
            });
            return parseVerdict(resp.message?.content ?? '', claim, citedUrl);
          } catch (err) {
            console.warn(`[Verify] judge failed for ${claim.claim_id}:`, err instanceof Error ? err.message : err);
            return { claim_id: claim.claim_id, claim: claim.claim, verdict: 'AMBIGUOUS', cited_source: citedUrl, supported_elements: [], unsupported_elements: [], reason: 'Judge error — left as drafted.', recommended_action: 'keep' };
          }
        });
        ctx.params._verifications = results;
        console.log(`[Verify] ${results.length} checked, ${results.filter(needsCorrection).length} need correction`);
        // Auditable artifact alongside the report/charts
        try {
          const dir = join('data', 'workspaces', 'main', 'research', ctx.params.slug as string);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'verification.json'), JSON.stringify({ topic: ctx.params.topic, generated: new Date().toISOString(), results }, null, 2));
        } catch (err) {
          console.warn('[Verify] could not write verification.json:', err instanceof Error ? err.message : err);
        }
      },
    },

    // 7c-2. Tier-1 independent cross-check — one fresh search per high-impact claim to catch
    //       faithfully-cited wrong facts (e.g. a wrong acquisition date). Bounded + throttled.
    {
      name: 'tier1_crosscheck',
      type: 'code',
      when: (ctx) => {
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        return (vcfg?.crossCheck ?? true) && (vcfg?.maxCrossChecks ?? 4) > 0
          && ((ctx.params._verifications as VerificationResult[] | undefined)?.length ?? 0) > 0;
      },
      execute: async (ctx) => {
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const cap = vcfg?.maxCrossChecks ?? 4;
        const model = vcfg?.judgeModel || ctx.model;
        const byId = new Map((ctx.params._claims as Claim[]).map(c => [c.claim_id, c]));
        const results = ctx.params._verifications as VerificationResult[];
        // Model-nominated claims (external_check — the model knows where it argued from
        // silence) and existence claims outrank the type heuristic for the capped budget.
        const escalate = results
          .filter(v => { const c = byId.get(v.claim_id); return c && shouldEscalate(c); })
          .sort((a, b) => escalationPriority(byId.get(a.claim_id)!) - escalationPriority(byId.get(b.claim_id)!))
          .slice(0, cap);
        if (escalate.length === 0) { console.log('[Verify] Tier-1: no high-impact claims to cross-check'); return; }
        let contradicted = 0;
        const updated = await mapLimit(escalate, 2, async (v): Promise<VerificationResult> => {
          const claim = byId.get(v.claim_id)!;
          try {
            const searchParams: Record<string, unknown> = { query: tier1Query(claim), count: '5' };
            if (claim.time_sensitive) searchParams.freshness = 'year';
            const searchResult = await ctx.executor('web_search', searchParams, ctx.toolContext);
            const fetched: Array<{ url: string; text: string }> = [];
            for (const url of extractUrls(searchResult).slice(0, 2)) {
              try {
                const c = await ctx.executor('web_fetch', { url, extractMode: 'text' }, ctx.toolContext);
                if (c && !c.startsWith('Error') && c.length > 120) fetched.push({ url, text: c });
              } catch { /* skip */ }
            }
            if (fetched.length === 0) return v;
            const { system, user } = tier1JudgePrompt(claim, fetched);
            const resp = await ctx.client.chat({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...noThink(model), options: { temperature: 0.1, num_predict: 400 } });
            const t1 = parseTier1(resp.message?.content ?? '');
            if (t1.status === 'CONTRADICTED') contradicted++;
            return applyTier1(v, t1);
          } catch (err) {
            console.warn(`[Verify] Tier-1 failed for ${v.claim_id}:`, err instanceof Error ? err.message : err);
            return v;
          }
        });
        const upById = new Map(updated.map(u => [u.claim_id, u]));
        ctx.params._verifications = results.map(r => upById.get(r.claim_id) ?? r);
        console.log(`[Verify] Tier-1: ${escalate.length} cross-checked, ${contradicted} contradicted`);
        try {
          const dir = join('data', 'workspaces', 'main', 'research', ctx.params.slug as string);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'verification.json'), JSON.stringify({ topic: ctx.params.topic, generated: new Date().toISOString(), results: ctx.params._verifications }, null, 2));
        } catch { /* ignore */ }
      },
    },

    // 7d. Correction pass — code locates each claim's sentence, the model rewrites
    // ONE sentence, code splices it back. The report body is never handed to the
    // model for a whole-document rewrite (mass-deletion and strikethrough risks gone).
    {
      name: 'correction_pass',
      type: 'code',
      when: (ctx) => (ctx.params._verifications as VerificationResult[] | undefined)?.some(needsCorrection) ?? false,
      execute: async (ctx) => {
        const results = ctx.params._verifications as VerificationResult[];
        const claims = ctx.params._claims as Claim[];
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        let md = ctx.params._reportMarkdown as string;
        // Sources let attribution cite by marker ("[6]") instead of raw URLs
        const patch = buildPatchSet(results, (ctx.params._allSources as string[]) ?? []);
        const claimText: Record<string, string> = {};
        for (const c of claims) claimText[c.claim_id] = c.claim;

        let applied = 0;
        for (const [id, p] of Object.entries(patch)) {
          const claim = claimText[id];
          if (!claim) continue;
          // Re-locate against the CURRENT md — earlier splices shift offsets
          const loc = locateClaimSentence(md, claim);
          if (!loc) {
            console.warn(`[Verify] no sentence match for ${id} — skipping correction`);
            continue;
          }
          try {
            const { system, user } = sentenceCorrectionPrompt(loc.sentence, p.instruction);
            const resp = await ctx.client.chat({
              model: vcfg?.judgeModel || ctx.model,
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
              options: { temperature: 0.2, num_predict: 400 },
            });
            const raw = stripStrikethrough(stripThinking(resp.message?.content ?? '')).trim()
              .replace(/^["'`]+|["'`]+$/g, '');
            // Guard: reject rewrites that would mangle prose (raw URLs, stacked
            // hedges, orphaned bold markers, oversized) — skip beats splice-scars
            const rewritten = guardRewrite(raw, loc.sentence);
            if (!rewritten) {
              console.warn(`[Verify] rejected rewrite for ${id} (guard: URL/stacked-hedge/format/size)`);
              continue;
            }
            md = md.slice(0, loc.start) + rewritten + md.slice(loc.end);
            applied++;
          } catch (err) {
            console.warn(`[Verify] sentence correction failed for ${id}:`, err instanceof Error ? err.message : err);
          }
        }
        ctx.params._reportMarkdown = md;
        console.log(`[Verify] applied ${applied}/${Object.keys(patch).length} sentence correction(s)`);
      },
    },

    // 7e. Append the verification appendix to the published report
    {
      name: 'verification_append',
      type: 'code',
      when: (ctx) => ((ctx.params._verifications as VerificationResult[] | undefined)?.length ?? 0) > 0,
      execute: (ctx) => {
        const section = verificationSection(ctx.params._verifications as VerificationResult[]);
        if (section) ctx.params._reportMarkdown = `${ctx.params._reportMarkdown as string}\n${section}`;
      },
    },

    // 8. Generate charts (matplotlib via code_session) — optional, non-blocking
    {
      name: 'generate_visuals',
      type: 'code',
      execute: async (ctx) => {
        const charts = (ctx.params._charts as any[]) ?? [];
        const slug = ctx.params.slug as string;
        ctx.params._validCharts = [];
        if (charts.length === 0) return;
        try {
          await ctx.executor('code_session', { action: 'start', session: 'research', runtime: 'python' }, ctx.toolContext);
          const resp = await ctx.client.chat({
            model: ctx.model,
            messages: [
              { role: 'system', content: ['Write ONE Python script generating ALL the requested charts. Output ONLY Python, no fences, no prose.', '', CHART_RULES.replace(/<SLUG>/g, slug)].join('\n') },
              { role: 'user', content: `Charts:\n${JSON.stringify(charts, null, 2)}\nSlug: ${slug}` },
            ],
            options: { temperature: 0.2, num_predict: 3000 },
          });
          const code = stripThinking(resp.message?.content ?? '').replace(/^```(?:python)?\n?/m, '').replace(/\n?```$/m, '').trim();
          await ctx.executor('code_session', { action: 'run', session: 'research', code }, ctx.toolContext);
          ctx.params._validCharts = charts
            .map((c: any) => c.name as string)
            .filter((name: string) => existsSync(join('data', 'workspaces', 'main', 'research', slug, `${name}.png`)));
          console.log(`[Research] Charts: ${(ctx.params._validCharts as string[]).length}/${charts.length} rendered`);
        } catch (err) {
          console.warn('[Research] Chart generation failed (continuing without charts):', err instanceof Error ? err.message : err);
        }
      },
    },

    // 9. Deterministic render: markdown → HTML, embed charts, wrap in template
    {
      name: 'render_report',
      type: 'code',
      execute: (ctx) => {
        const slug = ctx.params.slug as string;
        const validCharts = new Set(ctx.params._validCharts as string[]);
        // Strip any tracked-changes strikethrough the corrector left in (else the PDF shows
        // lines through the old wrong text alongside the replacement).
        let md = stripStrikethrough(ctx.params._reportMarkdown as string);
        // Swap chart placeholders for <img> only if the file exists. Paths must
        // be ABSOLUTE: LibreOffice resolves relative src against the temp HTML's
        // directory (data/media/documents/), so relative paths rendered blank —
        // the Aug 1 report's charts existed on disk but never reached the PDF.
        md = md.replace(/\{\{chart:([a-z0-9_\-]+)\}\}/gi, (_m, name) => {
          return validCharts.has(name)
            ? `\n\n![${name}](${resolve(`data/workspaces/main/research/${slug}/${name}.png`)})\n\n`
            : '';
        });
        let body = markdownToHtml(md);
        // LibreOffice ignores CSS max-width on import and places images at
        // natural size — a 1040px chart overflows the printable area and gets
        // CLIPPED at the page edge. Explicit width/height ATTRIBUTES are what
        // Writer honors (same quirk family as the absolute-src lesson above).
        // All charts share figsize 8x4.5 per CHART_RULES, so 640x360 is exact.
        body = body.replace(/<img /g, '<img width="640" height="360" ');
        // Style the first H1 as the report title + add a meta line
        body = body.replace(/<h1>/, '<h1 class="report-title">');
        const meta = `<div class="report-meta">${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })} · ${(ctx.params._allSources as string[]).length} sources</div>`;
        body = body.replace(/(<\/h1>)/, `$1${meta}`);
        ctx.params._reportHtml = REPORT_TEMPLATE(ctx.params.topic as string, body);
      },
    },

    // 10. HTML → PDF via LibreOffice (document tool)
    {
      name: 'convert_pdf',
      progressLabel: '› Rendering the PDF…',
      type: 'tool',
      tool: 'document',
      resolveParams: (ctx) => ({
        action: 'create',
        content: ctx.params._reportHtml,
        format: 'pdf',
        filename: ctx.params.slug,
      }),
    },

    // 11. User-facing summary (streamed)
    {
      name: 'summary',
      type: 'llm',
      stream: true,
      temperature: 0.4,
      maxTokens: 400,
      buildPrompt: (ctx) => ({
        system: 'Write a 3-5 sentence summary of the key findings for the user. Plain prose, no markdown headers. Do NOT mention files, PDFs, or technical details — just the substance. /no_think',
        user: `Topic: ${ctx.params.topic}\n\nReport:\n${(ctx.params._reportMarkdown as string).slice(0, 3000)}`,
      }),
    },

    // 12. Finalize: attach the PDF
    {
      name: 'finalize',
      type: 'code',
      execute: (ctx) => {
        const slug = ctx.params.slug as string;
        const pdfPath = join('data', 'media', 'documents', `${slug}.pdf`);
        const summary = stripThinking(ctx.stageResults.summary as string);
        if (existsSync(pdfPath)) {
          ctx.answer = `${summary} [FILE:${pdfPath}]`;
        } else {
          console.warn('[Research] PDF not found after convert:', pdfPath);
          ctx.answer = `${summary}\n\n(Note: the report was generated but the PDF conversion did not produce a file.)`;
        }
      },
    },
  ],
};
