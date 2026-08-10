import type { InvarailTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { SkillStore } from '../skills/store.js';
import { findMatchingSkillHybrid } from '../skills/matcher.js';

/**
 * Progressive disclosure of saved skills to ReAct specialists: the catalog
 * stays out of the prompt; the model asks for a skill when the task smells
 * familiar. (Skills were previously reachable ONLY from the plan pipeline,
 * which most traffic no longer routes to — the system sat dead for months.)
 */
export function createSkillFindTool(client: OllamaClient): InvarailTool {
  return {
    name: 'skill_find',
    description: `Look up a saved workflow skill matching a task. Returns proven step sequences from past successful runs. WHEN TO USE: Before planning a multi-step task (reports, scheduling flows, site workflows) — a saved skill shows the exact steps that worked before. DO NOT invent skills; if nothing matches, plan normally.`,
    parameterDescription: `query (required): The task to find a skill for, in plain words.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task to find a saved skill for' },
      },
      required: ['query'],
    },
    example: 'skill_find[{"query": "make a PDF report from web research"}]',
    category: 'memory',
    resultLimit: 4000,

    async execute(params, ctx): Promise<string> {
      const query = String(params.query ?? '').trim();
      if (!query) return 'Error: query is required';
      if (!ctx.workspacePath) return 'No skill workspace available.';

      const store = new SkillStore(ctx.workspacePath);
      const catalog = store.list();
      if (catalog.length === 0) return 'No skills saved yet.';

      const match = await findMatchingSkillHybrid(store, client, query);
      if (!match) {
        const lines = catalog.map(s => `- ${s.name}: ${s.description.slice(0, 100)} (${s.successCount} successes)`);
        return `No close skill match. Saved skills:\n${lines.join('\n')}`;
      }

      const skill = store.get(match.slug);
      if (!skill) return 'No skills saved yet.';
      // NOTE: no recordSuccess here — looking up a skill is not completing it

      const steps = skill.steps.map((s, i) => `${i + 1}. [${s.tool}] ${JSON.stringify(s.params)}${s.purpose ? ` — ${s.purpose}` : ''}`);
      const notes = skill.notes.length ? `\nLearned notes:\n${skill.notes.map(n => `- ${n}`).join('\n')}` : '';
      return `Skill "${skill.name}" (${skill.successCount} past successes, matched via ${match.method}):\n${skill.description}\n\nProven steps (adapt messages to the current task):\n${steps.join('\n')}${notes}`;
    },
  };
}
