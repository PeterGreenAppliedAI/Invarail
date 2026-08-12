/**
 * Pre-flight test for the think-A/B eval run. Verifies through the REAL gateway:
 *  1. think:true → separated `thinking` field comes back, content stays clean
 *  2. think:false → no thinking, terse content
 *  3. non-thinking model rejects `think` (the probe mechanism)
 *  4. token meter counts eval_count across calls
 * Read-only. Run inside `lab` tmux. Usage: npx tsx scripts/think-probe-test.ts
 */
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';

const THINKER = 'qwen3.6:27b';
const NON_THINKER = 'devstral:24b';
const PROMPT = 'Summarize in exactly 3 bullet points, nothing before or after: The council voted 6-3 to approve the riverfront plan with 400 housing units, a park, and $12M in flood work. Construction starts spring 2027 pending review.';

async function main(): Promise<void> {
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);

  let meteredTokens = 0;

  const call = async (model: string, think: boolean | undefined): Promise<void> => {
    const label = `${model} think=${think === undefined ? 'unset' : think}`;
    try {
      const res = await client.chat({
        model,
        messages: [{ role: 'user', content: PROMPT }],
        options: { temperature: 0.3, num_predict: 1024 },
        ...(think === undefined ? {} : { think }),
      } as Parameters<typeof client.chat>[0]);
      const r = res as unknown as { message?: { content?: string; thinking?: string }; eval_count?: number };
      meteredTokens += r.eval_count ?? 0;
      const content = r.message?.content ?? '';
      const thinking = r.message?.thinking ?? '';
      const leak = /thinking process|let me|deconstruct|analyze the request/i.test(content.slice(0, 200));
      console.log(`\n=== ${label} ===`);
      console.log(`thinking field: ${thinking ? `${thinking.length} chars — SEPARATED` : 'absent'}`);
      console.log(`content (first 220): ${JSON.stringify(content.slice(0, 220))}`);
      console.log(`content leak heuristic: ${leak ? 'SUSPECT LEAK' : 'clean'}`);
      console.log(`eval_count: ${r.eval_count ?? 'n/a'}`);
    } catch (err) {
      console.log(`\n=== ${label} ===\nREJECTED: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  };

  await call(THINKER, undefined);   // default behavior (what all prior runs measured)
  await call(THINKER, true);        // expect separated thinking field
  await call(THINKER, false);       // expect no thinking, terse content
  await call(NON_THINKER, true);    // expect REJECTED — this is the probe mechanism
  await call(NON_THINKER, undefined); // control: works normally

  console.log(`\nTOKEN METER TOTAL (eval_count sum): ${meteredTokens} — ${meteredTokens > 0 ? 'METERING OK' : 'METERING BROKEN'}`);
}

main().catch(err => { console.error('Probe test failed:', err instanceof Error ? err.message : err); process.exit(1); });
