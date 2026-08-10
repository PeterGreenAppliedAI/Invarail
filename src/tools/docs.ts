import type { InvarailTool } from './types.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchVault, storeDocument, listDomains, reindexVault } from '../knowledge/vault.js';

/**
 * Vault document tools — the domain-organized document store as source of truth.
 * Folders under the vault path ARE the taxonomy (business/, coding/, ...).
 */

export function createDocsSearchTool(vaultPath: string, store: EmbeddingStore, client: OllamaClient): InvarailTool {
  return {
    name: 'docs_search',
    description: `Search the owner's curated document vault (their authoritative notes: principles, rubrics, operating procedures, business context). WHEN TO USE: the question touches the owner's own standards, procedures, clients, or documented knowledge — the vault OUTRANKS general memory for anything it covers. DO NOT use for current events (web_search) or conversational recall (memory_search). Domains are folders: ${listDomains(vaultPath).join(', ') || '(none yet)'}.`,
    parameterDescription: 'query (required): what to find. domain (optional): folder to scope to (e.g. "business", "coding"); omit to search all.',
    example: 'docs_search[{"query": "what does the failure semantics gate require", "domain": "coding"}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        domain: { type: 'string', description: 'Domain folder to scope the search (omit for all domains)' },
      },
      required: ['query'],
    },
    category: 'knowledge',
    requiresConfirm: false,

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = String(params.query ?? '').trim();
      if (!query) return 'Error: query is required';
      const domains = listDomains(vaultPath);
      let domain = params.domain ? String(params.domain).toLowerCase().trim() : undefined;
      if (domain && !domains.includes(domain)) {
        domain = undefined; // unknown domain → search all, note it
      }

      const passages = await searchVault({ query, domain, store, client });
      if (passages.length === 0) {
        return `No vault documents matched "${query}"${domain ? ` in ${domain}/` : ''}. Available domains: ${domains.join(', ') || '(vault is empty)'}.`;
      }
      return passages
        .map(p => `[${p.file} › ${p.headingPath}]\n${p.text}`)
        .join('\n\n---\n\n');
    },
  };
}

export function createDocsStoreTool(vaultPath: string, store: EmbeddingStore, client: OllamaClient): InvarailTool {
  return {
    name: 'docs_store',
    description: `Save a document into the owner's vault under a domain folder. WHEN TO USE: the user asks to save/store context, notes, principles, or procedures as a document ("save this as business context"). DO NOT use for short facts (memory_save) or files (write_file). Existing domains: ${listDomains(vaultPath).join(', ') || '(none — a new folder is created)'}.`,
    parameterDescription: 'domain (required): folder, e.g. "business". title (required): document title. content (required): markdown body.',
    example: 'docs_store[{"domain": "business", "title": "DevMesh onboarding flow", "content": "## Steps\\n1. ..."}]',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain folder (created if new)' },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Markdown content' },
      },
      required: ['domain', 'title', 'content'],
    },
    category: 'knowledge',

    async execute(params: Record<string, unknown>): Promise<string> {
      const domain = String(params.domain ?? '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
      const title = String(params.title ?? '').trim();
      const content = String(params.content ?? '').trim();
      if (!domain || !title || !content) return 'Error: domain, title, and content are all required';

      const path = storeDocument(vaultPath, domain, title, content);
      // Index immediately so the document is searchable this conversation
      try {
        await reindexVault(vaultPath, store, client);
      } catch (err) {
        return `Saved to ${path} — indexing deferred to the next heartbeat (${err instanceof Error ? err.message : err})`;
      }
      return `Saved and indexed: ${path}`;
    },
  };
}
