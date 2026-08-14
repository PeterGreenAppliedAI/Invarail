/**
 * Minimal RSS 2.0 / Atom feed parser — regex-level item extraction, zero
 * dependencies (house rule). Handles the common shapes of the feeds we seed
 * (vendor blogs, GitHub releases.atom, arxiv, HN/reddit); exotic feeds that
 * fail to parse simply contribute no items — degrade, never crash.
 */

export interface FeedItem {
  title: string;
  url: string;
  /** ISO string when the feed provided a parseable date */
  publishedAt?: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, m => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function firstTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(stripCdata(m[1])) : undefined;
}

/** Parse feed XML into items. Detects RSS (<item>) vs Atom (<entry>). */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  // RSS 2.0: <item><title/><link>url</link><pubDate/></item>
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = firstTag(block, 'title');
    const link = firstTag(block, 'link') ?? firstTag(block, 'guid');
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, url: link.trim(), publishedAt: parseDate(firstTag(block, 'pubDate') ?? firstTag(block, 'dc:date')) });
  }
  if (items.length > 0) return items;

  // Atom: <entry><title/><link href="url"/><published|updated/></entry>
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const title = firstTag(block, 'title');
    // Prefer rel="alternate" (or rel-less) link over self/edit links
    let href: string | undefined;
    for (const lm of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
      const attrs = lm[1];
      const rel = attrs.match(/rel=["']([^"']+)["']/)?.[1];
      const h = attrs.match(/href=["']([^"']+)["']/)?.[1];
      if (!h) continue;
      if (!rel || rel === 'alternate') { href = decodeEntities(h); break; }
      if (!href) href = decodeEntities(h);
    }
    if (!title || !href || !/^https?:\/\//i.test(href)) continue;
    items.push({ title, url: href.trim(), publishedAt: parseDate(firstTag(block, 'published') ?? firstTag(block, 'updated')) });
  }
  return items;
}
