/**
 * Code-owned prompt grammars for image generation. The model contributes the
 * SUBJECT and confirmed user intent; code contributes the photographic grammar —
 * same doctrine as document styling (models never write HTML/CSS; here they
 * never own composition rules).
 *
 * Two grammars because images-for-eyes and images-for-reconstruction are
 * different artifacts: a 3D-lift source needs silhouette clarity and geometry-
 * neutral lighting — everything artistic grammar rewards (drama, crops,
 * atmosphere) becomes reconstruction noise.
 */

/** Artistic: light touch — quality tail only, never overriding stated style. */
export function scaffoldArtistic(expandedIntent: string): string {
  const intent = expandedIntent.trim().replace(/[,.\s]+$/, '');
  return `${intent}. High detail, coherent composition, clean rendering.`;
}

/** Reconstruction: HARD template. The subject drops into a fixed grammar tuned
 *  for image→3D lifting (Hunyuan-class models). */
export function scaffoldFor3D(subject: string): string {
  const s = subject.trim().replace(/[,.\s]+$/, '');
  return [
    `A single ${s}, perfectly centered, entire object fully visible in frame`,
    'three-quarter view',
    'plain solid neutral gray background',
    'flat even diffuse studio lighting, no shadows, no reflections',
    'no other objects, no text, no watermark',
    'clear silhouette, matte surface, product photography style',
  ].join(', ') + '.';
}

export type ImageMode = 'artistic' | 'model3d';

export function applyScaffold(mode: ImageMode, prompt: string): string {
  return mode === 'model3d' ? scaffoldFor3D(prompt) : scaffoldArtistic(prompt);
}
