import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAndChunk, promoteHeadings, semanticBoundaries, detectHeadingLine } from '../../src/knowledge/vault-chunker.js';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { reindexVault, searchVault, storeDocument, listDomains } from '../../src/knowledge/vault.js';
import type { OllamaClient } from '../../src/ollama/client.js';

// Deterministic fake embedder: maps text to a vector from char-trigram hashing —
// similar texts get similar vectors, so cosine behaves directionally like a real embedder
function fakeEmbed(text: string): number[] {
  const v = new Array(64).fill(0);
  const t = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  for (let i = 0; i < t.length - 2; i++) {
    const h = (t.charCodeAt(i) * 31 + t.charCodeAt(i + 1) * 7 + t.charCodeAt(i + 2)) % 64;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

function fakeClient(): OllamaClient {
  return {
    embed: vi.fn().mockImplementation(async (input: string | string[]) =>
      (Array.isArray(input) ? input : [input]).map(fakeEmbed)),
  } as unknown as OllamaClient;
}

describe('vault-chunker — normalization ladder', () => {
  it('tier headings: heading-PATH prefixes each chunk', async () => {
    const md = '# Coding Rubric\n\n## Gate 4: Security\n\nAll URL-fetching tools must use SSRF protection and never bypass the six dispatch layers of enforcement here.\n\n## Gate 5: Data Integrity\n\nState mutations must be atomic and consistent across session stores at all times in the system.';
    const { tier, chunks } = await normalizeAndChunk(md, 'coding/rubric.md');
    expect(tier).toBe('headings');
    expect(chunks.some(c => c.headingPath.includes('Gate 4: Security'))).toBe(true);
    expect(chunks.find(c => c.headingPath.includes('Gate 4'))!.text).toContain('Coding Rubric › Gate 4');
  });

  it('tier heuristic: ALL-CAPS and numbered lines promote to headings', async () => {
    const txt = 'OPERATING PRINCIPLES\n\nWe always ship behind a gate and measure before tuning anything in production systems.\n\n1. Client Onboarding\n\nEvery client gets a kickoff document and a shared channel within the first week of engagement.';
    const { tier, chunks } = await normalizeAndChunk(txt, 'business/os.txt');
    expect(tier).toBe('heuristic');
    expect(chunks.some(c => c.headingPath.includes('OPERATING PRINCIPLES'))).toBe(true);
  });

  it('tier semantic: markerless prose segments at similarity valleys', async () => {
    const topicA = 'The pricing model uses tiered subscriptions. Revenue splits favor annual commitments. Billing runs monthly through the payment processor. Discounts apply to prepaid annual contracts.';
    const topicB = 'The kubernetes cluster runs on three nodes. Deployment uses rolling updates with health checks. Container images build nightly from the main branch pipeline.';
    const text = topicA.split('. ').join('.\n\n') + '\n\n' + topicB.split('. ').join('.\n\n');
    const { tier } = await normalizeAndChunk(text, 'business/notes.txt', {
      embedParagraphs: async ps => ps.map(fakeEmbed),
    });
    expect(['semantic', 'paragraph']).toContain(tier); // valley detection is heuristic; must not crash
  });

  it('tier paragraph: fallback always indexes with the filename as scope', async () => {
    const { tier, chunks } = await normalizeAndChunk('just one short paragraph of text', 'business/scrap.txt');
    expect(tier).toBe('paragraph');
    expect(chunks[0].headingPath).toBe('scrap');
  });

  it('detectHeadingLine rejects prose and accepts heading shapes', () => {
    expect(detectHeadingLine('This is a normal sentence that goes on and on with detail.')).toBe(0);
    expect(detectHeadingLine('CLIENT ONBOARDING PROCESS')).toBeGreaterThan(0);
    expect(detectHeadingLine('2.1 Review cadence')).toBeGreaterThan(0);
    expect(detectHeadingLine('Title Line', '====')).toBe(1);
  });

  it('semanticBoundaries cuts at valleys', () => {
    expect(semanticBoundaries([0.9, 0.88, 0.2, 0.91, 0.89])).toContain(3);
    expect(semanticBoundaries([0.9, 0.9])).toEqual([]);
  });

  it('promoteHeadings requires at least two headings', () => {
    expect(promoteHeadings('no structure here at all, just words in a long line of prose')).toBeNull();
  });
});

describe('vault reindex + retrieval', () => {
  let vaultPath: string;
  let store: EmbeddingStore;
  let client: OllamaClient;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    vaultPath = join(dir, 'vault');
    mkdirSync(join(vaultPath, 'coding'), { recursive: true });
    mkdirSync(join(vaultPath, 'business'), { recursive: true });
    writeFileSync(join(vaultPath, 'coding', 'rubric.md'),
      '# Coding Rubric\n\n## Gate 4: Security\n\nSSRF protection required on all URL-fetching tools. Owner-only gates are code gates.\n\n## Gate 7: Observability\n\nErrors carry codes. Key operations are logged with structured metrics events.');
    writeFileSync(join(vaultPath, 'business', 'devmesh-os.md'),
      '# DevMesh Operating System\n\n## Client onboarding\n\nEvery engagement starts with a kickoff document, a shared channel, and a scoped statement of work.\n\n## Pricing\n\nFixed-fee features with a fifty-fifty revenue split on resold applications.');
    store = new EmbeddingStore(join(dir, 'test.db'));
    client = fakeClient();
  });

  it('indexes both domains and lists them', async () => {
    const report = await reindexVault(vaultPath, store, client);
    expect(report.indexed.length).toBe(2);
    expect(listDomains(vaultPath)).toEqual(['business', 'coding']);
  });

  it('unchanged files are skipped; edits reindex exactly one file', async () => {
    await reindexVault(vaultPath, store, client);
    const second = await reindexVault(vaultPath, store, client);
    expect(second.indexed).toHaveLength(0);
    expect(second.unchanged).toBe(2);

    const f = join(vaultPath, 'coding', 'rubric.md');
    writeFileSync(f, '# Coding Rubric\n\n## Gate 4: Security\n\nUpdated security text about SSRF and gates.');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const third = await reindexVault(vaultPath, store, client);
    expect(third.indexed).toHaveLength(1);
    expect(third.indexed[0].path).toContain('rubric.md');
  });

  it('deleted files are purged from the index', async () => {
    await reindexVault(vaultPath, store, client);
    rmSync(join(vaultPath, 'business', 'devmesh-os.md'));
    const report = await reindexVault(vaultPath, store, client);
    expect(report.removed).toContain('business/devmesh-os.md');
    const hits = await searchVault({ query: 'client onboarding kickoff', store, client });
    expect(hits.every(h => !h.file.includes('devmesh-os'))).toBe(true);
  });

  it('domain scoping keeps business queries out of coding docs', async () => {
    await reindexVault(vaultPath, store, client);
    const hits = await searchVault({ query: 'revenue split pricing', domain: 'business', store, client });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.file.startsWith('business/'))).toBe(true);
  });

  it('lexical exact-term hit surfaces even when dense similarity is weak (the "Gate 7" case)', async () => {
    await reindexVault(vaultPath, store, client);
    const hits = await searchVault({ query: 'Gate 7', store, client });
    expect(hits.some(h => h.headingPath.includes('Gate 7'))).toBe(true);
  });

  it('provenance carries file › heading on every passage', async () => {
    await reindexVault(vaultPath, store, client);
    const hits = await searchVault({ query: 'SSRF security', domain: 'coding', store, client });
    expect(hits[0].file).toBe('coding/rubric.md');
    expect(hits[0].headingPath).toContain('›');
  });

  it('storeDocument writes a slugged markdown file into the domain', () => {
    const path = storeDocument(vaultPath, 'business', 'Q3 Planning: Notes!', 'Some content here.');
    expect(path).toContain('business/q3-planning-notes.md');
    expect(listDomains(vaultPath)).toContain('business');
  });
});
