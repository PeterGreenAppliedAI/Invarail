/** Extract a page's declared publish date from raw HTML head metadata.
 *  Checked in order of trustworthiness: OpenGraph/article meta, JSON-LD
 *  datePublished, generic meta date tags, first <time datetime>. Returns
 *  ISO string or null — callers fall back to fetchedAt only when the page
 *  truly declares nothing (undated docs rank neutral, never fresh). */

const META_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["'](?:date|dc\.date|publish-date|publication_date|parsely-pub-date)["'][^>]+content=["']([^"']+)["']/i,
];

const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const TIME_RE = /<time[^>]+datetime=["']([^"']+)["']/i;

function toIso(value: string): string | null {
  const t = new Date(value.trim()).getTime();
  if (isNaN(t)) return null;
  // Reject clock-skew futures and obviously-bogus ancient dates.
  if (t > Date.now() + 86_400_000 || t < new Date('1995-01-01').getTime()) return null;
  return new Date(t).toISOString();
}

export function extractPublishedDate(html: string): string | null {
  const head = html.slice(0, 200_000);
  for (const re of META_PATTERNS) {
    const m = head.match(re);
    if (m) {
      const iso = toIso(m[1]);
      if (iso) return iso;
    }
  }
  for (const m of head.matchAll(JSONLD_RE)) {
    const dm = m[1].match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (dm) {
      const iso = toIso(dm[1]);
      if (iso) return iso;
    }
  }
  const tm = head.match(TIME_RE);
  if (tm) {
    const iso = toIso(tm[1]);
    if (iso) return iso;
  }
  return null;
}
