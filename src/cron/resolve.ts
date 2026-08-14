import type { CronJob } from './types.js';

/** Resolve a job by exact id or case-insensitive name substring. Users (and
 *  extraction models) say names; ids are plumbing. Ambiguity and misses return
 *  an actionable error listing what exists instead of a bare "not found". */
export function resolveCronJob(jobs: CronJob[], query: string): { job: CronJob } | { error: string } {
  const byId = jobs.find(j => j.id === query);
  if (byId) return { job: byId };
  const q = query.toLowerCase();
  const byName = jobs.filter(j => j.name.toLowerCase().includes(q));
  if (byName.length === 1) return { job: byName[0] };
  if (byName.length === 0) {
    return { error: `No job matches "${query}". Current jobs:\n${jobs.map(j => `- ${j.name} (${j.id})`).join('\n') || '(none)'}` };
  }
  return { error: `"${query}" matches ${byName.length} jobs — be more specific:\n${byName.map(j => `- ${j.name} (${j.id})`).join('\n')}` };
}
