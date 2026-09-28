import { execFile } from 'node:child_process';
import { PYTHON_ALIASES } from '../exec/python.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InvarailTool, ToolContext } from './types.js';
import type { ExecConfig } from '../config/types.js';
import type { DockerBackend } from '../exec/docker-backend.js';

export function createExecTool(config?: ExecConfig, dockerBackend?: DockerBackend): InvarailTool {
  const allowlist = new Set(config?.allowlist ?? ['ls', 'cat', ...PYTHON_ALIASES, 'node', 'git']);
  const timeout = config?.timeout ?? 30_000;
  const useDocker = !!dockerBackend;

  return {
    name: 'exec',
    description: useDocker
      ? 'Run a shell command inside a sandboxed Docker container.'
      : `Run a shell command or inline code snippet. Allowed commands: ${[...allowlist].join(', ')}. NO SHELL OPERATORS: redirection (>) and pipes (|) do NOT work — output is returned to you; save it with write_file or write files from inside your code. You are ALREADY in your workspace directory: use paths relative to it (e.g. notes/x.md), NEVER prefix data/workspaces/... WHEN TO USE: Running shell commands, executing Python/Node code, system operations. DO NOT use exec for: reading files (use read_file), creating PDFs/documents (use document tool), searching memory (use memory_search).`,
    parameterDescription: 'command (required): The command to run. args (optional): Arguments for the command. code (optional): Inline code to execute — will be written to a temp file and run with the command as interpreter (e.g., command="python3", code="print(1+1)").',
    example: 'exec[{"command": "python3", "code": "import math; print(math.factorial(20))"}]',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: useDocker
            ? 'The command to run inside the sandbox'
            : `The command to run (or interpreter for inline code). Must be one of: ${[...allowlist].join(', ')}`,
        },
        args: { type: 'string', description: 'Space-separated arguments for the command' },
        code: { type: 'string', description: 'Inline code to execute. The command parameter becomes the interpreter (e.g., python3, node).' },
      },
      required: ['command'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      let command = params.command as string;
      if (!command) return 'Error: command parameter is required';

      // Handle args as string (split on spaces) or array
      let args: string[] = [];
      if (typeof params.args === 'string') {
        args = params.args.split(/\s+/).filter(Boolean);
      } else if (Array.isArray(params.args)) {
        args = params.args;
      }

      // Models — small ones every time, big ones often — put the whole command LINE in
      // `command` ("python3 fib.py > fib.txt"). execFile then looks for a binary literally
      // named that and fails with a spawn ENOENT the model cannot read (e2e eval 2026-09-27:
      // three retries into a code_session detour on a 9B). Accommodate at the boundary: split
      // the line into binary + args (quote-aware), and REFUSE shell operators with the reason
      // instead of letting the shell-less spawn fail cryptically.
      if (/\s/.test(command.trim()) && args.length === 0 && !params.code) {
        const unquoted = command.replace(/"[^"]*"|'[^']*'/g, '');
        if (/[|><&;`]|\$\(/.test(unquoted)) {
          return 'Error: shell operators (>, |, &&, ;, $()) do not work here — there is no shell. Run the command alone; its output is returned to you. To save output to a file, write it from inside your code or use write_file.';
        }
        const parts = command.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
        command = parts[0] ?? command;
        args = parts.slice(1).map(p => p.replace(/^(["'])(.*)\1$/, '$2'));
      }

      // Docker execution path — no allowlist needed
      if (dockerBackend) {
        try {
          const result = await dockerBackend.exec(command, args, timeout);
          const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          if (result.exitCode !== 0) {
            return `Error (exit ${result.exitCode}): ${output.slice(0, 5000)}`;
          }
          return output.slice(0, 5000) || '(no output)';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : err}`;
        }
      }

      // Allowlist execution path
      const baseCmd = command.split(/[\s/]/)[0];
      if (!allowlist.has(baseCmd)) {
        return `Error: Command "${baseCmd}" is not in the allowlist. Allowed: ${[...allowlist].join(', ')}`;
      }

      // Run from workspace directory so exec and write_file share the same cwd
      const cwd = ctx.workspacePath ?? process.cwd();

      // Inline code support: write to temp file, execute, clean up.
      // The temp path MUST be absolute: workspacePath is often RELATIVE, and passing a
      // relative arg to a child whose cwd is already that directory double-resolves it
      // (python: "can't open file" — found live 2026-08-20 when the arena's exec-code
      // calls all failed and pushed the model into -c quoting hell).
      const code = params.code as string | undefined;
      let tmpFile: string | undefined;
      if (code) {
        const ext = command === 'node' ? '.js' : '.py';
        tmpFile = resolve(cwd, `_tmp_${randomUUID().slice(0, 8)}${ext}`);
        writeFileSync(tmpFile, code);
        args = [tmpFile];
      }

      return new Promise((resolve) => {
        execFile(command, args, { timeout, maxBuffer: 1024 * 1024, cwd }, (err, stdout, stderr) => {
          // Clean up temp file
          if (tmpFile) try { unlinkSync(tmpFile); } catch { /* ignore */ }

          if (err) {
            const output = stderr || err.message;
            resolve(`Error (exit ${(err as any).code ?? '?'}): ${output.slice(0, 2000)}`);
            return;
          }
          const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
          resolve(output.slice(0, 5000) || '(no output)');
        });
      });
    },
  };
}
