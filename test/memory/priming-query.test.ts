import { describe, it, expect } from 'vitest';
import { primingQueryFrom } from '../../src/dispatch.js';

describe('primingQueryFrom', () => {
  it('passes a plain message through', () => {
    expect(primingQueryFrom('What do you know about me')).toBe('What do you know about me');
  });

  // The turn that produced the first live priming timeout: a PDF's 8.9K chars
  // rode along with the message and priming embedded all of it.
  it('strips an attached PDF body but keeps its header', () => {
    const body = 'Roadmap section one. '.repeat(500);
    const msg = `[The user attached a PDF: roadmap.pdf. Extracted text below:]\n\n${body}\n\n[End of attached PDF text]\n\nEven if they hate it, this is the deck`;
    const q = primingQueryFrom(msg);
    expect(q).toBe('[The user attached a PDF: roadmap.pdf. Extracted text below:] Even if they hate it, this is the deck');
  });

  it('strips a Chrome-extension page body', () => {
    const msg = `[PAGE: https://x.test | Title]\n[PAGE_CONTENT]\n${'lorem '.repeat(2000)}\n[/PAGE_CONTENT]\nsummarize this`;
    expect(primingQueryFrom(msg)).toBe('[PAGE: https://x.test | Title] summarize this');
  });

  it('caps whatever survives stripping', () => {
    const q = primingQueryFrom('word '.repeat(1000));
    expect(q.length).toBe(800);
  });

  it('handles an undelimited legacy PDF prefix by falling back to the cap', () => {
    const msg = `[The user attached a PDF: old.pdf. Extracted text below:]\n\n${'x '.repeat(3000)}`;
    expect(primingQueryFrom(msg).length).toBe(800);
  });
});
