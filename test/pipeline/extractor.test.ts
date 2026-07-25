import { describe, it, expect, vi } from 'vitest';
import { extractParams, validateExtractedParams } from '../../src/pipeline/extractor.js';
import type { OllamaClient } from '../../src/ollama/client.js';

function mockClient(responses: string[]): OllamaClient {
  let i = 0;
  return {
    chat: vi.fn().mockImplementation(async () => ({
      message: { role: 'assistant', content: responses[i++] ?? '' },
    })),
  } as unknown as OllamaClient;
}

const schema = {
  query: { type: 'string', description: 'Search query', required: true },
  count: { type: 'number', description: 'Result count' },
  freshness: { type: 'string', description: 'Time filter', enum: ['day', 'week', 'month'] },
};

describe('validateExtractedParams', () => {
  it('coerces string numbers and booleans', () => {
    const { params, errors } = validateExtractedParams(
      { n: { type: 'number', description: '' }, b: { type: 'boolean', description: '' } },
      { n: '5', b: 'true' },
    );
    expect(errors).toEqual([]);
    expect(params.n).toBe(5);
    expect(params.b).toBe(true);
  });

  it('flags missing required keys but allows empty strings', () => {
    const { errors } = validateExtractedParams(
      { id: { type: 'string', description: '', required: true } },
      {},
    );
    expect(errors).toHaveLength(1);

    const ok = validateExtractedParams(
      { id: { type: 'string', description: '', required: true } },
      { id: '' },
    );
    expect(ok.errors).toEqual([]);
  });

  it('flags enum violations only for non-empty values', () => {
    const bad = validateExtractedParams(schema, { query: 'x', freshness: 'yearly' });
    expect(bad.errors.some(e => e.includes('freshness'))).toBe(true);

    const empty = validateExtractedParams(schema, { query: 'x', freshness: '' });
    expect(empty.errors).toEqual([]);
  });
});

describe('extractParams', () => {
  it('parses JSON5-style sloppy output without burning a repair call', async () => {
    const client = mockClient([`{'query': 'AI news', count: 5,}`]);
    const result = await extractParams(client, 'test', schema, 'search AI news');
    expect(result).toEqual({ query: 'AI news', count: 5 });
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('repairs unparseable output on second attempt', async () => {
    const client = mockClient([
      'Sure! Here is what I found for you.',
      '{"query": "AI news"}',
    ]);
    const result = await extractParams(client, 'test', schema, 'search AI news');
    expect(result.query).toBe('AI news');
    expect(client.chat).toHaveBeenCalledTimes(2);
  });

  it('sends validation errors to repair and returns corrected params', async () => {
    const client = mockClient([
      '{"query": "AI news", "freshness": "yearly"}',
      '{"query": "AI news", "freshness": "month"}',
    ]);
    const result = await extractParams(client, 'test', schema, 'search AI news');
    expect(result.freshness).toBe('month');
    expect(client.chat).toHaveBeenCalledTimes(2);
  });

  it('falls back to best-effort params when repair output is unparseable', async () => {
    const client = mockClient([
      '{"query": "AI news", "freshness": "yearly"}',
      'I cannot produce JSON right now.',
    ]);
    const result = await extractParams(client, 'test', schema, 'search AI news');
    expect(result.query).toBe('AI news');
  });

  it('throws when nothing is parseable', async () => {
    const client = mockClient(['nope', 'still nope']);
    await expect(extractParams(client, 'test', schema, 'search')).rejects.toThrow();
  });
});

const jobsSchema = {
  jobs: {
    type: 'array',
    description: 'jobs to schedule',
    required: true,
    items: {
      name: { type: 'string', description: 'job name', required: true },
      category: { type: 'string', description: 'category', enum: ['message', 'web_search'] },
      once: { type: 'boolean', description: 'one-shot' },
    },
  },
};

describe('array fields', () => {
  it('validates and coerces each element against the items schema', () => {
    const { params, errors } = validateExtractedParams(jobsSchema, {
      jobs: [
        { name: 'a', category: 'message', once: 'true' },
        { name: 'b', category: 'web_search' },
      ],
    });
    expect(errors).toEqual([]);
    const jobs = params.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].once).toBe(true);
  });

  it('flags non-array values and indexes element errors', () => {
    const notArray = validateExtractedParams(jobsSchema, { jobs: 'oops' });
    expect(notArray.errors.some(e => e.includes('should be an array'))).toBe(true);

    const badElement = validateExtractedParams(jobsSchema, {
      jobs: [{ name: 'a', category: 'nonsense' }, { category: 'message' }],
    });
    expect(badElement.errors.some(e => e.includes('jobs[0]') && e.includes('category'))).toBe(true);
    expect(badElement.errors.some(e => e.includes('jobs[1]') && e.includes('name'))).toBe(true);
  });

  it('extracts arrays end-to-end and honors maxTokens', async () => {
    const client = mockClient(['{"jobs": [{"name": "a", "category": "message", "once": true}, {"name": "b", "category": "web_search"}]}']);
    const result = await extractParams(client, 'test', jobsSchema, 'set up two jobs', undefined, undefined, 2048);
    const jobs = result.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].once).toBe(true);
    const call = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.options.num_predict).toBe(2048);
    expect(call.format.properties.jobs.type).toBe('array');
    expect(call.format.properties.jobs.items.properties.category.enum).toEqual(['message', 'web_search']);
  });
});
