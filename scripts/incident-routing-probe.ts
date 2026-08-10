import { loadConfig } from '../src/config/loader.js';
import { OllamaClient } from '../src/ollama/client.js';
import { classifyMessage } from '../src/router/classifier.js';

const config = loadConfig('invarail.config.json5');
const client = new OllamaClient(config.ollama.url);

const CASES: Array<{ msg: string; prev?: string; want: string; label: string }> = [
  { msg: "I dont need to prepare anything for that specifically. David is intended on being on the podcast. So I just need to get him a Riverside link and then record", prev: 'briefing', want: 'chat', label: '4:05 incident reply (after briefing)' },
  { msg: 'did you actually send a message?', want: 'chat', label: '4:14 meta-question' },
  { msg: 'send a message to the family channel that dinner is at 7', prev: 'briefing', want: 'message', label: 'imperative still breaks through' },
  { msg: 'have you finished the research report', want: 'chat', label: 'perfective meta-question' },
];

for (const c of CASES) {
  const r = await classifyMessage(client, config.router, c.msg, c.prev);
  const ok = r.category === c.want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.category.padEnd(9)} (${r.confidence.padEnd(8)}) — ${c.label}`);
}
process.exit(0);
