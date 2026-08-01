import { describe, it, expect } from 'vitest';
import { parseFlowGather } from '../../src/pipeline/definitions/research.js';

const WEEKLY_GATHER_SAMPLE = `# Weekly AI gathering — raw material

## open-source models
- **The Best Open Source LLMs to Run Locally in 2026** — https://huggingface.co/blog/daya-shankar/open-source-llm-models-to-run-locally
- **Open-Source LLM Leaderboard 2026** — https://lmmarketcap.com/leaderboards/open-llm-leaderboard

## model releases
- **Top Tech News Today** (https://techstartups.com/2026/07/27/top-tech-news-today) — Anthropic, Nvidia, OpenAI.

## hardware
- **On-device LLM inference** — https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/.

## empty section
No results this week.
`;

describe('parseFlowGather', () => {
  it('parses sections into facets with their URLs', () => {
    const facets = parseFlowGather(WEEKLY_GATHER_SAMPLE);
    expect(facets.map(f => f.angle)).toEqual(['open-source models', 'model releases', 'hardware']);
    expect(facets[0].urls).toHaveLength(2);
    expect(facets[1].urls).toEqual(['https://techstartups.com/2026/07/27/top-tech-news-today']);
  });

  it('strips trailing punctuation from URLs', () => {
    const facets = parseFlowGather(WEEKLY_GATHER_SAMPLE);
    expect(facets[2].urls).toEqual(['https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/']);
  });

  it('drops sections without URLs', () => {
    const facets = parseFlowGather(WEEKLY_GATHER_SAMPLE);
    expect(facets.find(f => f.angle === 'empty section')).toBeUndefined();
  });

  it('dedupes repeated URLs within a section', () => {
    const md = '## a\n- x https://example.com/p\n- y https://example.com/p';
    expect(parseFlowGather(md)[0].urls).toEqual(['https://example.com/p']);
  });

  it('returns empty for markdown with no sections', () => {
    expect(parseFlowGather('just some text https://example.com')).toEqual([]);
  });
});
