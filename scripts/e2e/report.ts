/**
 * The published report: a model table with the mean check score and the full-pass rate with
 * a 95% Wilson interval, per-category means, and per-model detail with rep 1's answers.
 */
import type { CheckResult, E2ETask } from './tasks.js';
import { pct, passRate } from './stats.js';

export interface TaskRecord {
  id: string; expected: string[]; routed?: string; routedBy?: string;
  /** Set when the specialist reroute re-dispatched the task: the category that gave up. */
  reroutedFrom?: string;
  /** A provider outage that survived one retry: excluded from means, reported separately. */
  unscored?: boolean;
  checks: CheckResult[]; score: number; durationMs: number;
  promptTokens: number; completionTokens: number; modelCalls: number;
  iterations?: number; hitMaxIterations?: boolean; error?: string; bucket?: string;
  answer: string; webCalls: string[];
}
export interface ModelRecord {
  model: string; profile: string; think?: boolean;
  reps: TaskRecord[][];
  taskScores: Record<string, number>; categoryScores: Record<string, number>; overall: number; totalMs: number;
}

export interface ReportMeta { date: string; profile: string; workspace: string; reps: number; tasks: E2ETask[] }

/** A task-rep passes when every check passed. Unscored reps (provider outages) are left out. */
function passes(recs: TaskRecord[]): { k: number; n: number } {
  const scored = recs.filter(r => !r.unscored);
  return { k: scored.filter(r => r.score === 1).length, n: scored.length };
}

export function report(results: ModelRecord[], prov: Record<string, unknown>, meta: ReportMeta): string {
  const { date: DATE, profile: PROFILE, workspace: WORKSPACE, reps: REPS, tasks: TASKS } = meta;
  let md = `# End-to-end eval — ${DATE} · profile=${PROFILE} · workspace=${WORKSPACE}\n\nEvery task through \`dispatchMessage\` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **${PROFILE}** (\`wizard\` = what the wizard writes for the model's tier). Workspace: **${WORKSPACE}**. Reps: ${REPS}.\n\n`;
  md += `Overall is the mean fraction of checks passed. Task-reps passed counts reps where every check passed, with a 95% Wilson interval.\n\n`;
  md += `| # | Model | Overall | Task-reps passed | ${TASKS.map(t => t.id).join(' | ')} | prompt tok/battery | wall |\n|---|---|---|---|${TASKS.map(() => '---').join('|')}|---|---|\n`;
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  for (const [i, r] of sorted.entries()) {
    const ptok = r.reps.flat().reduce((s, t) => s + t.promptTokens, 0) / Math.max(1, r.reps.length);
    const all = passes(r.reps.flat());
    md += `| ${i + 1} | ${r.model} | **${pct(r.overall)}** | ${passRate(all.k, all.n)} | ${TASKS.map(t => r.taskScores[t.id] === undefined ? '—' : pct(r.taskScores[t.id])).join(' | ')} | ${Math.round(ptok).toLocaleString()} | ${(r.totalMs / 60000).toFixed(1)}m |\n`;
  }
  md += `\n## By category\n\n| Model | ${Object.keys(sorted[0]?.categoryScores ?? {}).join(' | ')} |\n|---|${Object.keys(sorted[0]?.categoryScores ?? {}).map(() => '---').join('|')}|\n`;
  for (const r of sorted) md += `| ${r.model} | ${Object.values(r.categoryScores).map(pct).join(' | ')} |\n`;
  for (const r of sorted) {
    md += `\n## ${r.model}\n\n| Task | Passed | Rep 1 score | Rep 1 routed | Rep 1 failed checks | Calls | Prompt tok | Wall |\n|---|---|---|---|---|---|---|---|\n`;
    for (const t of r.reps[0] ?? []) {
      const tp = passes(r.reps.map(rep => rep.find(x => x.id === t.id)).filter((x): x is TaskRecord => !!x));
      const failed = t.checks.filter(c => !c.pass).map(c => `✗ ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ');
      const routed = `${t.routed ?? '—'}${t.reroutedFrom ? ` (rerouted from ${t.reroutedFrom})` : ''}${t.expected.includes(t.routed ?? '') ? '' : ' ⚠'}`;
      md += `| ${t.id} | ${passRate(tp.k, tp.n)} | ${t.unscored ? 'unscored' : pct(t.score)} | ${routed} | ${failed || 'all pass'} | ${t.modelCalls} | ${t.promptTokens.toLocaleString()} | ${(t.durationMs / 1000).toFixed(0)}s |\n`;
    }
    md += `\n<details><summary>Answers (rep 1)</summary>\n\n`;
    for (const t of r.reps[0] ?? []) md += `**${t.id}** — web: ${t.webCalls.join(', ') || 'none'}\n\n\`\`\`\n${t.answer.slice(0, 800)}\n\`\`\`\n\n`;
    md += `</details>\n`;
  }
  md += `\n---\nProvenance: ${JSON.stringify(prov)}\n`;
  return md;
}
