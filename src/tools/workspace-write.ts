import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { InvarailTool, ToolContext } from './types.js';

// USER.md is deliberately NOT here (2026-09-20). It is the owner's hand-written
// identity card — name, family, company — and the agent used to be able to
// overwrite the whole file. That made two stores of overlapping facts with no
// rule for which wins, and put identity one bad model turn from erasure.
// Identity is a rule, not an observation: the file is authoritative and the
// agent reads it. What the agent learns goes through memory_save.
const WRITABLE_FILES = ['TOOLS.md', 'HEARTBEAT.md'] as const;
const PROTECTED_FILES = ['USER.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'BOOTSTRAP.md'] as const;

export function createWorkspaceWriteTool(): InvarailTool {
  return {
    name: 'workspace_write',
    description: `Write to a workspace file. Writable files: ${WRITABLE_FILES.join(', ')}. Protected files (${PROTECTED_FILES.join(', ')}) are read-only. DO NOT use this to record things you learn about the user — USER.md is theirs; use memory_save.`,
    parameterDescription: `file (required): Filename to write. One of: ${WRITABLE_FILES.join(', ')}. content (required): New file content (full overwrite).`,
    example: 'workspace_write[{"file": "TOOLS.md", "content": "# Tools\\n\\nUpdated tool documentation..."}]',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: `Workspace file to write`, enum: [...WRITABLE_FILES] },
        content: { type: 'string', description: 'New file content (full overwrite)' },
      },
      required: ['file', 'content'],
    },
    category: 'config',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const file = params.file as string;
      const content = params.content as string;
      if (!file) return 'Error: file parameter is required';
      if (content === undefined) return 'Error: content parameter is required';

      if (!WRITABLE_FILES.includes(file as any)) {
        const hint = file === 'USER.md' ? ' USER.md is the owner\'s own profile — save what you learned with memory_save instead.' : '';
        return `Error: "${file}" is not writable. Writable files: ${WRITABLE_FILES.join(', ')}. Protected: ${PROTECTED_FILES.join(', ')}.${hint}`;
      }

      const workspace = ctx.workspacePath;
      if (!workspace) {
        return 'Error: No workspace configured';
      }

      const fullPath = resolve(workspace, file);
      if (!fullPath.startsWith(resolve(workspace))) {
        return 'Error: Path traversal not allowed';
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
        return `Updated ${file}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
