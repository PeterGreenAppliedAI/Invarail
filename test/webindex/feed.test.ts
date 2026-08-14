import { describe, it, expect } from 'vitest';
import { parseFeed, decodeEntities } from '../../src/webindex/feed.js';
import { chunkText } from '../../src/webindex/service.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Nemotron 3.5 Lightning released</title><link>https://example.com/lightning</link><pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate></item>
<item><title><![CDATA[Qwen &amp; friends: a 2.4T flagship]]></title><link>https://example.com/qwen</link><pubDate>Wed, 13 Aug 2026 12:00:00 GMT</pubDate></item>
<item><title>No link item</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>v0.32.9</title><link rel="alternate" href="https://github.com/ollama/ollama/releases/tag/v0.32.9"/><link rel="self" href="https://github.com/feed"/><updated>2026-08-10T00:00:00Z</updated></entry>
<entry><title>v0.32.8</title><link href="https://github.com/ollama/ollama/releases/tag/v0.32.8"/><published>2026-08-01T00:00:00Z</published></entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS items with dates, skips linkless items', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: 'Nemotron 3.5 Lightning released', url: 'https://example.com/lightning', publishedAt: '2026-08-11T09:00:00.000Z' });
    expect(items[1].title).toBe('Qwen & friends: a 2.4T flagship'); // CDATA + entity decoded
  });

  it('parses Atom entries, preferring rel=alternate links', () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://github.com/ollama/ollama/releases/tag/v0.32.9');
    expect(items[0].publishedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(items[1].url).toContain('v0.32.8');
  });

  it('returns empty for unparseable garbage instead of throwing', () => {
    expect(parseFeed('not xml at all')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('handles named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#8212; &#x2014;')).toBe('a & b <c> — —');
  });
});

describe('chunkText', () => {
  it('packs paragraphs to size and splits oversized ones', () => {
    const text = ['p1 short', 'p2 short', 'x'.repeat(3000)].join('\n\n');
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks[0]).toContain('p1 short');
  });

  it('keeps small text as one chunk', () => {
    expect(chunkText('hello world', 1000)).toEqual(['hello world']);
  });
});
