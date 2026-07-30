import { describe, it, expect } from 'vitest';
import { isImageTransformRequest } from '../../src/services/media-extraction.js';
import { pickVisionText } from '../../src/services/vision.js';

describe('isImageTransformRequest', () => {
  it('matches transform requests (the July 29 Discord failures)', () => {
    expect(isImageTransformRequest('I need to make this picture animated in an anime style')).toBe(true);
    expect(isImageTransformRequest('Make this picture animated')).toBe(true);
    expect(isImageTransformRequest('turn this photo into a cartoon')).toBe(true);
    expect(isImageTransformRequest('ghibli version please')).toBe(true);
    expect(isImageTransformRequest('generate an image based on this')).toBe(true);
  });

  it('does NOT match ask-about-the-image captions (chat+vision stays default)', () => {
    expect(isImageTransformRequest('what is in this picture?')).toBe(false);
    expect(isImageTransformRequest('who is this?')).toBe(false);
    expect(isImageTransformRequest('what can I make with this?')).toBe(false); // fridge photo
    expect(isImageTransformRequest('is this plant healthy')).toBe(false);
    expect(isImageTransformRequest('')).toBe(false);
  });
});

describe('pickVisionText', () => {
  it('prefers content when present', () => {
    expect(pickVisionText('A red ball.', 'Here is a thinking process...')).toBe('A red ball.');
  });

  it('thinking fallback strips the CoT lead-in, keeping the final block', () => {
    const thinking = [
      "Here's a thinking process that leads to the detailed description:",
      'First I should look at the subject. The lighting suggests afternoon.',
      'A medium shot taken from a slightly high angle shows a young girl with long, curly blonde hair sitting on a wooden bench in a sunlit park, smiling at the camera.',
    ].join('\n\n');
    const picked = pickVisionText('', thinking);
    expect(picked.startsWith('A medium shot')).toBe(true);
    expect(picked).not.toContain('thinking process');
  });

  it('short or single-block thinking passes through whole (qwen3 answer-in-thinking case)', () => {
    expect(pickVisionText(undefined, 'A cat on a mat.')).toBe('A cat on a mat.');
  });

  it('empty everything → empty string', () => {
    expect(pickVisionText(undefined, undefined)).toBe('');
  });
});
