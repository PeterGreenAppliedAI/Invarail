/**
 * Build duel — two foreground candidates each generate the SAME single-file
 * web app from the same spec; outputs land blind (site-A/site-B, mapping
 * sealed) for a three-layer judgment: deterministic Playwright battery,
 * screenshot side-by-side, blind code read.
 *
 * Usage: npx tsx scripts/build-duel.ts          (generation — lab tmux, LAN)
 *        npx tsx scripts/build-duel.ts --check  (Playwright battery + shots, local)
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/loader.js';
import { createInferenceClient } from '../src/ollama/multi-backend.js';
import { stripThinkingTags } from '../src/utils/text.js';

const CONTESTANTS = [
  { name: 'deepseek-v4-flash', think: undefined as boolean | undefined, label: 'deepseek-v4-flash (default thinking)' },
  { name: 'qwen3.8:27b', think: true as boolean | undefined, label: 'qwen3.8:27b@think=on' },
];

const SPEC = `Build a complete, self-contained expense tracker as a SINGLE index.html file (inline CSS and JavaScript, NO external resources, NO CDNs, NO frameworks — vanilla JS only).

Features (all required):
1. Add an expense via a form: date (date input), category (select with at least: Food, Travel, Office, Utilities, Other), amount (number), note (text, optional). Adding appends it to a visible list/table.
2. Delete any expense via a button on its row.
3. Edit any expense via a button on its row (inline or via the form — your choice).
4. A running TOTAL of all currently visible expenses, updating live, displayed in an element with id="total".
5. Per-category breakdown: total per category, visible and live-updating, inside an element with id="breakdown".
6. Filters: a category filter (select, id="filter-category") and a month filter (month input or select, id="filter-month"). Filtering updates the list, the total, and the breakdown to reflect only visible expenses. An "All" state clears each filter.
7. Persistence: expenses survive a page reload via localStorage.
8. CSV export: a button (id="export-csv") that downloads the currently visible expenses as a CSV file.
9. A spending-by-category bar chart drawn on a <canvas id="chart"> (draw it yourself with the canvas API), live-updating with the filters.

Contract details (the app is machine-tested — follow these exactly):
- The add form: inputs with ids "in-date", "in-category", "in-amount", "in-note", and a submit button id="add-btn".
- Each expense row is an element with class "expense-row"; its delete button has class "delete-btn"; its edit button has class "edit-btn".
- The total element (id="total") text must contain the numeric total formatted to 2 decimals.
- Amounts are dollars; treat inputs as decimal numbers.

Quality bar: clean layout, readable typography, sensible spacing, empty-state handling, and no console errors. Reply with ONLY the complete HTML file in a single fenced code block.`;

const RUN_DIR = join('data', 'model-eval', 'build-duel-2026-08-15');

function extractHtml(reply: string): string {
  const fences = [...reply.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  return fences.length ? fences.reduce((a, b) => (b.length > a.length ? b : a)) : reply;
}

async function generate(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  const config = loadConfig('invarail.config.json5');
  const client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
  const shuffled = [...CONTESTANTS].sort((a, b) =>
    createHash('sha256').update(a.name + RUN_DIR).digest('hex')
      .localeCompare(createHash('sha256').update(b.name + RUN_DIR).digest('hex')));
  const onlyArg = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];
  const mapping: Record<string, string> = {};
  for (let i = 0; i < shuffled.length; i++) {
    const c = shuffled[i];
    const letter = ['A', 'B'][i];
    mapping[letter] = c.label;
    if (onlyArg && letter !== onlyArg) continue;
    console.log(`Generating site ${letter}...`);
    const start = Date.now();
    const params: Parameters<typeof client.chat>[0] = {
      model: c.name,
      messages: [
        { role: 'system', content: 'You are a senior front-end engineer. Deliver production-quality, working code exactly to spec.' },
        { role: 'user', content: SPEC },
      ],
      options: { temperature: 0.2, num_predict: 16384, num_ctx: 24576 },
    };
    if (c.think !== undefined) (params as Record<string, unknown>).think = c.think;
    try {
      const res = await client.chat(params);
      const html = extractHtml(stripThinkingTags(res.message?.content ?? '').trim());
      const tokens = (res as unknown as { eval_count?: number }).eval_count ?? 0;
      mkdirSync(join(RUN_DIR, `site-${letter}`), { recursive: true });
      writeFileSync(join(RUN_DIR, `site-${letter}`, 'index.html'), html);
      console.log(`  site ${letter}: ${html.length} chars, ${tokens} ctok, ${((Date.now() - start) / 1000).toFixed(0)}s`);
    } catch (err) {
      console.error(`  site ${letter} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  writeFileSync(join(RUN_DIR, 'MAPPING.json'), JSON.stringify(mapping, null, 2));
  console.log('BUILD DUEL GENERATION COMPLETE (mapping sealed)');
}

// ---------------------------------------------------------------- check mode

interface Check { name: string; pass: boolean; detail?: string }

async function checkSite(letter: string): Promise<Check[]> {
  const { chromium } = await import('playwright-core');
  const checks: Check[] = [];
  const consoleErrors: string[] = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  // Apps may guard destructive actions behind confirm() — accept, don't dismiss,
  // or the delete check punishes good UX (found on the first run).
  page.on('dialog', d => { void d.accept(); });
  const url = `file://${process.cwd()}/${RUN_DIR}/site-${letter}/index.html`;
  const add = async (date: string, cat: string, amt: string, note: string): Promise<void> => {
    await page.fill('#in-date', date);
    await page.selectOption('#in-category', cat).catch(async () => { await page.fill('#in-category', cat); });
    await page.fill('#in-amount', amt);
    await page.fill('#in-note', note);
    await page.click('#add-btn');
  };
  const c = (name: string, pass: boolean, detail?: string): void => { checks.push({ name, pass, detail }); };
  try {
    await page.goto(url);
    c('page loads', true);
    await add('2026-08-01', 'Food', '25.50', 'lunch');
    await add('2026-08-02', 'Travel', '100.00', 'train');
    await add('2026-07-15', 'Food', '10.00', 'coffee');
    await page.waitForTimeout(300);
    c('rows appear after add', await page.locator('.expense-row').count() === 3, `rows=${await page.locator('.expense-row').count()}`);
    const total = (await page.locator('#total').textContent()) ?? '';
    c('total = 135.50', /135\.50/.test(total), total.trim().slice(0, 40));
    const breakdown = (await page.locator('#breakdown').textContent()) ?? '';
    c('breakdown has Food 35.50', /35\.50/.test(breakdown), breakdown.trim().slice(0, 80));
    c('breakdown has Travel 100', /100(\.00)?/.test(breakdown));
    // category filter
    await page.selectOption('#filter-category', { label: 'Food' }).catch(async () => { await page.selectOption('#filter-category', 'Food'); });
    await page.waitForTimeout(300);
    c('category filter narrows rows', await page.locator('.expense-row').count() === 2);
    c('filtered total = 35.50', /35\.50/.test((await page.locator('#total').textContent()) ?? ''));
    // reset category filter to All
    const catOptions = await page.locator('#filter-category option').allTextContents();
    const allOpt = catOptions.find(o => /all/i.test(o)) ?? catOptions[0];
    await page.selectOption('#filter-category', { label: allOpt }).catch(() => {});
    await page.waitForTimeout(200);
    // month filter
    const mf = page.locator('#filter-month');
    const tag = await mf.evaluate(el => (el as HTMLElement).tagName).catch(() => 'NONE');
    if (tag === 'SELECT') { await page.selectOption('#filter-month', { index: 1 }).catch(() => {}); }
    else if (tag === 'INPUT') { await mf.fill('2026-08').catch(() => {}); }
    await page.waitForTimeout(300);
    const monthRows = await page.locator('.expense-row').count();
    c('month filter narrows rows', tag !== 'NONE' && monthRows > 0 && monthRows < 3, `tag=${tag} rows=${monthRows}`);
    if (tag === 'INPUT') await mf.fill('').catch(() => {});
    if (tag === 'SELECT') await page.selectOption('#filter-month', { index: 0 }).catch(() => {});
    await page.waitForTimeout(200);
    // persistence
    await page.reload();
    await page.waitForTimeout(400);
    c('persists across reload', await page.locator('.expense-row').count() === 3, `rows=${await page.locator('.expense-row').count()}`);
    // delete
    await page.locator('.delete-btn').first().click();
    await page.waitForTimeout(300);
    c('delete removes a row', await page.locator('.expense-row').count() === 2);
    // edit button exists and is wired
    c('edit buttons present', await page.locator('.edit-btn').count() >= 2);
    // export
    const dl = page.waitForEvent('download', { timeout: 4000 }).then(() => true).catch(() => false);
    await page.click('#export-csv');
    c('CSV export triggers download', await dl);
    // chart canvas painted
    const painted = await page.evaluate(() => {
      const cv = document.getElementById('chart') as HTMLCanvasElement | null;
      if (!cv) return false;
      const ctx = cv.getContext('2d');
      if (!ctx) return false;
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
      return false;
    }).catch(() => false);
    c('chart canvas is painted', painted);
    c('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 120));
    // screenshots: populated state
    await page.screenshot({ path: join(RUN_DIR, `site-${letter}-populated.png`), fullPage: true });
  } catch (err) {
    c('battery aborted', false, err instanceof Error ? err.message.slice(0, 150) : String(err));
  }
  await browser.close();
  return checks;
}

async function check(): Promise<void> {
  const letters = readdirSync(RUN_DIR).filter(f => f.startsWith('site-') && !f.endsWith('.png')).map(f => f.replace('site-', ''));
  const results: Record<string, Check[]> = {};
  for (const letter of letters.sort()) {
    console.log(`\n=== site ${letter} ===`);
    const checks = await checkSite(letter);
    results[letter] = checks;
    for (const ch of checks) console.log(`  ${ch.pass ? 'PASS' : 'FAIL'} ${ch.name}${ch.detail ? ` (${ch.detail})` : ''}`);
    console.log(`  score: ${checks.filter(ch => ch.pass).length}/${checks.length}`);
  }
  writeFileSync(join(RUN_DIR, 'checks.json'), JSON.stringify(results, null, 2));
}

if (process.argv.includes('--check')) { check().catch(e => { console.error(e); process.exit(1); }); }
else { generate().catch(e => { console.error(e); process.exit(1); }); }
