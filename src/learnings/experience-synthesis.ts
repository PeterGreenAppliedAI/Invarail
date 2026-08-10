import { chatMaybeStructured } from '../pipeline/extractor.js';
import { logAutonomousAction } from '../metrics.js';
import { harvestExperienceCandidates, advanceMarker, type ExperienceCandidate, type TurnLike } from './experience-harvester.js';
import type { ExperienceStore } from '../memory/experience-store.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Heartbeat step: turn code-harvested satisfaction candidates into
 * :Experience nodes. Guards cloned from lesson-synthesis verbatim:
 * max 3 new per cycle, batch-distrust when the model stops discriminating.
 *
 * AUTHORITY BOUNDARY: output is graph nodes consumed as advisory prompt text
 * only — never permissions, routing, confirmation, or tool exposure.
 */

const EXPERIENCE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    taskShape: { type: 'string' },
    approach: { type: 'string' },
    outcome: { type: 'string', enum: ['worked', 'failed'] },
    worth_keeping: { type: 'boolean' },
  },
  required: ['taskShape', 'approach', 'outcome', 'worth_keeping'],
} as const;

const MAX_NEW_PER_CYCLE = 3;

function describe(c: ExperienceCandidate): string {
  const parts = [
    `Task: ${c.taskPreview || '(unknown)'}`,
    c.calls.length ? `Tools used, in order: ${c.calls.join(' → ')}` : 'No tool trace paired.',
    `Signal: ${c.signalKind} (valence ${c.valence > 0 ? 'positive' : c.valence < 0 ? 'negative' : 'neutral'})`,
  ];
  return parts.join('\n');
}

export async function synthesizeExperiences(opts: {
  client: OllamaClient;
  model: string;
  store: ExperienceStore;
  recentTurns?: TurnLike[];
  metricsPath?: string;
  executionsPath?: string;
  markerPath?: string;
}): Promise<{ created: string[]; reinforced: number; superseded: number; skipped: number }> {
  const result = { created: [] as string[], reinforced: 0, superseded: 0, skipped: 0 };
  const { candidates, latestTs } = harvestExperienceCandidates({
    metricsPath: opts.metricsPath,
    executionsPath: opts.executionsPath,
    recentTurns: opts.recentTurns,
    markerPath: opts.markerPath,
  });
  console.log(`[Experience] Harvested ${candidates.length} candidate(s)`);
  if (candidates.length === 0) return result;

  // NEWEST first: under the per-cycle cap, recent signals must never lose to
  // historic backlog (a fresh 👎 fell off the end of an oldest-first slice)
  const ordered = [...candidates].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const synthesized: Array<{ candidate: ExperienceCandidate; parsed: { taskShape?: string; approach?: string; outcome?: string; worth_keeping?: boolean } }> = [];
  for (const candidate of ordered.slice(0, 12)) {
    try {
      const raw = await chatMaybeStructured(opts.client, opts.model, [
        {
          role: 'system',
          content: [
            'You summarize an agent\'s work experiences — what approach was used for what task shape, and whether it worked, judged by REAL user signals (reactions, corrections, denials).',
            'Generalize the task to its SHAPE ("weekly news digest request", "image generation ask") — surface details like topic vary, the shape recurs.',
            'The approach is WHAT WAS DONE (tools/sequence/style), not a judgment.',
            'worth_keeping=false ONLY for: one-off infrastructure failures or signals with no reusable pattern. An explicit user reaction (thumbs up/down) or denial is NEVER ambiguous — it is the user\'s direct judgment.',
            'Return ONLY JSON: {"taskShape": "...", "approach": "...", "outcome": "worked"|"failed", "worth_keeping": true|false}',
          ].join('\n'),
        },
        { role: 'user', content: describe(candidate) },
      ], EXPERIENCE_JSON_SCHEMA as never, 512);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      synthesized.push({ candidate, parsed });
    } catch (err) {
      console.warn('[Experience] Synthesis failed for a candidate:', err instanceof Error ? err.message : err);
    }
  }

  // Explicit signals (reaction/deny, strength 2) BYPASS the model's veto —
  // the user's direct judgment IS the keep-decision; the model only fills in
  // shape/approach. worth_keeping filters inferred noise only.
  const keepers = synthesized.filter(s =>
    s.parsed.taskShape && s.parsed.approach
    && (s.candidate.evidenceStrength === 2 || s.parsed.worth_keeping === true));
  if (synthesized.length >= 5 && keepers.length === synthesized.length) {
    console.warn(`[Experience] Batch distrusted — model kept all ${synthesized.length}`);
    logAutonomousAction({ action: 'experience_batch_distrusted', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'failure', detail: `${synthesized.length} candidates` });
    if (latestTs) advanceMarker(latestTs, opts.markerPath);
    return result;
  }
  result.skipped = synthesized.length - keepers.length;

  for (const { candidate, parsed } of keepers) {
    if (result.created.length >= MAX_NEW_PER_CYCLE) break;
    const valenceText = candidate.valence > 0 ? 'user approved' : candidate.valence < 0 ? `user rejected (${candidate.signalKind})` : 'tool failure';
    const text = `For ${parsed.taskShape}: ${parsed.approach} — ${parsed.outcome}; ${valenceText}.`;
    const saved = await opts.store.save({
      text,
      taskShape: parsed.taskShape!,
      approach: parsed.approach!,
      outcome: (parsed.outcome === 'worked' ? 'worked' : 'failed'),
      satisfaction: candidate.valence,
      model: opts.model,
      evidenceCount: candidate.evidenceStrength,
    }, candidate.sessionKey);
    if (!saved) continue;
    if (saved.action === 'created') {
      result.created.push(text.slice(0, 80));
      logAutonomousAction({ action: 'experience_recorded', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: text.slice(0, 120) });
    } else if (saved.action === 'reinforced') {
      result.reinforced++;
    } else {
      result.superseded++;
      result.created.push(text.slice(0, 80));
    }
  }

  // Total synthesis failure (every call errored) = infrastructure problem —
  // do NOT consume the evidence; re-harvest next cycle
  if (synthesized.length === 0 && candidates.length > 0) {
    console.warn('[Experience] All synthesis calls failed — marker NOT advanced, evidence preserved');
    return result;
  }
  if (latestTs) advanceMarker(latestTs, opts.markerPath);
  // Silence is a bug: always report the disposition, even when nothing kept
  console.log(`[Experience] Disposition: ${result.created.length} created, ${result.reinforced} reinforced, ${result.superseded} superseded, ${result.skipped} skipped of ${synthesized.length} synthesized`);
  return result;
}
