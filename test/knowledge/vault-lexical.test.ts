import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { reindexVault, searchVault } from '../../src/knowledge/vault.js';
import type { OllamaClient } from '../../src/ollama/client.js';

/** No embedder at all: any embed call is a bug on this tier. */
function noEmbedder(): OllamaClient {
  return { embed: vi.fn().mockRejectedValue(new Error('embeddings disabled')) } as unknown as OllamaClient;
}

function fixture() {
  const v = mkdtempSync(join(tmpdir(), 'vault-lex-'));
  mkdirSync(join(v, 'business'));
  writeFileSync(join(v, 'business', 'onboarding.md'), '---\ntype: Playbook\ntitle: Client onboarding\ndescription: Kickoff in week one\n---\n# Client onboarding\n\n## Kickoff\n\nEvery client gets a kickoff document and a shared Slack channel within the first week. Gate 4 applies to the security review.\n');
  writeFileSync(join(v, 'business', 'index.md'), '# stale index that must not be indexed as a concept\n');
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
