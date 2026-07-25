import JSON5 from 'json5';
import type { OllamaClient } from '../ollama/client.js';
import type { ExtractFieldSchema as FieldSchema } from './types.js';
import { pipelineExtractFailure } from '../errors.js';

/**
 * Validate and coerce extracted params against the schema.
 * - required means the KEY must be present (empty string is allowed — the
 *   convention for "unknown", see cron remove examples)
 * - coerces string→number / string→boolean per field type
 * - enum values are validated only when non-empty
 */
export function validateExtractedParams(
  schema: Record<string, FieldSchema>,
  params: Record<string, unknown>,
): { params: Record<string, unknown>; errors: string[] } {
  const coerced: Record<string, unknown> = { ...params };
  const errors: string[] = [];

  for (const [name, field] of Object.entries(schema)) {
    const val = coerced[name];

    if (field.required && (val === undefined || val === null)) {
      errors.push(`Missing required field "${name}"`);
      continue;
    }
    if (val === undefined || val === null || val === '') continue;

    if (field.type === 'array') {
      if (!Array.isArray(val)) {
        errors.push(`Field "${name}" should be an array, got ${typeof val}`);
        continue;
      }
      if (field.items) {
        const itemSchema = field.items;
        coerced[name] = val.map((el, i) => {
          if (typeof el !== 'object' || el === null || Array.isArray(el)) {
            errors.push(`"${name}[${i}]" should be an object`);
            return el;
          }
          const sub = validateExtractedParams(itemSchema, el as Record<string, unknown>);
          errors.push(...sub.errors.map(e => `${name}[${i}]: ${e}`));
          return sub.params;
        });
      }
      continue;
    }

    if ((field.type === 'number' || field.type === 'integer') && typeof val === 'string') {
      const num = Number(val);
      if (!isNaN(num)) coerced[name] = num;
      else errors.push(`Field "${name}" should be a number, got "${val}"`);
    } else if (field.type === 'boolean' && typeof val === 'string') {
      coerced[name] = val === 'true' || val === '1';
    }

    if (field.enum && !field.enum.includes(String(coerced[name]))) {
      errors.push(`Field "${name}" must be one of: ${field.enum.join(', ')}. Got: "${coerced[name]}"`);
    }
  }

  return { params: coerced, errors };
}

/**
 * Build a focused extraction prompt from a schema definition.
 * The LLM returns ONLY a JSON object — no reasoning, no explanation.
 */
export function buildExtractionPrompt(
  schema: Record<string, FieldSchema>,
  userMessage: string,
  examples?: Array<{ input: string; output: Record<string, unknown> }>,
  extraContext?: string,
): { system: string; user: string } {
  const renderField = (name: string, field: FieldSchema, indent: string): string => {
    let line = `${indent}- "${name}" (${field.type}${field.required ? ', required' : ', optional'}): ${field.description}`;
    if (field.enum) line += ` — one of: ${field.enum.join(', ')}`;
    if (field.type === 'array' && field.items) {
      line += `. Each element is an object with:\n`
        + Object.entries(field.items).map(([n, f]) => renderField(n, f, `${indent}  `)).join('\n');
    }
    return line;
  };
  const fields = Object.entries(schema)
    .map(([name, field]) => renderField(name, field, ''))
    .join('\n');

  let system = `Extract the following parameters from the user's message as a JSON object.\n\n${fields}\n\nReturn ONLY a valid JSON object. No explanation, no markdown, no extra text.`;

  if (extraContext) {
    system += `\n\nReference data (use this to resolve IDs and fuzzy references):\n${extraContext}`;
  }

  if (examples && examples.length > 0) {
    const exLines = examples
      .map(ex => `Input: "${ex.input}"\nOutput: ${JSON.stringify(ex.output)}`)
      .join('\n\n');
    system += `\n\nExamples:\n${exLines}`;
  }

  return { system, user: userMessage };
}

/** Build a JSON schema for grammar-constrained decoding from the extraction schema. */
function buildJsonSchema(schema: Record<string, FieldSchema>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(schema)) {
    if (f.type === 'array') {
      properties[name] = { type: 'array', items: f.items ? buildJsonSchema(f.items) : { type: 'string' } };
      continue;
    }
    const prop: Record<string, unknown> = {
      type: f.type === 'integer' ? 'integer'
        : f.type === 'number' ? 'number'
        : f.type === 'boolean' ? 'boolean'
        : 'string',
    };
    if (f.enum) prop.enum = f.enum;
    properties[name] = prop;
  }
  const required = Object.keys(schema).filter(k => schema[k].required);
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

// Flipped false the first time a backend rejects the `format` param so we don't
// pay a failed round-trip on every extraction against an older gateway.
let structuredOutputsSupported = true;

/** Chat with grammar-constrained JSON output when supported; plain chat otherwise. */
export async function chatMaybeStructured(
  client: OllamaClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  jsonSchema: Record<string, unknown>,
  maxTokens = 256,
): Promise<string> {
  const options = { temperature: 0.1, num_predict: maxTokens };
  if (structuredOutputsSupported) {
    try {
      const response = await client.chat({ model, messages, format: jsonSchema, options });
      return response.message?.content ?? '';
    } catch (err) {
      structuredOutputsSupported = false;
      console.warn('[Extract] Backend rejected structured format — falling back to prompt-only JSON:',
        err instanceof Error ? err.message : err);
    }
  }
  const response = await client.chat({ model, messages, options });
  return response.message?.content ?? '';
}

/**
 * Call the LLM to extract structured params, parse the JSON response.
 * Uses grammar-constrained decoding when the backend supports it.
 * Retries once with a repair prompt on parse failure.
 */
export async function extractParams(
  client: OllamaClient,
  model: string,
  schema: Record<string, FieldSchema>,
  userMessage: string,
  examples?: Array<{ input: string; output: Record<string, unknown> }>,
  extraContext?: string,
  maxTokens?: number,
): Promise<Record<string, unknown>> {
  const { system, user } = buildExtractionPrompt(schema, userMessage, examples, extraContext);
  const jsonSchema = buildJsonSchema(schema);

  const raw = await chatMaybeStructured(client, model, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], jsonSchema, maxTokens);

  const parsed = tryParseJson(raw);
  if (parsed) {
    const validated = validateExtractedParams(schema, parsed);
    if (validated.errors.length === 0) return validated.params;
    // Fall through to repair with specific validation errors
    return repairExtraction(client, model, system, user, raw,
      `The JSON was parseable but invalid: ${validated.errors.join('; ')}. Return a corrected JSON object only.`, schema, validated.params, maxTokens);
  }

  return repairExtraction(client, model, system, user, raw,
    'That was not valid JSON. Return ONLY a JSON object like {"key": "value"}, nothing else.', schema, undefined, maxTokens);
}

/** One repair round-trip. Validation errors on the repaired output are tolerated
 *  (coerced params returned) — required-but-empty is the model's "unknown" signal
 *  and downstream tools produce a model-visible error the loop can react to. */
async function repairExtraction(
  client: OllamaClient,
  model: string,
  system: string,
  user: string,
  priorRaw: string,
  repairInstruction: string,
  schema: Record<string, FieldSchema>,
  bestEffortParams?: Record<string, unknown>,
  maxTokens?: number,
): Promise<Record<string, unknown>> {
  const repairRaw = await chatMaybeStructured(client, model, [
    { role: 'system', content: system },
    { role: 'user', content: user },
    { role: 'assistant', content: priorRaw },
    { role: 'user', content: repairInstruction },
  ], buildJsonSchema(schema), maxTokens);

  const repairParsed = tryParseJson(repairRaw);
  if (repairParsed) {
    const validated = validateExtractedParams(schema, repairParsed);
    if (validated.errors.length > 0) {
      console.warn(`[Extract] Repaired output still has issues (using anyway): ${validated.errors.join('; ')}`);
    }
    return validated.params;
  }

  // Repair produced unparseable output — prefer the earlier parseable-but-imperfect
  // params over aborting the whole pipeline
  if (bestEffortParams) {
    console.warn('[Extract] Repair unparseable — using best-effort params from first attempt');
    return bestEffortParams;
  }

  throw pipelineExtractFailure('extract', repairRaw);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  // Strip thinking model tags (qwen3.6, nemotron, etc.)
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Try direct parse — strict JSON, then JSON5 (trailing commas, single quotes,
  // unquoted keys — classic small-model sloppiness that shouldn't burn a repair call)
  const parsed = parseObject(cleaned);
  if (parsed) return parsed;

  // Try extracting JSON from markdown fences or surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const greedy = parseObject(jsonMatch[0]);
    if (greedy) return greedy;

    // Greedy match may have caught trailing text — try balanced brace extraction
    const start = cleaned.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') depth--;
        if (depth === 0) {
          const balanced = parseObject(cleaned.slice(start, i + 1));
          if (balanced) return balanced;
          break;
        }
      }
    }
  }

  return null;
}

/** Parse a candidate string as a JSON object — strict JSON first, then JSON5. */
function parseObject(candidate: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(candidate);
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) return obj;
  } catch { /* fall through */ }
  try {
    const obj = JSON5.parse(candidate);
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) return obj;
  } catch { /* fall through */ }
  return null;
}
