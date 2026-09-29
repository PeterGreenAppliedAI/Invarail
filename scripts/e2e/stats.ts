/**
 * Small-sample statistics for the report. Three to five reps per task is what a GPU night
 * affords; an interval says how little a 2/3 means next to a 3/3.
 */

/** Wilson score interval for k passes out of n (95% by default). Stays inside [0, 1] and
 *  behaves at k = 0 and k = n, where the normal approximation collapses to a zero-width band. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** "35/36 (86–100%)" — passes, attempts, and the 95% Wilson interval. */
export function passRate(k: number, n: number): string {
  if (n === 0) return '—';
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} (${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`;
}
