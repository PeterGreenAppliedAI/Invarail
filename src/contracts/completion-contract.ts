import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatMaybeStructured } from '../pipeline/extractor.js';
import { parseJsonLoose } from '../pipeline/verification.js';
import { stripThinkingTags } from '../utils/text.js';
import type { OllamaClient } from '../ollama/client.js';
import type { TaskStore } from '../tasks/store.js';
import type { FactStore } from '../memory/fact-store.js';

/**
 * Completion contracts (DECISIONS 2026-08-20, "the harness fix"): the arena has walls but
 * had no exit criteria — a task "completed" when the model stopped talking, and a prose
 * judge graded the prose. Contracts close the gap: checkable postconditions are
 * PRE-REGISTERED before the loop starts (the model states the contract before it has any
 * incentive to game it — the duel's hidden-suite discipline, systematized), then CODE
 * verifies them against the world at natural stop. Unsatisfied after bounded retries →
 * an honest "could not verify completion" answer, never a synthesized success.
 *
 * The vocabulary is CLOSED and code-checkable only. Models never invent predicate kinds.
 */

export type Postcondition =
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_contains'; path: string; pattern: string }
  | { kind: 'task_exists'; pattern: string }
  | { kind: 'fact_saved'; pattern: string }
  | { kind: 'answer_mentions'; pattern: string };

export interface CompletionContract {
  /** false = nothing in the ask is code-verifiable → NO gate (degrade honestly) */
  checkable: boolean;
  postconditions: Postcondition[];
}

export interface ConditionResult {
  condition: Postcondition;
  pass: boolean;
  detail: string;
}

export interface ContractResult {
  checkable: boolean;
  pass: boolean;
  results: ConditionResult[];
  failed: ConditionResult[];
}

const CONTRACT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    checkable: { type: 'boolean' },
    postconditions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['file_exists', 'file_contains', 'task_exists', 'fact_saved', 'answer_mentions'] },
          path: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['kind'],
      },
    },
  },
  required: ['checkable', 'postconditions'],
};

const EXTRACT_SYSTEM = [
  'You extract VERIFIABLE completion conditions from a user request, BEFORE any work starts.',
  'Only use these condition kinds (they are checked by code, not by you):',
  '- file_exists {path}: a file the user asked to be created (workspace-relative path)',
  '- file_contains {path, pattern}: that file must contain a substring or /regex/',
  '- task_exists {pattern}: a to-do task whose title matches',
  '- fact_saved {pattern}: a memory fact containing the pattern',
  '- answer_mentions {pattern}: the final answer must mention this (weakest — only for pure information requests)',
  'Rules:',
  '- Patterns must come from the REQUEST (names, dates, subjects the user stated) — never invent specifics the user did not give.',
  '- Prefer strong conditions (files, tasks, facts) over answer_mentions.',
  '- If the request is conversational or nothing is code-verifiable, return {"checkable": false, "postconditions": []}.',
  '- At most 5 conditions. JSON only.',
].join('\n');

export async function extractContract(
  client: OllamaClient,
  model: string,
  userMessage: string,
): Promise<CompletionContract> {
  const raw = await chatMaybeStructured(client, model, [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Request: ${userMessage}\n\nReturn the completion contract JSON.` },
  ], CONTRACT_JSON_SCHEMA, 1024);
  const parsed = parseJsonLoose<{ checkable?: unknown; postconditions?: unknown }>(stripThinkingTags(raw));
  if (!parsed || typeof parsed.checkable !== 'boolean' || !Array.isArray(parsed.postconditions)) {
    // Extraction failure must never block dispatch — no contract, no gate.
    return { checkable: false, postconditions: [] };
  }
  const conditions: Postcondition[] = [];
  for (const c of parsed.postconditions.slice(0, 5)) {
    const o = c as Record<string, unknown>;
    const kind = String(o.kind ?? '');
    const path = typeof o.path === 'string' ? o.path.trim() : '';
    const pattern = typeof o.pattern === 'string' ? o.pattern.trim() : '';
    if (kind === 'file_exists' && path) conditions.push({ kind, path });
    else if (kind === 'file_contains' && path && pattern) conditions.push({ kind, path, pattern });
    else if ((kind === 'task_exists' || kind === 'fact_saved' || kind === 'answer_mentions') && pattern) {
      conditions.push({ kind, pattern } as Postcondition);
    }
    // Unknown kinds / missing fields are dropped — closed vocabulary, fail-safe.
  }
  return { checkable: parsed.checkable && conditions.length > 0, postconditions: conditions };
}

export interface ContractCheckDeps {
  workspacePath: string;
  answer: string;
  taskStore?: Pick<TaskStore, 'list'>;
  factStore?: Pick<FactStore, 'loadFactsJson'>;
  senderId?: string;
}

/** '/re/' → RegExp (case-insensitive); invalid regex degrades to a substring match on
 *  the INNER text (the slashes were syntax, not content); plain → substring. */
function matcher(pattern: string): (text: string) => boolean {
  const m = pattern.match(/^\/(.+)\/[a-z]*$/);
  let needle = pattern;
  if (m) {
    try {
      const re = new RegExp(m[1], 'i');
      return t => re.test(t);
    } catch {
      needle = m[1];
    }
  }
  const lower = needle.toLowerCase();
  return t => t.toLowerCase().includes(lower);
}

export function checkContract(contract: CompletionContract, deps: ContractCheckDeps): ContractResult {
  if (!contract.checkable || contract.postconditions.length === 0) {
    return { checkable: false, pass: true, results: [], failed: [] };
  }
  const results: ConditionResult[] = contract.postconditions.map(condition => {
    try {
      switch (condition.kind) {
        case 'file_exists': {
          const p = resolve(deps.workspacePath, condition.path);
          const pass = existsSync(p);
          return { condition, pass, detail: pass ? `${condition.path} exists` : `${condition.path} does not exist` };
        }
        case 'file_contains': {
          const p = resolve(deps.workspacePath, condition.path);
          if (!existsSync(p)) return { condition, pass: false, detail: `${condition.path} does not exist` };
          const text = readFileSync(p, 'utf-8');
          const pass = matcher(condition.pattern)(text);
          return { condition, pass, detail: pass ? `${condition.path} contains "${condition.pattern}"` : `${condition.path} (${text.length} chars) does not contain "${condition.pattern}"` };
        }
        case 'task_exists': {
          if (!deps.taskStore) return { condition, pass: false, detail: 'task board unavailable' };
          const match = matcher(condition.pattern);
          const pass = deps.taskStore.list().some(t => match(t.title));
          return { condition, pass, detail: pass ? `task matching "${condition.pattern}" exists` : `no task title matches "${condition.pattern}"` };
        }
        case 'fact_saved': {
          if (!deps.factStore) return { condition, pass: false, detail: 'memory unavailable' };
          const match = matcher(condition.pattern);
          const pass = deps.factStore.loadFactsJson(deps.senderId).some(f => match(f.text));
          return { condition, pass, detail: pass ? `fact matching "${condition.pattern}" saved` : `no saved fact matches "${condition.pattern}"` };
        }
        case 'answer_mentions': {
          const pass = matcher(condition.pattern)(deps.answer);
          return { condition, pass, detail: pass ? `answer mentions "${condition.pattern}"` : `answer does not mention "${condition.pattern}"` };
        }
      }
    } catch (err) {
      // A broken check must fail SAFE for the user (do not block completion on our bug)
      return { condition, pass: true, detail: `check errored (${err instanceof Error ? err.message : err}) — not counted against completion` };
    }
  });
  const failed = results.filter(r => !r.pass);
  return { checkable: true, pass: failed.length === 0, results, failed };
}

export function contractFeedback(failed: ConditionResult[]): string {
  return [
    'VERIFICATION FAILED — these required outcomes are not satisfied yet:',
    ...failed.map(f => `- ${f.detail}`),
    'Complete the missing work with your tools (real content, not placeholders), then give your final answer.',
  ].join('\n');
}

export function wrapAnswerHonestly(answer: string, failed: ConditionResult[]): string {
  return [
    '⚠️ I could not verify completion of this task. Unmet:',
    ...failed.map(f => `- ${f.detail}`),
    '',
    `What I did: ${answer}`,
  ].join('\n');
}
