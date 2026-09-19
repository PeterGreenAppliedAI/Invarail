import type { ToolDefinition } from '../tools/types.js';

export interface PromptContext {
  specialistPrompt?: string;
  workspaceContext?: string;
  channel?: string;
  isVoice?: boolean;
  statePreamble?: string;
  workspacePath?: string;
  /** Stable user facts injected as context so specialists know who they're talking to. */
  userPriming?: string;
}

/**
 * Build the ReAct system prompt for a specialist.
 *
 * Prompt ordering follows primacy/recency bias research:
 *   TOP (highest weight):  Role + Task — what the model is doing right now
 *   MIDDLE:                Channel, Tools, Persona
 *   BOTTOM (second highest): Format rules + constraints
 *
 * PREFIX-CACHE CONTRACT (2026-09-19): this prompt must stay BYTE-IDENTICAL across
 * the turns of a session. Every inference backend worth using caches the KV state of
 * a shared prompt prefix; change one token near the front and the whole prompt —
 * conversation history included — re-prefills. Measured on a Mac Mini: 8K-token
 * prefill is 61s cold and 0.3s when the prefix holds. So per-turn volatile content
 * (session state, retrieved memory) does NOT belong here — it goes in the volatile
 * tail via buildVolatileContext(), injected right before the user's message.
 */
export function buildReActSystemPrompt(
  specialistPrompt: string | undefined,
  tools: ToolDefinition[],
  workspaceContext?: string,
  promptContext?: PromptContext,
  toolStyle: 'native' | 'text' = 'native',
): string {
  const today = new Date().toISOString().split('T')[0];
  const sections: string[] = [];

  // ── TOP: Role + Task (primacy position) ──
  // The specialist prompt IS the role and task. Lead with it.
  if (specialistPrompt) {
    sections.push(specialistPrompt);
  } else {
    sections.push('You are a helpful AI assistant.');
  }

  sections.push(`Today's date is ${today}.`);

  // ── Channel context — unambiguous, one line ──
  if (promptContext?.channel) {
    sections.push(`You are responding via the ${promptContext.channel} channel.`);
  }

  // ── Voice mode ──
  if (promptContext?.isVoice) {
    sections.push('IMPORTANT: This is a voice conversation. Your response will be spoken aloud via TTS. Keep responses concise. Do NOT use emojis, markdown formatting, bullet points, or special characters. Use plain conversational English only.');
  }

  // ── Workspace path ──
  if (promptContext?.workspacePath) {
    sections.push(`Workspace directory: "${promptContext.workspacePath}" — user scripts, notes, and workspace files are stored here.`);
  }

  // NOTE: session state and retrieved memory used to sit HERE. They change every
  // turn, so they invalidated the cached prefix for the entire prompt below them —
  // including all conversation history. They now ride the volatile tail instead
  // (buildVolatileContext), which also puts them in the recency position.

  // ── Tools — text style only. In native style the tool schemas travel via the
  // API tools field and the model's own template; duplicating them here doubles
  // the prompt AND teaches a second, contradictory calling convention.
  if (tools.length > 0 && toolStyle === 'text') {
    const toolLines = ['## Available Tools', ''];
    for (const tool of tools) {
      toolLines.push(`**${tool.name}**: ${tool.description}`);
      toolLines.push(`  Parameters: ${tool.parameterDescription}`);
      if (tool.example) {
        toolLines.push(`  Example: ${tool.example}`);
      }
      toolLines.push('');
    }
    sections.push(toolLines.join('\n'));
  }

  // ── Persona (workspace context) — compressed, middle position ──
  // For tool-using specialists this is minimal (SOUL+IDENTITY only).
  // Placed after tools so it doesn't compete with task instructions.
  if (workspaceContext) {
    sections.push(workspaceContext);
  }

  // ── BOTTOM: Format rules + constraints (recency position) ──
  // These are the last thing the model reads before generating.
  if (tools.length > 0 && toolStyle === 'native') {
    sections.push(`## Tool Use Rules

1. Use the provided tools via tool calls — NEVER describe or write out a call as text.
2. Call ONE tool at a time, then wait for its result before deciding the next step.
3. NEVER claim you performed an action without actually calling the tool.
4. NEVER refuse to use tools — you have full access to every tool provided.
5. When you have everything you need, reply with your final answer as plain text (no tool call).`);
  } else if (tools.length > 0) {
    const exampleTool = tools[0];
    const exampleTool2 = tools.length > 1 ? tools[1] : exampleTool;

    sections.push(`## Response Format

You MUST respond using EXACTLY this format. Do NOT deviate.

### To use a tool:

Thought: I need to [reason about what to do]
Action: ${exampleTool.name}[{"param": "value"}]

### After receiving an Observation, to use another tool:

Thought: Based on the result, I should [next step]
Action: ${exampleTool2.name}[{"param": "value"}]

### When you have the final answer:

Thought: I now have enough information to answer.
Final Answer: [your complete response to the user]

### Worked example (REAL tool, real format — yours must look exactly like this):

Thought: I need to use ${exampleTool.name} to get this information.
Action: ${exampleTool.example ?? `${exampleTool.name}[{"input": "example value"}]`}
Observation: (the real result appears here — STOP after Action and wait for it; NEVER write the Observation yourself)
Thought: The result gives me what I need.
Final Answer: Here is what I found: …

## CRITICAL RULES — FOLLOW EXACTLY

1. ALWAYS start your response with "Thought:"
2. To call a tool, write "Action:" followed by tool_name[{JSON}] on the SAME line
3. The tool name must be one of: ${tools.map(t => t.name).join(', ')}
4. Parameters must be valid JSON inside square brackets [ ]
5. Use ONE tool per response — then STOP and wait for the Observation
6. When you are done, write "Final Answer:" followed by your response
7. NEVER write code blocks, markdown tool calls, or JSON outside of Action: lines
8. NEVER narrate what you would do — actually DO it with Action:
9. NEVER refuse to use tools — you have full access to all tools listed above`);
  }

  return sections.join('\n\n');
}

/**
 * Build the VOLATILE tail — per-turn content that must not live in the cached
 * system prompt: session state and retrieved memory. Injected as one user-role
 * message immediately before the user's actual message, so the long stable prefix
 * (system prompt + conversation history) stays KV-cached across turns while only
 * this small block re-prefills. Recency also favors it: this is the last thing the
 * model reads before the request.
 *
 * Returns null when there's nothing volatile — no empty message, no cache churn.
 */
export function buildVolatileContext(promptContext?: PromptContext): string | null {
  const parts: string[] = [];
  if (promptContext?.statePreamble) parts.push(promptContext.statePreamble);
  if (promptContext?.userPriming) parts.push(promptContext.userPriming);
  return parts.length ? parts.join('\n\n') : null;
}
