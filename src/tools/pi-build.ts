import { mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import type { InvarailTool, ToolContext } from './types.js';
import type { PiConfigSchema } from '../config/schema.js';
import { PiCodingAdapter } from '../coding/pi-session.js';
import { slugify } from '../utils/text.js';

type PiConfig = z.infer<typeof PiConfigSchema>;

/**
 * Pi build tool — CODE-DRIVEN coding agent, driven through the Pi SDK adapter
 * (src/coding/pi-session.ts), not a CLI spawn.
 *
 * Inversion of control kept intact: the code_gen pipeline owns the workflow (enrich → build →
 * verify → fix → report); this tool is the bounded "make the files" slot. Pi runs cwd-scoped to
 * the project directory (SDK tools are bound to the session cwd), so files land where they belong
 * and the agent can't write outside the build dir by default.
 *
 * Returns a string containing `Project directory: <dir>` and `session: <slug>` so the existing
 * code_gen pipeline's extractors keep working unchanged.
 */

const QUALITY_STANDARDS = [
  '',
  'QUALITY STANDARDS:',
  '- Create all project files in the current directory.',
  '- Tests MUST make real HTTP requests or function calls — no mocked assertions against hardcoded values.',
  '- Tests should start the server/app, make actual requests, and validate responses.',
  '- Include error case tests (invalid input, missing fields, not found).',
  '- Code should have proper error handling, not just the happy path.',
  '- Include a dependency file (package.json, requirements.txt, go.mod) with correct dependencies.',
].join('\n');

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === '__pycache__' || f === '.venv') continue;
      const full = join(dir, f);
      const rel = prefix ? `${prefix}/${f}` : f;
      if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
      else out.push(rel);
    }
  } catch { /* best-effort */ }
  return out;
}

export function createPiBuildTool(config: PiConfig, adapter?: PiCodingAdapter, memory?: import('../coding/coding-memory.js').CodingMemoryDeps): InvarailTool {
  const pi = adapter ?? new PiCodingAdapter(config);
  return {
    name: 'pi_build',
    description: `Build code with the Pi coding agent. Pi reads, writes, and edits files in an isolated project directory to implement the requested feature or project.
WHEN TO USE: User asks to build, scaffold, implement, or write code for a project or feature.
Returns the project directory and a list of files created.`,
    parameterDescription: 'prompt (required): what to build. projectName (optional): name for a new project. projectDir + sessionId (optional): an existing project to modify/fix.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of what to build, or fix instructions for an existing project' },
        projectName: { type: 'string', description: 'Name for a new project (slugified into the build dir)' },
        projectDir: { type: 'string', description: 'Existing project directory (for fix/modify)' },
        sessionId: { type: 'string', description: 'Reuse marker for an existing project (for fix/modify)' },
        model: { type: 'string', description: 'Pi model id (provider/id), default from config' },
      },
      required: ['prompt'],
    },
    category: 'code',
    // Builds are cwd-scoped with local git commits; remote push is separately config-gated.

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const prompt = (params.prompt as string)?.trim();
      if (!prompt) return 'Error: prompt is required';

      const model = (params.model as string) || config.model;
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';
      const buildsDir = join(workspace, 'builds');
      const existingProjectDir = params.projectDir as string | undefined;

      // New build vs fix/modify. For fix, reuse the given dir (Pi reads existing files there);
      // for new, derive the dir from projectName and append quality standards.
      let projectDir: string;
      let slug: string;
      let fullPrompt: string;
      const isFix = !!existingProjectDir;

      if (isFix) {
        projectDir = existingProjectDir!;
        slug = projectDir.split('/').pop() || 'project';
        fullPrompt = prompt;
      } else {
        slug = slugify((params.projectName as string) || '');
        projectDir = join(buildsDir, slug);
        mkdirSync(projectDir, { recursive: true });
        fullPrompt = prompt + '\n' + QUALITY_STANDARDS;
      }

      console.log(`[Pi] ${isFix ? 'Fixing' : 'Building'} "${slug}" with ${model} (cwd-scoped, SDK)...`);
      let result;
      try {
        let memorySearch: ((q: string) => Promise<string>) | undefined;
        if (memory) {
          const { buildPriorExperienceBrief, buildMemorySearchCallback } = await import('../coding/coding-memory.js');
          const brief = await buildPriorExperienceBrief(prompt, memory).catch(() => '');
          if (brief) fullPrompt = fullPrompt + brief;
          memorySearch = buildMemorySearchCallback(memory);
        }
        result = await pi.runSession({ prompt: fullPrompt, cwd: projectDir, model, label: slug, taskCategory: 'code_gen', memorySearch });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Pi build failed: ${msg.slice(0, 500)}\nProject directory: ${projectDir}\nsession: ${slug}`;
      }

      if (!result.ok && !readdirSync(projectDir).some(f => !f.startsWith('.'))) {
        // Failed AND nothing written — a real failure, surface it.
        const reason = result.timedOut ? `timed out after ${config.timeout}ms` : (result.error ?? 'unknown error');
        return `Pi build failed (${reason.slice(0, 500)})\nProject directory: ${projectDir}\nsession: ${slug}`;
      }

      const files = listFiles(projectDir);
      const parts = [`Pi build complete (session: ${slug}, project: ${slug})`, '', `Files created (${files.length}):`];
      let totalChars = 0;
      for (const f of files.slice(0, 10)) {
        if (f.endsWith('.lock') || f.endsWith('.log')) { parts.push(`  ${f} (skipped — generated)`); continue; }
        try {
          const content = readFileSync(join(projectDir, f), 'utf-8');
          const preview = content.length > 600 ? content.slice(0, 600) + '\n...(truncated)' : content;
          totalChars += preview.length;
          if (totalChars > 6000) parts.push(`  ${f} (${content.length} bytes — omitted for space)`);
          else parts.push(`\n--- ${f} ---\n${preview}`);
        } catch { parts.push(`  ${f} (could not read)`); }
      }
      parts.push('', `Project directory: ${projectDir}`);
      return parts.join('\n');
    },
  };
}
