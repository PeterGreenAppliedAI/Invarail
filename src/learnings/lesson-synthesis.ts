import type { OllamaClient } from '../ollama/client.js';
import { chatMaybeStructured } from '../pipeline/extractor.js';
import { logAutonomousAction } from '../metrics.js';
import { LessonStore } from './lesson-store.js';
import { upsertLessonEmbedding, findLessonBySimilarity } from './lesson-semantic.js';
import {
  harvestLessonCandidates,
  loadHarvestMarker,
  saveHarvestMarker,
  defaultMarkerPath,
  type LessonCandidate,
} from './lesson-harvester.js';

/**
 * The "model explains" half: turn code-detected failure candidates into
 * boundary lessons, off the hot path (heartbeat only).
 *
 * Guards (stale-facts doctrine): max 3 NEW lessons per cycle; if the model
 * marks everything worth keeping across a large batch, distrust the whole
 * batch — an indiscriminate yes is a signal about the model, not the data.
 */

const MAX_NEW_LESSONS_PER_CYCLE = 3;

const LESSON_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    situation: { type: 'string' },
    approach: { type: 'string' },
    outcome: { type: 'string' },
    boundary: { type: 'string' },
    worth_keeping: { type: 'boolean' },
  },
  required: ['name', 'situation', 'boundary', 'worth_keeping'],
};

interface SynthesizedLesson {
  name?: string;
  situation?: string;
  approach?: string;
  outcome?: string;
  boundary?: string;
  worth_keeping?: boolean;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'unnamed-lesson';
}

function describeCandidate(c: LessonCandidate): string {
  const parts = [
    `Failure kind: ${c.kind}${c.tool ? ` (tool: ${c.tool})` : ''}${c.routeCategory ? ` (category: ${c.routeCategory})` : ''}, observed ${c.count}x.`,
    c.examples.length ? `Errors/outcomes: ${c.examples.join(' | ')}` : '',
    c.contexts.length ? `Requests that triggered it: ${c.contexts.map(x => `"${x}"`).join(' | ')}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

export interface LessonSynthesisResult {
  newLessons: string[];
  reinforced: string[];
  skipped: number;
}

export async function synthesizeLessons(opts: {
  client: OllamaClient;
  model: string;
  workspacePath: string;
  metricsPath?: string;
  deadLetterPath?: string;
}): Promise<LessonSynthesisResult> {
  const store = new LessonStore(opts.workspacePath);
  const markerPath = defaultMarkerPath(opts.workspacePath);
  const since = loadHarvestMarker(markerPath);
  const { candidates, newestTimestamp } = harvestLessonCandidates({
    metricsPath: opts.metricsPath,
    deadLetterPath: opts.deadLetterPath,
    sinceTimestamp: since,
  });

  const result: LessonSynthesisResult = { newLessons: [], reinforced: [], skipped: 0 };
  if (candidates.length === 0) {
    if (newestTimestamp !== since) saveHarvestMarker(markerPath, newestTimestamp);
    return result;
  }

  const synthesized: Array<{ candidate: LessonCandidate; lesson: SynthesizedLesson }> = [];
  for (const candidate of candidates) {
    try {
      const raw = await chatMaybeStructured(opts.client, opts.model, [
        {
          role: 'system',
          content: [
            'You maintain an agent\'s lesson log — boundaries learned from observed failures.',
            'Given evidence of a failure pattern, decide if it teaches a REUSABLE boundary ("approach X fails for task-shape Y") and express it.',
            'worth_keeping=false for: one-off infrastructure blips (network down, service restarting), user typos, anything with no reusable boundary.',
            'The "boundary" field is ONE sentence, concrete and actionable — it will be injected verbatim into future prompts to steer behavior.',
            'Return ONLY JSON: {"name": "short-kebab-slug", "situation": "task-shape this applies to", "approach": "what was tried", "outcome": "what happened", "boundary": "the one-sentence steering rule", "worth_keeping": true|false}',
          ].join('\n'),
        },
        { role: 'user', content: describeCandidate(candidate) },
      ], LESSON_JSON_SCHEMA, 512);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as SynthesizedLesson;
      synthesized.push({ candidate, lesson: parsed });
    } catch (err) {
      console.warn('[Lessons] Synthesis failed for a candidate:', err instanceof Error ? err.message : err);
    }
  }

  // Batch distrust: a large batch where EVERYTHING is worth keeping means the
  // model isn't discriminating — keep nothing, keep the marker so the same
  // evidence isn't re-litigated forever
  const keepers = synthesized.filter(s => s.lesson.worth_keeping === true && s.lesson.boundary);
  if (synthesized.length >= 5 && keepers.length === synthesized.length) {
    console.warn(`[Lessons] Batch distrusted — model marked all ${synthesized.length} candidates worth keeping`);
    logAutonomousAction({ action: 'lesson_batch_distrusted', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'failure', detail: `${synthesized.length} candidates` });
    saveHarvestMarker(markerPath, newestTimestamp);
    return result;
  }
  result.skipped = synthesized.length - keepers.length;

  for (const { candidate, lesson } of keepers) {
    if (result.newLessons.length >= MAX_NEW_LESSONS_PER_CYCLE) break;
    const slug = slugify(lesson.name ?? lesson.situation ?? 'lesson');
    const trigger = candidate.contexts[0];

    // Dedup ladder: exact slug → semantic → new
    if (store.get(slug)) {
      store.recordEvidence(slug, trigger);
      const refreshed = store.get(slug);
      if (refreshed) await upsertLessonEmbedding(opts.client, refreshed);
      result.reinforced.push(slug);
      logAutonomousAction({ action: 'lesson_evidence', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: slug });
      continue;
    }
    const similar = await findLessonBySimilarity(opts.client, store, `${lesson.situation}. ${lesson.boundary}`);
    if (similar) {
      store.recordEvidence(similar.slug, trigger);
      const refreshed = store.get(similar.slug);
      if (refreshed) await upsertLessonEmbedding(opts.client, refreshed);
      result.reinforced.push(similar.slug);
      logAutonomousAction({ action: 'lesson_evidence', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: similar.slug });
      continue;
    }

    const today = new Date().toISOString().split('T')[0];
    const newLesson = {
      name: lesson.name ?? slug,
      slug,
      description: lesson.boundary!.slice(0, 300),
      situation: (lesson.situation ?? '').slice(0, 200),
      tool: candidate.tool,
      model: candidate.model ?? opts.model,
      evidenceCount: 1,
      created: today,
      lastConfirmed: today,
      triggers: candidate.contexts.slice(0, 2),
      tried: lesson.approach ?? '',
      happened: `${lesson.outcome ?? ''} (${candidate.kind}, ${candidate.count}x)`,
      boundary: lesson.boundary!,
    };
    store.save(newLesson);
    await upsertLessonEmbedding(opts.client, newLesson);
    result.newLessons.push(slug);
    logAutonomousAction({ action: 'lesson_recorded', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: `${slug} (${candidate.kind})` });
  }

  saveHarvestMarker(markerPath, newestTimestamp);
  return result;
}
