/**
 * Vault chunker — normalization ladder + structure-aware chunking.
 *
 * Documents arrive heterogeneous (clean markdown, PDF text, pasted walls of
 * prose). Everything converges to heading-scoped chunks via a quality ladder:
 *
 *   tier "headings"   markdown headings present → heading-PATH chunks
 *   tier "heuristic"  heading-shaped lines promoted (ALL-CAPS, 1.2 numbered,
 *                     === underlines) → then heading-path chunks
 *   tier "semantic"   no markers at all → embedding-valley segmentation
 *                     (topic boundaries = similarity dips between paragraphs)
 *   tier "paragraph"  fallback: overlapping paragraph windows
 *
 * Each chunk's embedded text is prefixed with its scope (title › heading path)
 * — an orphaned paragraph about "timeouts" retrieves poorly; the same text
 * under "Coding Rubric › Failure Semantics" retrieves precisely.
 * All math is deterministic; no generative model touches document text.
 */

export interface VaultChunk {
  text: string;          // scope-prefixed text that gets embedded + stored
  headingPath: string;   // "Coding Rubric › Gate 4: Security"
  index: number;
}

export interface VaultChunkResult {
  tier: 'headings' | 'heuristic' | 'semantic' | 'paragraph';
  chunks: VaultChunk[];
}

export interface VaultChunkOptions {
  maxChunkSize: number;   // chars
  overlapSize: number;
  /** Paragraph embedder for semantic segmentation. Absent → skip to paragraph tier. */
  embedParagraphs?: (paragraphs: string[]) => Promise<number[][]>;
}

const DEFAULTS = { maxChunkSize: 1000, overlapSize: 100 };
const MIN_SECTION_CHARS = 40; // only true fragments merge — a rubric gate's
                              // two-sentence section deserves its own chunk
                              // (120 collapsed adjacent gates into one mislabeled chunk)

// --- Tier detection ---

const MD_HEADING = /^(#{1,4})\s+(.+)$/;

function hasMarkdownHeadings(text: string): boolean {
  let count = 0;
  for (const line of text.split('\n')) if (MD_HEADING.test(line)) count++;
  return count >= 2;
}

/** Heading-shaped line heuristics for unstructured text. Returns heading level or 0. */
export function detectHeadingLine(line: string, nextLine?: string): number {
  const t = line.trim();
  if (!t || t.length > 80) return 0;
  // Underlined: text\n==== or ----
  if (nextLine && /^\s*(={3,}|-{3,})\s*$/.test(nextLine) && t.length > 2) return nextLine.trim().startsWith('=') ? 1 : 2;
  // Numbered outline: "1. Title", "2.3 Title" (short line, no ending period)
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(t) && !/[.:;,]$/.test(t) && t.split(/\s+/).length <= 10) {
    return (t.match(/\./g)?.length ?? 0) >= 2 ? 3 : 2;
  }
  // ALL-CAPS line (≥2 words, allows numbers/punct)
  const letters = t.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 8) return 2;
  return 0;
}

/** Promote heading-shaped lines to markdown headings. Returns null if fewer than 2 found. */
export function promoteHeadings(text: string): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let promoted = 0;
  for (let i = 0; i < lines.length; i++) {
    const level = detectHeadingLine(lines[i], lines[i + 1]);
    if (level > 0) {
      out.push(`${'#'.repeat(level)} ${lines[i].trim()}`);
      promoted++;
      // Swallow an underline line
      if (lines[i + 1] && /^\s*(={3,}|-{3,})\s*$/.test(lines[i + 1])) i++;
    } else {
      out.push(lines[i]);
    }
  }
  return promoted >= 2 ? out.join('\n') : null;
}

// --- Heading-path chunking (tiers: headings, heuristic) ---

interface Section {
  headingPath: string[];
  content: string;
}

function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  const stack: string[] = []; // heading text by level (index = level-1)
  let content: string[] = [];

  const flush = () => {
    const body = content.join('\n').trim();
    if (body) sections.push({ headingPath: stack.filter(Boolean), content: body });
    content = [];
  };

  for (const line of lines) {
    const m = line.match(MD_HEADING);
    if (m) {
      flush();
      const level = m[1].length;
      stack[level - 1] = m[2].trim();
      stack.length = level; // pop deeper levels
    } else {
      content.push(line);
    }
  }
  flush();
  return sections;
}

function windowText(text: string, maxChunkSize: number, overlapSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const windows: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChunkSize && current) {
      windows.push(current);
      current = `${current.slice(-overlapSize)}\n\n${para}`;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) windows.push(current);
  return windows;
}

function chunksFromSections(title: string, sections: Section[], opts: { maxChunkSize: number; overlapSize: number }): VaultChunk[] {
  // Merge runt sections into their successor (same-parent continuity is
  // approximated by adjacency, which follows document order)
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.content.length < MIN_SECTION_CHARS && prev.headingPath.length >= s.headingPath.length) {
      prev.content += `\n\n${s.headingPath.join(' › ')}\n${s.content}`;
    } else {
      merged.push({ ...s });
    }
  }

  const chunks: VaultChunk[] = [];
  for (const s of merged) {
    // Don't double the title when the doc's H1 is also headingPath[0]
    const pathParts = s.headingPath[0] === title ? s.headingPath : [title, ...s.headingPath];
    const path = pathParts.filter(Boolean).join(' › ');
    for (const window of windowText(s.content, opts.maxChunkSize, opts.overlapSize)) {
      chunks.push({ text: `${path}\n\n${window.trim()}`, headingPath: path, index: chunks.length });
    }
  }
  return chunks;
}

// --- Semantic-valley segmentation (tier: semantic) ---

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Cut positions where adjacent-paragraph similarity dips below mean − k·σ. */
export function semanticBoundaries(similarities: number[], k = 1.0): number[] {
  if (similarities.length < 3) return [];
  const mean = similarities.reduce((s, x) => s + x, 0) / similarities.length;
  const sd = Math.sqrt(similarities.reduce((s, x) => s + (x - mean) ** 2, 0) / similarities.length);
  const threshold = mean - k * sd;
  const cuts: number[] = [];
  for (let i = 0; i < similarities.length; i++) {
    if (similarities[i] < threshold) cuts.push(i + 1); // cut BEFORE paragraph i+1
  }
  return cuts;
}

/** Deterministic segment title: first ~6 content words. */
function segmentTitle(text: string): string {
  return text.trim().split(/\s+/).slice(0, 6).join(' ').replace(/[#*_>`]/g, '').slice(0, 60);
}

async function semanticChunks(
  title: string,
  text: string,
  opts: Required<Pick<VaultChunkOptions, 'maxChunkSize' | 'overlapSize'>> & { embedParagraphs: (p: string[]) => Promise<number[][]> },
): Promise<VaultChunk[] | null> {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  if (paragraphs.length < 4) return null; // too short to segment meaningfully

  let embeddings: number[][];
  try {
    embeddings = await opts.embedParagraphs(paragraphs);
  } catch {
    return null; // embedder unavailable → caller falls back to paragraph tier
  }
  if (embeddings.length !== paragraphs.length) return null;

  const sims: number[] = [];
  for (let i = 0; i < paragraphs.length - 1; i++) sims.push(cosine(embeddings[i], embeddings[i + 1]));
  const cuts = new Set(semanticBoundaries(sims));

  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (cuts.has(i) && current.length > 0) {
      segments.push(current.join('\n\n'));
      current = [];
    }
    current.push(paragraphs[i]);
  }
  if (current.length > 0) segments.push(current.join('\n\n'));
  if (segments.length < 2) return null; // no real structure found

  const chunks: VaultChunk[] = [];
  for (const seg of segments) {
    const path = `${title} › ${segmentTitle(seg)}`;
    for (const window of windowText(seg, opts.maxChunkSize, opts.overlapSize)) {
      chunks.push({ text: `${path}\n\n${window.trim()}`, headingPath: path, index: chunks.length });
    }
  }
  return chunks;
}

// --- Entry point ---

/** Title from first markdown H1, else the filename stem. */
export function docTitle(text: string, filePath: string): string {
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const stem = filePath.split('/').pop() ?? filePath;
  return stem.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

export async function normalizeAndChunk(
  text: string,
  filePath: string,
  options?: Partial<VaultChunkOptions>,
): Promise<VaultChunkResult> {
  const opts = { ...DEFAULTS, ...options };
  const title = docTitle(text, filePath);

  // Tier 1: native markdown headings
  if (hasMarkdownHeadings(text)) {
    return { tier: 'headings', chunks: chunksFromSections(title, splitSections(text), opts) };
  }

  // Tier 2: heading-shaped lines promoted
  const promoted = promoteHeadings(text);
  if (promoted) {
    return { tier: 'heuristic', chunks: chunksFromSections(title, splitSections(promoted), opts) };
  }

  // Tier 3: semantic-valley segmentation (needs an embedder)
  if (opts.embedParagraphs) {
    const semantic = await semanticChunks(title, text, { maxChunkSize: opts.maxChunkSize, overlapSize: opts.overlapSize, embedParagraphs: opts.embedParagraphs });
    if (semantic) return { tier: 'semantic', chunks: semantic };
  }

  // Tier 4: overlapping paragraph windows, filename as scope
  const chunks = windowText(text, opts.maxChunkSize, opts.overlapSize)
    .map((w, i) => ({ text: `${title}\n\n${w.trim()}`, headingPath: title, index: i }));
  return { tier: 'paragraph', chunks };
}
