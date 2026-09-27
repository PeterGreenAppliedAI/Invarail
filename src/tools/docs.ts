import type { InvarailTool } from './types.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchVault, storeDocument, listDomains, reindexVault } from '../knowledge/vault.js';
import { ensureFrontMatter, isReservedName } from '../knowledge/okf.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

/**
 * Vault document tools — the domain-organized document store as source of truth.
 * Folders under the vault path ARE the taxonomy (business/, coding/, ...).
 */

export interface DocsToolOptions {
  /** false = no embedder: lexical (exact terms, names) only. */
  embed?: boolean;
  /** OKF vault: index.md per folder is the map — read it before searching broadly. */
  okf?: boolean;
}

export function createDocsSearchTool(vaultPath: string, store: EmbeddingStore, client: OllamaClient, options: DocsToolOptions = {}): InvarailTool {
  const embed = options.embed ?? true;
  return {
    name: 'docs_search',
    description: `Search the owner's curated document vault (their authoritative notes: principles, rubrics, operating procedures, business context). WHEN TO USE: the question touches the owner's own standards, procedures, clients, or documented knowledge — the vault OUTRANKS general memory for anything it covers. DO NOT use for current events (web_search) or conversational recall (memory_search).${embed ? '' : ' Matching is by exact words and names (no semantic search) — use the terms the note would use.'}${options.okf ? ' Each folder has an index.md listing its documents with one-line descriptions: docs_read it first when unsure where something lives.' : ''} Domains are folders: ${listDomains(vaultPath).join(', ') || '(none yet)'}.`,
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

      const passages = await searchVault({ query, domain, store, client, embed });
      if (passages.length === 0) {
        return `No vault documents matched "${query}"${domain ? ` in ${domain}/` : ''}. Available domains: ${domains.join(', ') || '(vault is empty)'}.`;
      }
      return passages
        .map(p => `[${p.file} › ${p.headingPath}]\n${p.text}`)
        .join('\n\n---\n\n');
    },
  };
}

export function createDocsStoreTool(vaultPath: string, store: EmbeddingStore, client: OllamaClient, options: DocsToolOptions = {}): InvarailTool {
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
      if (options.okf) ensureFrontMatter(path, { type: 'Note', title });   // §11: every concept carries a type
      // Index immediately so the document is searchable this conversation
      try {
        await reindexVault(vaultPath, store, client, { embed: options.embed ?? true, okf: options.okf });
      } catch (err) {
        return `Saved to ${path} — indexing deferred to the next heartbeat (${err instanceof Error ? err.message : err})`;
      }
      return `Saved and indexed: ${path}`;
    },
  };
}

/** Read one vault file by bundle-relative path — index.md and log.md included. This is how
 *  a small model navigates an OKF vault: read the index, then the one document it needs. */
export function createDocsReadTool(vaultPath: string): InvarailTool {
  return {
    name: 'docs_read',
    description: `Read a document from the owner's vault by path, e.g. "index.md" (the map of every folder), "business/index.md" (one folder's listing with one-line descriptions), or "business/onboarding.md". WHEN TO USE: to find where something lives before searching, or to read a whole document docs_search only returned a passage of. DO NOT use for files outside the vault (read_file).`,
    parameterDescription: 'path (required): vault-relative path, e.g. "index.md" or "coding/rubric.md"',
    example: 'docs_read[{"path": "index.md"}]',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Vault-relative path' } }, required: ['path'] },
    category: 'knowledge',
    requiresConfirm: false,
    async execute(params: Record<string, unknown>): Promise<string> {
      const rel = String(params.path ?? '').trim().replace(/^\/+/, '');
      if (!rel) return 'Error: path is required';
      const root = resolve(vaultPath);
      const full = resolve(root, rel);
      const inside = relative(root, full);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) return 'Error: path must be inside the vault';
      if (!existsSync(full) || !statSync(full).isFile()) {
        return `Not found: ${rel}. ${isReservedName(rel) ? 'This folder has no index yet — it is written on the next heartbeat.' : `Domains: ${listDomains(vaultPath).join(', ') || '(vault is empty)'}; try docs_read index.md`}`;
      }
      const text = readFileSync(full, 'utf-8');
      return text.length > 12000 ? `${text.slice(0, 12000)}\n\n[truncated — ${text.length} chars; ask docs_search for the part you need]` : text;
    },
  };
}
