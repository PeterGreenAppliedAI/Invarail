import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lesson store — NEGATIVE procedural memory: "approach X failed for
 * task-shape Y; the boundary is Z." The counterpart of the skill store
 * (what worked); same markdown-file shape, same curation machinery.
 *
 * Lessons are point-in-time observations: `model` records which model
 * produced the failure — a phi4-era lesson may be false under DeepSeek,
 * so staleness proposals fire when the model changes.
 */
export interface Lesson {
  name: string;
  slug: string;
  /** The boundary one-liner — this is the ONLY text injected at dispatch */
  description: string;
  /** Task-shape this applies to (for the synthesis model + humans) */
  situation: string;
  /** Optional tool tag — tool-scoped lessons also surface via findHints */
  tool?: string;
  /** Model that produced the observed failure */
  model: string;
  /** Times this failure shape has been observed — injection requires ≥2
   *  (recurrence is the code gate; a one-off is noise until it repeats) */
  evidenceCount: number;
  created: string;
  lastConfirmed: string;
  /** Concrete request phrasings that hit this boundary (max 5) */
  triggers: string[];
  /** Body sections: what was tried / what happened / boundary */
  tried: string;
  happened: string;
  boundary: string;
}

const MAX_TRIGGERS = 5;

/** Injection threshold — a lesson steers dispatches only once its failure
 *  shape has recurred. Code gate, never model judgment. */
export const LESSON_EVIDENCE_FLOOR = 2;

function parseSection(content: string, heading: string): string {
  const m = content.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n*$)`));
  return m?.[1].trim() ?? '';
}

function parseLesson(content: string, slug: string): Lesson | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) fm[key.trim()] = rest.join(':').trim();
  }

  let triggers: string[] = [];
  if (fm.triggers) {
    try {
      const parsed = JSON.parse(fm.triggers);
      if (Array.isArray(parsed)) triggers = parsed.map(String);
    } catch { /* malformed — none */ }
  }

  return {
    name: fm.name ?? slug,
    slug,
    description: fm.description ?? '',
    situation: fm.situation ?? '',
    tool: fm.tool || undefined,
    model: fm.model ?? 'unknown',
    evidenceCount: parseInt(fm.evidence_count ?? '1', 10),
    created: fm.created ?? new Date().toISOString().split('T')[0],
    lastConfirmed: fm.last_confirmed ?? fm.created ?? '',
    triggers,
    tried: parseSection(content, 'What was tried'),
    happened: parseSection(content, 'What happened'),
    boundary: parseSection(content, 'Boundary'),
  };
}

function serializeLesson(lesson: Lesson): string {
  return [
    '---',
    `name: ${lesson.name}`,
    `description: ${lesson.description}`,
    `situation: ${lesson.situation}`,
    ...(lesson.tool ? [`tool: ${lesson.tool}`] : []),
    `model: ${lesson.model}`,
    `evidence_count: ${lesson.evidenceCount}`,
    `created: ${lesson.created}`,
    `last_confirmed: ${lesson.lastConfirmed}`,
    `triggers: ${JSON.stringify(lesson.triggers.slice(-MAX_TRIGGERS))}`,
    '---',
    '',
    '## What was tried',
    lesson.tried,
    '',
    '## What happened',
    lesson.happened,
    '',
    '## Boundary',
    lesson.boundary,
    '',
  ].join('\n');
}

export class LessonStore {
  private readonly lessonsDir: string;

  constructor(workspacePath: string) {
    this.lessonsDir = join(workspacePath, 'lessons');
    mkdirSync(this.lessonsDir, { recursive: true });
  }

  list(): Array<{ slug: string; description: string; tool?: string; model: string; evidenceCount: number; lastConfirmed: string }> {
    if (!existsSync(this.lessonsDir)) return [];
    const out: ReturnType<LessonStore['list']> = [];
    for (const file of readdirSync(this.lessonsDir).filter(f => f.endsWith('.md'))) {
      try {
        const lesson = parseLesson(readFileSync(join(this.lessonsDir, file), 'utf-8'), file.replace(/\.md$/, ''));
        if (lesson) out.push({ slug: lesson.slug, description: lesson.description, tool: lesson.tool, model: lesson.model, evidenceCount: lesson.evidenceCount, lastConfirmed: lesson.lastConfirmed });
      } catch { /* skip malformed */ }
    }
    return out;
  }

  get(slug: string): Lesson | null {
    const path = join(this.lessonsDir, `${slug}.md`);
    if (!existsSync(path)) return null;
    try {
      return parseLesson(readFileSync(path, 'utf-8'), slug);
    } catch {
      return null;
    }
  }

  save(lesson: Lesson): void {
    writeFileSync(join(this.lessonsDir, `${lesson.slug}.md`), serializeLesson(lesson));
    console.log(`[Lessons] Saved: "${lesson.name}" (${lesson.slug}, evidence: ${lesson.evidenceCount})`);
  }

  /** The failure shape recurred — bump evidence (this is how a lesson goes
   *  live at LESSON_EVIDENCE_FLOOR) and record the concrete phrasing. */
  recordEvidence(slug: string, trigger?: string): Lesson | null {
    const lesson = this.get(slug);
    if (!lesson) return null;
    lesson.evidenceCount++;
    lesson.lastConfirmed = new Date().toISOString().split('T')[0];
    if (trigger) {
      const clean = trigger.trim().slice(0, 200);
      if (clean && !lesson.triggers.includes(clean)) {
        lesson.triggers = [...lesson.triggers, clean].slice(-MAX_TRIGGERS);
      }
    }
    this.save(lesson);
    return lesson;
  }

  archive(slug: string): boolean {
    const path = join(this.lessonsDir, `${slug}.md`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    console.log(`[Lessons] Archived: ${slug}`);
    return true;
  }
}
