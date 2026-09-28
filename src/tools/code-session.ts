import type { ChildProcess } from 'node:child_process';
import type { InvarailTool, ToolContext } from './types.js';
import type { SessionManager, SessionRuntime } from '../exec/session-manager.js';

/** What the Docker backend offers a session: the container, and a REPL inside it. */
export interface SessionSandbox {
  ensureRunning(): Promise<void>;
  spawnSession(runtime: string): ChildProcess;
}

/**
 * With a sandbox (exec security = docker) every REPL runs INSIDE the sandbox container —
 * the same wall the exec tool has. Reviews F05/F06 (2026-09-27): code sessions ran on the
 * host regardless of the Docker setting, because the backend's `spawnSession` and the
 * manager's `startFromProcess` existed and nothing connected them.
 */
export function createCodeSessionTool(
  sessionManager: SessionManager,
  sandbox?: SessionSandbox,
): InvarailTool {
  return {
    name: 'code_session',
    description: `Manage persistent code sessions${sandbox ? ' (each REPL runs inside the Docker sandbox: no network, the workspace mounted read-only — return results as output, write files with write_file)' : ''}. Start a REPL, run code that preserves state between calls, get output, or close sessions.`,
    parameterDescription: 'action (required): start/run/output/close/list. session (required for start/run/output/close): Session name. runtime (required for start): python/node/bash. code (required for run): Code to execute.',
    example: 'code_session[{"action": "start", "session": "analysis", "runtime": "python"}]',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['start', 'run', 'output', 'close', 'list'] },
        session: { type: 'string', description: 'Session name/ID' },
        runtime: { type: 'string', description: 'Runtime for new session', enum: ['python', 'node', 'bash'] },
        code: { type: 'string', description: 'Code to run in the session' },
      },
      required: ['action'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
      const action = params.action as string;
      const runtime = params.runtime as SessionRuntime;
      const code = params.code as string;
      // F18: a REPL belongs to the principal + agent that started it. The manager keys by a
      // scoped id; the model only ever sees its own short names, and another principal's
      // session of the same name is simply not there.
      const scope = `${ctx?.agentId ?? 'main'}/${ctx?.senderId ?? 'anonymous'}/`;
      const short = params.session as string | undefined;
      const sessionId = short ? `${scope}${short}` : (short as string);
      const unscope = (s: string): string => s.split(scope).join('');

      switch (action) {
        case 'start': {
          if (!sessionId) return 'Error: session parameter is required for start';
          if (!runtime) return 'Error: runtime parameter is required for start';
          if (sandbox) {
            try {
              await sandbox.ensureRunning();
            } catch (err) {
              // Fail CLOSED: a session that cannot be sandboxed does not silently run on the host.
              return `Error: sandbox unavailable (${err instanceof Error ? err.message : err}) — no session started`;
            }
            return unscope(sessionManager.startFromProcess(sessionId, runtime, sandbox.spawnSession(runtime)));
          }
          return unscope(sessionManager.start(sessionId, runtime));
        }

        case 'run': {
          if (!sessionId) return 'Error: session parameter is required for run';
          if (!code) return 'Error: code parameter is required for run';
          return unscope(await sessionManager.run(sessionId, code));
        }

        case 'output': {
          if (!sessionId) return 'Error: session parameter is required for output';
          return unscope(sessionManager.getOutput(sessionId));
        }

        case 'close': {
          if (!sessionId) return 'Error: session parameter is required for close';
          return unscope(sessionManager.close(sessionId));
        }

        case 'list': {
          const sessions = sessionManager.list().filter(s => s.id.startsWith(scope));
          if (sessions.length === 0) return 'No active sessions';
          return sessions
            .map(s => `- ${unscope(s.id)} (${s.runtime}, started ${s.startedAt}, ${s.outputBytes} bytes output)`)
            .join('\n');
        }

        default:
          return `Error: Unknown action "${action}". Use: start, run, output, close, list`;
      }
    },
  };
}
