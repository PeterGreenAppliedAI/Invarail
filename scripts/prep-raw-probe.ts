import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerAllTools } from '../src/tools/register-all.js';
import { enrichCalendarOutput } from '../src/temporal/urgency.js';
import { parseCalendarEvents, buildPrepPrompt, parsePrepAssessments, PREP_ASSESSMENT_SCHEMA } from '../src/services/prep-proposals.js';
import { resolveWorkspacePath } from '../src/agents/scope.js';

const config = loadConfig('invarail.config.json5');
const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
const registry = new ToolRegistry();
await registerAllTools(registry, config, { ollamaClient: client });
const executor = registry.createExecutor();
const now = new Date();
const raw = await executor('calendar_list', { days: 2 }, { agentId: 'main', sessionKey: 'probe', workspacePath: resolveWorkspacePath(config.agents.default, config) });
const enriched = enrichCalendarOutput(raw, now);
const events = parseCalendarEvents(enriched, now, config.timezone)
  .filter(e => e.start.getTime() > now.getTime() && e.start.getTime() < now.getTime() + 48*60*60*1000);
events.forEach((e, i) => { e.index = i + 1; });
console.log(`events after 48h filter: ${events.length}`);
const { system, user } = buildPrepPrompt(events, 'Solo founder; under-prepares for budget meetings.');
const params = { model: config.briefing.model, messages: [{role:'system' as const,content:system},{role:'user' as const,content:user}], options: { temperature: 0.2, num_predict: 2048 } };
let out = '';
try {
  const r = await client.chat({ ...params, format: PREP_ASSESSMENT_SCHEMA });
  out = r.message?.content ?? '';
  console.log('(format call succeeded)');
} catch (e) {
  console.log('format call FAILED:', e instanceof Error ? e.message : e);
  const r = await client.chat(params);
  out = r.message?.content ?? '';
}
console.log('RAW >>>'); console.log(out.slice(0, 1500)); console.log('<<<');
console.log('parsed:', JSON.stringify(parsePrepAssessments(out, events.length)));
process.exit(0);
