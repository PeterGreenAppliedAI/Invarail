/**
 * Live tool-loop check — runs runToolLoop against a REAL local model with the
 * real web_search tool (SearXNG). Validates native tool calling end-to-end,
 * scaffolding stripping, and guardrails. Runs the same task in 'native' and
 * 'text' toolStyle so prompt-size savings and behavior can be compared.
 *
 * Read-only: no config changes, no app boot, nothing persisted.
 * Usage: npx tsx scripts/tool-loop-live-check.ts [model]   (default qwen3.6:35b)
 */
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { runToolLoop } from '../src/tool-loop/engine.js';
import { createWebSearchTool } from '../src/tools/web-search.js';
import type { ToolExecutor, ToolContext } from '../src/tools/types.js';

const MODEL = process.argv[2] ?? 'qwen3.6:35b';
const TASK = 'What are the top 2 AI news stories today? Search the web, then answer in two short bullets.';

async function runOnce(style: 'native' | 'text'): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const webSearch = createWebSearchTool(config.tools?.web?.search);

  const executor: ToolExecutor = async (name, params, ctx) => {
    if (name !== 'web_search') return `Error: Tool "${name}" is not available.`;
    return webSearch.execute(params, ctx);
  };
  const toolContext: ToolContext = { agentId: 'livecheck', sessionKey: 'livecheck' };

  console.log(`\n========== toolStyle=${style} model=${MODEL} ==========`);
  const start = Date.now();
  const result = await runToolLoop({
    client,
    config: {
      model: MODEL,
      maxIterations: 5,
      temperature: 0.7,
      maxTokens: 1024,
      contextSize: 32768,
      systemPrompt: 'You are a helpful assistant. Use your tools to answer with current information.',
      toolStyle: style,
    },
    tools: [webSearch],
    executor,
    toolContext,
    userMessage: TASK,
  });

  const toolCalls = result.steps.filter(s => s.action).map(s => s.action!.tool);
  const scaffoldingLeak = /Thought:|Final Answer:|Action:/.test(result.answer);
  const thinkLeak = /<think>|<\|channel>/.test(result.answer);

  console.log(`duration:        ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`iterations:      ${result.iterations} (hitMax=${result.hitMaxIterations})`);
  console.log(`tool calls:      [${toolCalls.join(', ') || 'NONE'}]`);
  console.log(`prompt tokens:   ${result.promptTokens ?? 'n/a'} | completion: ${result.completionTokens ?? 'n/a'}`);
  console.log(`scaffolding leak: ${scaffoldingLeak ? 'YES — BUG' : 'no'}`);
  console.log(`think-tag leak (pre-strip is OK at this layer): ${thinkLeak ? 'yes (dispatch strips)' : 'no'}`);
  console.log(`answer (first 400 chars):\n${result.answer.slice(0, 400)}`);

  const verdictBits = [
    toolCalls.includes('web_search') ? 'used web_search' : 'NEVER SEARCHED — check tool wiring',
    scaffoldingLeak ? 'SCAFFOLDING LEAKED' : 'answer clean',
    result.answer.trim().length > 0 ? 'non-empty' : 'EMPTY ANSWER',
  ];
  console.log(`verdict:         ${verdictBits.join(' | ')}`);
}

async function main(): Promise<void> {
  await runOnce('native');
  await runOnce('text');
}

main().catch(err => {
  console.error('Live check failed to run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
