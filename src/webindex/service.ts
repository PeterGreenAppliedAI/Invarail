/**
 * WebIndexService — the personal vertical index (leg 1 of the search stack).
 *
 * Curate what we FETCH, never constrain what we SEARCH (see DECISIONS: this is
 * the anti-search-buckets position — an additive retrieval source in front of
 * unconstrained web search, never a boundary on it).
 *
 * Ingestion is 100% deterministic — no LLM anywhere. RSS/Atom-first over
 * owner-curated seeds; conditional GET on feeds; item pages fetched through
 * the real web_fetch tool (Readability + SSRF) behind honest crawler etiquette:
 * named UA, robots.txt respected, per-domain pacing. Content-hash dedup makes
 * re-crawls of unchanged pages no-ops.
 *
 * Embedding resilience: content + metadata land immediately with
 * status='pending'; vectors are backfilled with retry at each cycle. An
 * embeddings outage delays searchability of NEW items — it never loses
 * content and never blocks the crawl (designed the day the gateway's
 * embeddings route hung mid-build, 2026-08-14).
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cron } from 'croner';
import type { EmbeddingStore } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';
import type { InvarailTool, ToolContext } from '../tools/types.js';
import type { LocalIndexConfig } from '../config/types.js';
import { parseFeed, type FeedItem } from './feed.js';

const USER_AGENT = 'InvarailBot/1.0 (+https://github.com/PeterGreenAppliedAI/Invarail)';
const SOURCE = 'webindex';
const CHUNK_CHARS = 1400;
const MAX_CHUNKS_PER_DOC = 8;

interface WebIndexDeps {
  config: LocalIndexConfig;
  embeddings: EmbeddingStore;
  client: OllamaClient;
  embedModel: string;
  webFetch: InvarailTool;
  timezone?: string;
  dbPath?: string;
}

export interface IndexedDocMeta {
  url: string; title: string; publishedAt: string | null; fetchedAt: string;
  hash: string; tags: string; seedUrl: string; status: 'embedded' | 'pending';
}

export class WebIndexService {
  private db: Database.Database;
  private deps: WebIndexDeps;
  private cron: Cron | null = null;
  private running = false;
  private domainLastFetch = new Map<string, number>();
  private robotsCache = new Map<string, string[]>(); // origin → disallowed prefixes for *

  constructor(deps: WebIndexDeps) {
    this.deps = deps;
    const dbPath = deps.dbPath ?? 'data/webindex.db';
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        url TEXT PRIMARY KEY, title TEXT NOT NULL, publishedAt TEXT,
        fetchedAt TEXT NOT NULL, hash TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
        seedUrl TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feeds (
        url TEXT PRIMARY KEY, etag TEXT, lastModified TEXT, lastFetchAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
      CREATE INDEX IF NOT EXISTS idx_docs_published ON docs(publishedAt);
    `);
  }

  start(): void {
    if (!this.deps.config.enabled) return;
    this.cron = new Cron(this.deps.config.refreshCron, { timezone: this.deps.timezone }, () => {
      void this.refresh().catch(err => console.warn('[WebIndex] Refresh failed:', err instanceof Error ? err.message : err));
    });
    console.log(`[WebIndex] Scheduled (${this.deps.config.refreshCron}) — ${this.deps.config.seeds.length} seed(s), next: ${this.cron.nextRun()?.toISOString() ?? '?'}`);
  }

  stop(): void { this.cron?.stop(); this.db.close(); }

  /** One full ingestion cycle. Safe to call manually; overlapping calls skip. */
  async refresh(): Promise<{ newDocs: number; embedded: number; backfilled: number }> {
    if (this.running) { console.log('[WebIndex] Refresh skipped — previous cycle still running'); return { newDocs: 0, embedded: 0, backfilled: 0 }; }
    this.running = true;
    try {
      const backfilled = await this.backfillPending();
      let newDocs = 0, embedded = 0;
      for (const seed of this.deps.config.seeds) {
        try {
          const r = seed.kind === 'rss' ? await this.ingestFeed(seed.url, seed.tags, seed.followLinks) : await this.ingestPage(seed.url, seed.url, seed.tags, null);
          newDocs += r.newDocs; embedded += r.embedded;
        } catch (err) {
          console.warn(`[WebIndex] Seed failed "${seed.url}":`, err instanceof Error ? err.message : err);
        }
      }
      console.log(`[WebIndex] Cycle done: ${newDocs} new doc(s), ${embedded} embedded, ${backfilled} backfilled`);
      return { newDocs, embedded, backfilled };
    } finally {
      this.running = false;
    }
  }

  // --- feed ingestion ---

  private async ingestFeed(feedUrl: string, tags: string[], followLinks: boolean): Promise<{ newDocs: number; embedded: number }> {
    const state = this.db.prepare('SELECT etag, lastModified FROM feeds WHERE url = ?').get(feedUrl) as { etag?: string; lastModified?: string } | undefined;
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (state?.etag) headers['If-None-Match'] = state.etag;
    if (state?.lastModified) headers['If-Modified-Since'] = state.lastModified;

    await this.politeness(feedUrl);
    const res = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(20_000) });
    this.db.prepare('INSERT INTO feeds (url, etag, lastModified, lastFetchAt) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET etag=excluded.etag, lastModified=excluded.lastModified, lastFetchAt=excluded.lastFetchAt')
      .run(feedUrl, res.headers.get('etag'), res.headers.get('last-modified'), new Date().toISOString());
    if (res.status === 304) return { newDocs: 0, embedded: 0 };
    if (!res.ok) { console.warn(`[WebIndex] Feed ${feedUrl}: HTTP ${res.status}`); return { newDocs: 0, embedded: 0 }; }

    const items = parseFeed(await res.text());
    const fresh = items.filter(i => !this.db.prepare('SELECT 1 FROM docs WHERE url = ?').get(i.url)).slice(0, this.deps.config.maxPagesPerFeedPerCycle);
    let newDocs = 0, embedded = 0;
    for (const item of fresh) {
      // followLinks seeds (aggregators) index the TARGET page; content feeds
      // index their own item pages the same way — one code path.
      const r = await this.ingestPage(item.url, feedUrl, tags, item);
      newDocs += r.newDocs; embedded += r.embedded;
    }
    return { newDocs, embedded };
  }

  // --- page ingestion ---

  private async ingestPage(url: string, seedUrl: string, tags: string[], item: FeedItem | null): Promise<{ newDocs: number; embedded: number }> {
    if (!(await this.robotsAllows(url))) {
      console.log(`[WebIndex] robots.txt disallows ${url} — skipping`);
      return { newDocs: 0, embedded: 0 };
    }
    await this.politeness(url);
    const content = await this.deps.webFetch.execute({ url, extractMode: 'text', maxChars: '20000' }, { agentId: 'webindex', sessionKey: 'webindex' } as ToolContext);
    if (typeof content !== 'string' || content.startsWith('Error') || content.length < 200) return { newDocs: 0, embedded: 0 };

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const existing = this.db.prepare('SELECT hash FROM docs WHERE url = ?').get(url) as { hash?: string } | undefined;
    if (existing?.hash === hash) return { newDocs: 0, embedded: 0 };

    const title = item?.title ?? (content.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 140) ?? url);
    const meta: IndexedDocMeta = {
      url, title, publishedAt: item?.publishedAt ?? null, fetchedAt: new Date().toISOString(),
      hash, tags: tags.join(','), seedUrl, status: 'pending',
    };
    this.db.prepare(`INSERT INTO docs (url, title, publishedAt, fetchedAt, hash, tags, seedUrl, status, text)
      VALUES (@url, @title, @publishedAt, @fetchedAt, @hash, @tags, @seedUrl, @status, @text)
      ON CONFLICT(url) DO UPDATE SET title=excluded.title, publishedAt=excluded.publishedAt, fetchedAt=excluded.fetchedAt, hash=excluded.hash, tags=excluded.tags, status='pending', text=excluded.text`)
      .run({ ...meta, text: content });

    const ok = await this.embedDoc(url, title, content);
    return { newDocs: 1, embedded: ok ? 1 : 0 };
  }

  /** Chunk + embed one doc into the EmbeddingStore. Failure leaves status='pending'. */
  private async embedDoc(url: string, title: string, text: string): Promise<boolean> {
    const chunks = chunkText(text, CHUNK_CHARS).slice(0, MAX_CHUNKS_PER_DOC);
    try {
      this.deps.embeddings.deleteBySourceFile(SOURCE, url);
      for (let i = 0; i < chunks.length; i++) {
        const [embedding] = await this.deps.client.embed(`${title}\n\n${chunks[i]}`, this.deps.embedModel);
        this.deps.embeddings.add({
          id: `webindex:${createHash('sha256').update(url + i).digest('hex').slice(0, 20)}`,
          text: chunks[i], file: url, section: `chunk-${i}`, embedding,
          savedAt: new Date().toISOString(), source: SOURCE,
        });
      }
      this.db.prepare(`UPDATE docs SET status = 'embedded' WHERE url = ?`).run(url);
      return true;
    } catch (err) {
      console.warn(`[WebIndex] Embedding failed for ${url} (stored as pending, will backfill):`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Retry embedding for docs stored during an embeddings outage. */
  private async backfillPending(): Promise<number> {
    const pending = this.db.prepare(`SELECT url, title, text FROM docs WHERE status = 'pending' LIMIT 20`).all() as Array<{ url: string; title: string; text: string }>;
    let done = 0;
    for (const d of pending) {
      if (await this.embedDoc(d.url, d.title, d.text)) done++;
    }
    return done;
  }

  // --- etiquette ---

  private async politeness(url: string): Promise<void> {
    const domain = new URL(url).hostname;
    const last = this.domainLastFetch.get(domain) ?? 0;
    const wait = this.deps.config.perDomainIntervalMs - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.domainLastFetch.set(domain, Date.now());
  }

  private async robotsAllows(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    let disallowed = this.robotsCache.get(origin);
    if (!disallowed) {
      disallowed = [];
      try {
        const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8_000) });
        if (res.ok) {
          // Honor the '*' agent group (we're a generic well-behaved bot)
          const text = await res.text();
          let applies = false;
          for (const line of text.split('\n')) {
            const ua = line.match(/^\s*User-agent:\s*(.+?)\s*$/i);
            if (ua) { applies = ua[1] === '*' || /invarail/i.test(ua[1]); continue; }
            const dis = line.match(/^\s*Disallow:\s*(\S+)/i);
            if (applies && dis && dis[1] !== '/') disallowed.push(dis[1]);
            if (applies && dis && dis[1] === '/') disallowed.push('/');
          }
        }
      } catch { /* unreachable robots = default allow */ }
      this.robotsCache.set(origin, disallowed);
    }
    const path = new URL(url).pathname;
    return !disallowed.some(prefix => path.startsWith(prefix));
  }

  // --- retrieval support (used by the local_search tool) ---

  docMeta(url: string): IndexedDocMeta | undefined {
    return this.db.prepare('SELECT url, title, publishedAt, fetchedAt, hash, tags, seedUrl, status FROM docs WHERE url = ?').get(url) as IndexedDocMeta | undefined;
  }

  stats(): { docs: number; embedded: number; pending: number; feeds: number } {
    const row = this.db.prepare(`SELECT count(*) AS docs, sum(status = 'embedded') AS embedded, sum(status = 'pending') AS pending FROM docs`).get() as { docs: number; embedded: number; pending: number };
    const feeds = (this.db.prepare('SELECT count(*) AS n FROM feeds').get() as { n: number }).n;
    return { ...row, feeds };
  }
}

/** Paragraph-aware chunking: split on blank lines, pack to ~size. */
export function chunkText(text: string, size: number): string[] {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paras) {
    if (current && current.length + p.length + 2 > size) { chunks.push(current); current = ''; }
    current = current ? `${current}\n\n${p}` : p;
    while (current.length > size) { chunks.push(current.slice(0, size)); current = current.slice(size); }
  }
  if (current) chunks.push(current);
  return chunks;
}
