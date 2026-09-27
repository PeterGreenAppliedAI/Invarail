import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { reindexVault, searchVault } from '../../src/knowledge/vault.js';
import { GENERATED_MARK } from '../../src/knowledge/okf.js';
import type { OllamaClient } from '../../src/ollama/client.js';

/** No embedder at all: any embed call is a bug on this tier. */
function noEmbedder(): OllamaClient {
  return { embed: vi.fn().mockRejectedValue(new Error('embeddings disabled')) } as unknown as OllamaClient;
}

function fixture() {
  const v = mkdtempSync(join(tmpdir(), 'vault-lex-'));
  mkdirSync(join(v, 'business'));
  writeFileSync(join(v, 'business', 'onboarding.md'), '---\ntype: Playbook\ntitle: Client onboarding\ndescription: Kickoff in week one\n---\n# Client onboarding\n\n## Kickoff\n\nEvery client gets a kickoff document and a shared Slack channel within the first week. Gate 4 applies to the security review.\n');
  // a stale index WE generated earlier (marked): never indexed as a concept, and regenerated on reindex
  writeFileSync(join(v, 'business', 'index.md'), `# stale index that must not be indexed as a concept\n\n${GENERATED_MARK}\n`);
  const store = new EmbeddingStore(join(v, '.index.db'));
  return { v, store };
}

describe('vault without an embedder (memory tier: vault)', () => {
  it('indexes lexically, never calls embed, skips reserved files, and lexical search finds exact terms', async () => {
    const { v, store } = fixture();
    const client = noEmbedder();
    const report = await reindexVault(v, store, client, { embed: false });
    expect(client.embed).not.toHaveBeenCalled();
    expect(report.indexed.map(i => i.path)).toEqual(['business/onboarding.md']);   // index.md skipped
    const hits = await searchVault({ query: 'Gate 4 security review', store, client, embed: false });
    expect(client.embed).not.toHaveBeenCalled();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('business/onboarding.md');
    expect(hits[0].text).toMatch(/Gate 4/);
  });

  it('indexes notes nested any depth under a domain (an Obsidian vault) and skips .obsidian', async () => {
    const { v, store } = fixture();
    mkdirSync(join(v, 'business', 'clients', 'acme'), { recursive: true });
    mkdirSync(join(v, '.obsidian'));
    writeFileSync(join(v, '.obsidian', 'workspace.md'), 'Gate 4 must not be indexed');
    writeFileSync(join(v, 'business', 'clients', 'acme', 'contract.md'), '# Acme contract\n\nRenewal is due 2026-11-30 with a 45-day notice clause.\n');
    const report = await reindexVault(v, store, noEmbedder(), { embed: false });
    expect(report.indexed.map(i => i.path).sort()).toEqual(['business/clients/acme/contract.md', 'business/onboarding.md']);
    const hits = await searchVault({ query: 'renewal notice clause', store, client: noEmbedder(), embed: false });
    expect(hits[0].file).toBe('business/clients/acme/contract.md');
  });

  it('with okf on, reindex writes index.md per domain and the root, and appends log.md', async () => {
    const { v, store } = fixture();
    await reindexVault(v, store, noEmbedder(), { embed: false, okf: true });
    expect(readFileSync(join(v, 'business', 'index.md'), 'utf-8')).toMatch(/\[Client onboarding\]\(onboarding\.md\) - Kickoff in week one/);
    expect(readFileSync(join(v, 'index.md'), 'utf-8')).toMatch(/okf_version/);
    expect(existsSync(join(v, 'log.md'))).toBe(true);
    expect(readFileSync(join(v, 'log.md'), 'utf-8')).toMatch(/\*\*Update\*\*: Indexed \[business\/onboarding\.md\]/);
    // unchanged vault: no new log lines
    const before = readFileSync(join(v, 'log.md'), 'utf-8');
    await reindexVault(v, store, noEmbedder(), { embed: false, okf: true });
    expect(readFileSync(join(v, 'log.md'), 'utf-8')).toBe(before);
  });
});
