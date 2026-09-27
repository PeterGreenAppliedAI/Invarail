import { readFileSync, existsSync } from 'node:fs';
import type { InvarailTool, ToolContext } from './types.js';
import { containedPath } from '../security/paths.js';

export function createMemoryGetTool(workspacePath: string): InvarailTool {
  return {
    name: 'memory_get',
    description: 'Read the contents of a memory file',
    parameterDescription: 'file (required): Path to the file relative to workspace (e.g., "MEMORY.md" or "memory/notes.md").',
    example: 'memory_get[{"file": "memory/notes.md"}]',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file relative to workspace (e.g., "MEMORY.md")' },
      },
      required: ['file'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
      const file = params.file as string;
      if (!file) return 'Error: file parameter is required';

      // The dispatching agent's workspace, not the one captured at registration (review
      // F16): a secondary agent read the default agent's memory. Canonical containment —
      // `startsWith` accepted the sibling `main2/` for workspace `main`.
      const root = ctx?.workspacePath || workspacePath;
      const fullPath = containedPath(root, file);
      if (!fullPath) {
        return 'Error: Path traversal not allowed';
      }

      if (!existsSync(fullPath)) {
        return `File not found: ${file}`;
      }

      try {
        return readFileSync(fullPath, 'utf-8');
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
