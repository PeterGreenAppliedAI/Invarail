import { toolNotFound } from '../errors.js';
import type { LocalClawTool, ToolDefinition, ToolExecutor, ToolContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, LocalClawTool>();

  register(tool: LocalClawTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): LocalClawTool | undefined {
    return this.tools.get(name);
  }

  getByCategory(category: string): LocalClawTool[] {
    return [...this.tools.values()].filter(t => t.category === category);
  }

  /** Expand "mcp:<server>" tokens in a specialist's tool list into that server's
   *  registered tool names. Plain names pass through untouched. */
  expandToolNames(names: string[]): string[] {
    return names.flatMap(n => {
      if (!n.startsWith('mcp:')) return [n];
      const matched = this.getByCategory(n).map(t => t.name);
      if (matched.length === 0) {
        console.warn(`[Tools] Specialist references "${n}" but no tools are registered for it (server down or misnamed?)`);
      }
      return matched;
    });
  }

  getDefinitions(names: string[]): ToolDefinition[] {
    return names
      .map(n => this.tools.get(n))
      .filter((t): t is LocalClawTool => t !== undefined)
      .map(({ name, description, parameterDescription, parameters, example, resultLimit }) => ({
        name,
        description,
        parameterDescription,
        parameters,
        example,
        resultLimit,
      }));
  }

  createExecutor(): ToolExecutor {
    return async (toolName: string, params: Record<string, unknown>, ctx: ToolContext) => {
      const tool = this.tools.get(toolName);
      if (!tool) throw toolNotFound(toolName);
      return tool.execute(params, ctx);
    };
  }

  /**
   * Create a scoped executor that only allows specified tools.
   * Final enforcement gate — tools not in the allowlist are rejected
   * regardless of what the model requests.
   */
  createScopedExecutor(allowedTools: Set<string>): ToolExecutor {
    return async (toolName: string, params: Record<string, unknown>, ctx: ToolContext) => {
      if (!allowedTools.has(toolName)) {
        console.warn(`[ToolRegistry] Blocked unauthorized tool call: ${toolName}`);
        return `Error: Tool "${toolName}" is not available in this context.`;
      }
      const tool = this.tools.get(toolName);
      if (!tool) throw toolNotFound(toolName);
      return tool.execute(params, ctx);
    };
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  /** Detect tools the user explicitly named in their message. Explicit naming
   *  is a code gate: it outranks learned habit (skill matching) and enables
   *  flow-first gathering. For MCP-prefixed tools the bare downstream name
   *  also matches ("weekly_gather" → flows_weekly_gather) — users say the
   *  bare name; the prefix is bridge plumbing. */
  findExplicitToolMentions(message: string, candidateNames: string[]): string[] {
    const mentioned: string[] = [];
    for (const name of candidateNames) {
      const tool = this.tools.get(name);
      const aliases = [name];
      if (tool?.category.startsWith('mcp:')) {
        const server = tool.category.slice(4);
        if (name.startsWith(`${server}_`)) aliases.push(name.slice(server.length + 1));
      }
      const hit = aliases.some(a =>
        new RegExp(`(?<![A-Za-z0-9_])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(message));
      if (hit) mentioned.push(name);
    }
    return mentioned;
  }

  /** Tools that declare requiresConfirm — the structural default for the
   *  confirm gate, independent of channel config. */
  getMetadataConfirmTools(): Set<string> {
    const set = new Set<string>();
    for (const tool of this.tools.values()) {
      if (tool.requiresConfirm) set.add(tool.name);
    }
    return set;
  }
}
