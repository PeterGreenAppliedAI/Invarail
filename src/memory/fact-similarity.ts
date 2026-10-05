/**
 * "Is this the same fact?" — one lexical definition, used everywhere memory decides whether it
 * already knows something or was told to drop it (DECISIONS 2026-10-05).
 *
 * Lexical on purpose: the starter install has no embedder, and the flat store is the only store
 * there. Calibrated on the owner's real index (445 facts): at >= 55% word overlap with >= 5 shared
 * content words, every sampled pair was the same fact reworded ("works at DevMesh as an ML
 * engineer" / "is the technical founder of DevMesh") or an update of it ("needs to add a high-fiber
 * diet" → "has added"); short facts that share topic words ("son does Taekwondo on Tuesdays" /
 * "son does swimming on Tuesdays") stay below the shared-word floor.
 */

export const SAME_FACT_JACCARD = 0.55;
export const SAME_FACT_MIN_SHARED = 5;

/** Words that carry no fact identity: the subject every fact is about, and filler. */
const STOP = new Set([
  'user', 'users', 'that', 'this', 'with', 'from', 'have', 'been', 'their', 'they', 'them', 'about',
  'into', 'also', 'what', 'when', 'which', 'will', 'would', 'there', 'were', 'named', 'currently',
]);

export function factWords(text: string, extraStop?: Iterable<string>): Set<string> {
  const extra = new Set([...(extraStop ?? [])].map(w => w.toLowerCase()));
  const words = text.toLowerCase().replace(/'s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ');
  return new Set(words.filter(w => w.length > 3 && !STOP.has(w) && !extra.has(w)));
}

export function overlap(a: Set<string>, b: Set<string>): { shared: number; jaccard: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return { shared, jaccard: union === 0 ? 0 : shared / union };
}

/** Same fact, reworded or updated. */
export function sameFact(a: string | Set<string>, b: string | Set<string>, extraStop?: Iterable<string>): boolean {
  const A = typeof a === 'string' ? factWords(a, extraStop) : a;
  const B = typeof b === 'string' ? factWords(b, extraStop) : b;
  const { shared, jaccard } = overlap(A, B);
  return shared >= SAME_FACT_MIN_SHARED && jaccard >= SAME_FACT_JACCARD;
}

/**
 * Does a candidate fact match something the owner removed? A removal record carries what the owner
 * typed (often a short query — "wedding ring") and, since 2026-10-05, the texts it actually removed.
 * The query matches the way removal did (case-insensitive substring); removed texts match by
 * sameFact, so a rewording of a forgotten fact is caught too.
 */
export function matchesRemoval(text: string, removal: { text: string; facts?: string[] }): boolean {
  const lower = text.toLowerCase();
  const q = removal.text.trim().toLowerCase();
  if (q.length >= 3 && lower.includes(q)) return true;
  const words = factWords(text);
  return [removal.text, ...(removal.facts ?? [])].some(r => sameFact(words, r));
}

/** Ordering for "which version wins": the owner's word outranks observation outranks inference. */
export const PROVENANCE_RANK: Record<string, number> = { stated: 3, observed: 2, inferred: 1 };
export function provenanceRank(p: string | undefined): number {
  return PROVENANCE_RANK[p ?? 'observed'] ?? 2;
}
