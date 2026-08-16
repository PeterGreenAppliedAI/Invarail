import { describe, it, expect } from 'vitest';
import {
  parseJsonLoose,
  parseClaims,
  parseVerdict,
  verdictToAction,
  needsCorrection,
  buildPatchSet,
  pickRelevantSources,
  stripStrikethrough,
  locateClaimSentence,
  guardRewrite,
  verificationSection,
  shouldEscalate,
  tier1Query,
  parseTier1,
  applyTier1,
  entailmentPrompt,
  type Claim,
  type VerificationResult,
  type Tier1Result,
} from '../../src/pipeline/verification.js';

describe('parseJsonLoose', () => {
  it('parses a bare array', () => {
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('extracts an array from prose + fences', () => {
    const txt = 'Sure! ```json\n[{"a":1}]\n``` done';
    expect(parseJsonLoose(txt)).toEqual([{ a: 1 }]);
  });
  it('strips <think> blocks and parses an object', () => {
    expect(parseJsonLoose('<think>hmm</think>{"verdict":"VERIFIED"}')).toEqual({ verdict: 'VERIFIED' });
  });
  it('returns null on garbage', () => {
    expect(parseJsonLoose('no json here')).toBeNull();
  });
});

describe('parseClaims', () => {
  it('keeps only verifiable claim types and caps at maxClaims', () => {
    const raw = JSON.stringify([
      { claim_id: 'claim-001', claim: 'NVIDIA held ~92% of the discrete GPU market in H1 2025.', claim_type: 'market_share', citation: 5 },
      { claim_id: 'claim-002', claim: 'Local inference is exciting and the future.', claim_type: 'opinion' },
      { claim_id: 'claim-003', claim: 'The RTX PRO 6000 has 96GB of VRAM.', claim_type: 'product_spec', citation: 1 },
    ]);
    const claims = parseClaims(raw, 12);
    expect(claims).toHaveLength(2); // opinion dropped
    expect(claims[0].citation).toBe(5);
    expect(claims.map(c => c.claim_type)).toEqual(['market_share', 'product_spec']);
  });

  it('respects the maxClaims cap', () => {
    const raw = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ claim: `Company ${i} reported $${i}B revenue in 2025.`, claim_type: 'financial' })),
    );
    expect(parseClaims(raw, 5)).toHaveLength(5);
  });

  it('returns [] for non-array / unparseable input', () => {
    expect(parseClaims('not json', 12)).toEqual([]);
    expect(parseClaims('{"claim":"x"}', 12)).toEqual([]);
  });
});

describe('verdictToAction', () => {
  it('maps verdicts to default actions and NEVER auto-removes', () => {
    expect(verdictToAction('VERIFIED')).toBe('keep');
    expect(verdictToAction('VENDOR_CLAIM')).toBe('attribute');
    expect(verdictToAction('PARTIALLY_VERIFIED')).toBe('qualify');
    expect(verdictToAction('UNSUPPORTED')).toBe('qualify'); // hedge, not delete
    expect(verdictToAction('AMBIGUOUS')).toBe('qualify');
    expect(verdictToAction('CONTRADICTED')).toBe('correct'); // Tier-1 only
  });
});

describe('Tier-1 independent cross-check', () => {
  const corporate: Claim = { claim_id: 't1', claim: "NVIDIA acquired Groq's LPU technology for $20 billion in December 2024.", claim_type: 'corporate_event', time_sensitive: true, entities: ['NVIDIA', 'Groq'], requires_verification: true };
  const spec: Claim = { claim_id: 't2', claim: 'The RTX 5090 has 32GB VRAM.', claim_type: 'product_spec', time_sensitive: false, entities: ['NVIDIA'], requires_verification: true };
  const noEntity: Claim = { claim_id: 't3', claim: 'The market grew 20% last year.', claim_type: 'market_share', time_sensitive: true, entities: [], requires_verification: true };
  const price: Claim = { claim_id: 't4', claim: 'The RTX 4090 is priced at approximately $2,500.', claim_type: 'financial', time_sensitive: true, entities: ['NVIDIA'], requires_verification: true };
  const share: Claim = { claim_id: 't5', claim: 'NVIDIA holds ~92% of the discrete GPU market.', claim_type: 'market_share', time_sensitive: true, entities: ['NVIDIA'], requires_verification: true };

  it('escalates only stable high-impact corporate/market claims with entities', () => {
    expect(shouldEscalate(corporate)).toBe(true);
    expect(shouldEscalate(share)).toBe(true);
    expect(shouldEscalate(spec)).toBe(false);       // product_spec not escalated
    expect(shouldEscalate(noEntity)).toBe(false);   // needs an entity to target
    expect(shouldEscalate(price)).toBe(false);      // volatile product price (financial) not escalated
  });

  it('builds a query from entities + key terms, WITHOUT the contested number/date', () => {
    const q = tier1Query(corporate);
    expect(q).toContain('nvidia');
    expect(q).toContain('groq');
    expect(q).not.toMatch(/\$20|billion|2024/i); // contested value excluded so search finds the truth
  });

  it('parseTier1 defaults to SILENT on garbage and reads a CONTRADICTED verdict', () => {
    expect(parseTier1('junk').status).toBe('SILENT');
    const t = parseTier1(JSON.stringify({ status: 'CONTRADICTED', source_url: 'https://nvidia.com/news', evidence: 'NVIDIA licensed Groq tech in December 2025.', reason: 'Different date and it was a license.' }));
    expect(t.status).toBe('CONTRADICTED');
    expect(t.evidence).toMatch(/December 2025/);
  });

  it('applyTier1 CONTRADICTED escalates the claim to a correction', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' };
    const t: Tier1Result = { status: 'CONTRADICTED', source_url: 'https://nvidia.com/news', evidence: 'NVIDIA licensed Groq tech in December 2025.' };
    const out = applyTier1(v, t);
    expect(out.verdict).toBe('CONTRADICTED');
    expect(out.recommended_action).toBe('correct');
    expect(needsCorrection(out)).toBe(true);
    expect(out.tier1?.evidence).toMatch(/December 2025/);
  });

  it('applyTier1 CONFIRMED un-hedges a previously qualified claim', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'AMBIGUOUS', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' };
    const out = applyTier1(v, { status: 'CONFIRMED' });
    expect(out.recommended_action).toBe('keep');
  });

  it('applyTier1 SILENT leaves the cited-source verdict untouched', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'AMBIGUOUS', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' };
    const out = applyTier1(v, { status: 'SILENT' });
    expect(out.recommended_action).toBe('qualify');
    expect(out.tier1?.status).toBe('SILENT');
  });

  it('a corrected claim renders in the appendix with its independent evidence', () => {
    const results: VerificationResult[] = [
      { claim_id: 't1', claim: 'NVIDIA acquired Groq in December 2024.', verdict: 'CONTRADICTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'correct', tier1: { status: 'CONTRADICTED', evidence: 'It was a license in December 2025.' } },
    ];
    const md = verificationSection(results);
    expect(md).toContain('CONTRADICTED');
    expect(md).toMatch(/independent source/i);
    expect(md).toContain('December 2025');
  });
});

describe('pickRelevantSources', () => {
  const sources = {
    'https://guide.example/hardware': 'The Mac Studio M3 Ultra can be configured with up to 512GB unified memory at 819 GB/s.',
    'https://blog.example/cloud': 'This post is about cloud AI versus local AI and CUDA tooling. No Apple specifics.',
    'https://news.example/market': 'NVIDIA holds roughly 92% of the discrete GPU market in 2025.',
  };
  const claim: Claim = { claim_id: 'c1', claim: 'The Mac Studio M3 Ultra can be configured with up to 512GB unified memory.', claim_type: 'product_spec', time_sensitive: false, entities: ['Apple'], requires_verification: true };

  it('ranks the source that actually mentions the claim first', () => {
    const picked = pickRelevantSources(claim, sources, 2);
    expect(picked[0]).toBe('https://guide.example/hardware');
  });

  it('always keeps the cited URL even if low-scoring', () => {
    const picked = pickRelevantSources(claim, sources, 1, 'https://blog.example/cloud');
    expect(picked).toContain('https://blog.example/cloud');
  });

  it('returns [] when no source shares tokens with the claim', () => {
    expect(pickRelevantSources(claim, { 'https://x/y': 'completely unrelated content about gardening' }, 3)).toEqual([]);
  });
});

describe('entailmentPrompt does not truncate the source', () => {
  // Regression: the judge used to see only the first 3500 chars of each source, so a figure deep
  // in a page (e.g. a sector table ~4000 chars into a jobs release) was invisible and the real,
  // cited claim got stamped UNSUPPORTED. The whole cached source must reach the judge.
  it('includes a figure that sits past the old 3500-char cutoff', () => {
    const filler = 'x'.repeat(4000);
    const sourceText = `Summary at the top.\n${filler}\nLeisure and hospitality added 70,000 jobs in May 2026.`;
    const claim: Claim = { claim_id: 'c1', claim: 'Leisure and hospitality added 70,000 jobs in May 2026.', claim_type: 'financial', time_sensitive: true, entities: ['leisure and hospitality'], requires_verification: true, citation: 2 };
    const { user } = entailmentPrompt(claim, [{ url: 'https://bls.gov/x', text: sourceText }]);
    // The supporting sentence is at offset ~4020 — it must be in the prompt the judge sees.
    expect(user).toContain('Leisure and hospitality added 70,000 jobs');
  });
});

describe('parseVerdict', () => {
  const claim: Claim = { claim_id: 'claim-014', claim: 'RTX PRO 6000 does 100-120 tok/s on 70B Q4.', claim_type: 'benchmark', time_sensitive: true, entities: ['NVIDIA'], requires_verification: true };

  it('parses a partial verdict and carries the cited source', () => {
    const raw = JSON.stringify({
      verdict: 'PARTIALLY_VERIFIED',
      supported_elements: ['96GB memory'],
      unsupported_elements: ['100-120 tok/s on 70B Q4'],
      evidence_sentence: 'The RTX PRO 6000 includes 96GB of memory.',
      reason: 'Spec supported; throughput not.',
      recommended_action: 'qualify',
    });
    const v = parseVerdict(raw, claim, 'https://nvidia.com/x');
    expect(v.verdict).toBe('PARTIALLY_VERIFIED');
    expect(v.recommended_action).toBe('qualify');
    expect(v.unsupported_elements).toContain('100-120 tok/s on 70B Q4');
    expect(v.cited_source).toBe('https://nvidia.com/x');
    expect(needsCorrection(v)).toBe(true);
  });

  it('falls back to AMBIGUOUS + default action on garbage', () => {
    const v = parseVerdict('the model rambled', claim);
    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.recommended_action).toBe(verdictToAction('AMBIGUOUS'));
  });

  it('a VERIFIED+keep claim does not need correction', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'VERIFIED', recommended_action: 'keep', reason: 'ok' }), claim);
    expect(needsCorrection(v)).toBe(false);
  });
});

describe('buildPatchSet', () => {
  it('includes only claims needing correction, hedging never deleting', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
      { claim_id: 'b', claim: 'B', verdict: 'UNSUPPORTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify', cited_source: 'https://blog.example/x' },
      { claim_id: 'c', claim: 'C', verdict: 'VENDOR_CLAIM', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'attribute' },
    ];
    const patch = buildPatchSet(results);
    expect(Object.keys(patch)).toEqual(['b', 'c']); // 'a' (kept) excluded
    expect(patch.b.verdict).toBe('UNSUPPORTED');
    expect(patch.b.instruction).toMatch(/hedge|do not delete/i);
    expect(patch.c.instruction).toMatch(/according to/i);
  });

  it('coerces a judge-returned remove action into a hedge (never deletes)', () => {
    const claim: Claim = { claim_id: 'x', claim: 'Some unsupported claim', claim_type: 'financial', time_sensitive: true, entities: [], requires_verification: true };
    const v = parseVerdict(JSON.stringify({ verdict: 'UNSUPPORTED', recommended_action: 'remove' }), claim);
    expect(v.recommended_action).toBe('qualify');
  });
});

describe('locateClaimSentence', () => {
  const report = [
    '# AI Chip Market Report',
    '',
    'The market grew substantially in 2025. NVIDIA acquired Groq for $20 billion in March 2025 [3]. Analysts expect consolidation to continue.',
    '',
    '{{chart:market-share}}',
    '',
    '## Sources',
    '1. NVIDIA acquired Groq for $20 billion — example.com',
  ].join('\n');

  it('locates the sentence carrying a claim by token overlap', () => {
    const loc = locateClaimSentence(report, 'NVIDIA acquired Groq for $20 billion in March 2025');
    expect(loc).not.toBeNull();
    expect(loc!.sentence).toContain('NVIDIA acquired Groq');
    expect(report.slice(loc!.start, loc!.end)).toBe(loc!.sentence);
  });

  it('never matches inside the Sources section', () => {
    const loc = locateClaimSentence(report, 'NVIDIA acquired Groq for $20 billion in March 2025');
    expect(loc!.start).toBeLessThan(report.indexOf('## Sources'));
  });

  it('returns null when no sentence matches well enough', () => {
    expect(locateClaimSentence(report, 'Apple released a quantum laptop in Antarctica')).toBeNull();
  });

  // Regression fixtures from the Aug 1 report: decimal points in version
  // numbers ("Gemini 3.5") were treated as sentence boundaries, splicing
  // corrections MID-NAME ("Gemini 3.According to anthropic.com, 5 Flash Lite")
  // and duplicating tails ("93.5% LiveCodeBench score.5% LiveCodeBench score").
  it('does not split sentences at decimal points in version numbers', () => {
    const md = 'Google shipped Gemini 3.6 Flash and Gemini 3.5 Flash Lite on July 21 [12]. Anthropic released Claude Opus 4.8 on July 24 [13].';
    const loc = locateClaimSentence(md, 'Google shipped Gemini 3.5 Flash Lite on July 21');
    expect(loc).not.toBeNull();
    expect(loc!.sentence).toContain('Gemini 3.6 Flash and Gemini 3.5 Flash Lite');
    expect(loc!.sentence).not.toContain('Claude Opus');
  });

  it('does not split sentences at decimal points in percentages', () => {
    const md = 'DeepSeek V4 Pro leads the composite with a score of 87 and a 93.5% LiveCodeBench score [1][2]. Qwen3.6 27B claims 84% MMLU [1].';
    const loc = locateClaimSentence(md, 'DeepSeek V4 Pro leads the composite with a 93.5% LiveCodeBench score');
    expect(loc).not.toBeNull();
    expect(loc!.sentence).toContain('93.5% LiveCodeBench score [1][2]');
    expect(loc!.sentence).not.toContain('MMLU');
    // Splice must not duplicate a decimal tail
    const patched = md.slice(0, loc!.start) + 'REWRITTEN.' + md.slice(loc!.end);
    expect(patched).not.toContain('.5% LiveCodeBench score.5%');
  });

  it('splicing a rewritten sentence preserves the rest of the report', () => {
    const loc = locateClaimSentence(report, 'NVIDIA acquired Groq for $20 billion in March 2025')!;
    const rewritten = 'According to secondary reporting, NVIDIA licensed Groq IP in a deal announced in March 2025 [3].';
    const patched = report.slice(0, loc.start) + rewritten + report.slice(loc.end);
    expect(patched).toContain('The market grew substantially in 2025.');
    expect(patched).toContain('Analysts expect consolidation to continue.');
    expect(patched).toContain('{{chart:market-share}}');
    expect(patched).toContain(rewritten);
    expect(patched).not.toContain('NVIDIA acquired Groq for $20 billion in March 2025 [3]');
  });
});

describe('stripStrikethrough', () => {
  it('removes the struck old text, keeping the replacement', () => {
    const out = stripStrikethrough('NVIDIA ~~acquired Groq for $20B~~ licensed Groq IP.');
    expect(out).not.toContain('~~');
    expect(out).not.toContain('acquired');
    expect(out).toContain('licensed Groq IP.');
  });

  it('drops <del> spans and stray unbalanced markers', () => {
    expect(stripStrikethrough('keep <del>cut this</del> end')).toBe('keep end');
    expect(stripStrikethrough('a ~~ b')).toBe('a b'); // lone marker removed
  });

  it('leaves clean prose untouched', () => {
    const clean = 'A normal sentence with no edits.';
    expect(stripStrikethrough(clean)).toBe(clean);
  });
});

describe('verificationSection', () => {
  it('shows an all-clear message when nothing needs correction', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
    ];
    const md = verificationSection(results);
    expect(md).toContain('## Verification');
    expect(md).toMatch(/1 checkable claims were verified/);
  });

  it('lists hedged/attributed claims', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'Overstated throughput claim', verdict: 'PARTIALLY_VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' },
    ];
    const md = verificationSection(results);
    expect(md).toContain('PARTIALLY_VERIFIED');
    expect(md).toMatch(/hedged, or attributed/);
  });

  it('returns empty string when no claims were checked', () => {
    expect(verificationSection([])).toBe('');
  });
});

describe('July 31 publishing artifacts (URL-in-sentence splices)', () => {
  it('locateClaimSentence does not split sentences at dots inside URLs', () => {
    const md = 'Hardware crossed thresholds this week. According to https://docs.octomil.com/blog/on-device-llm-inference-2025-2026, Snapdragon delivers 100 TOPS and 220 tok/s decode [3]. More text follows.';
    const loc = locateClaimSentence(md, 'Snapdragon delivers 100 TOPS NPU and 220 tok/s decode');
    expect(loc).not.toBeNull();
    // The WHOLE sentence including the full URL — not a fragment ending at ".octomil."
    expect(loc!.sentence).toContain('2025-2026');
    expect(loc!.sentence).toContain('220 tok/s');
    expect(md.slice(loc!.start, loc!.end)).toBe(loc!.sentence);
  });

  it('attribute instructions cite by marker/hostname, never a raw URL', () => {
    const sources = ['https://a.example/one', 'https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/'];
    const results: VerificationResult[] = [
      { claim_id: 'v', claim: 'V', verdict: 'VENDOR_CLAIM', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'attribute', cited_source: sources[1] },
    ];
    const patch = buildPatchSet(results, sources);
    expect(patch.v.instruction).toContain('docs.octomil.com [2]');
    expect(patch.v.instruction).not.toContain('https://');
  });

  it('guardRewrite rejects the artifact classes and passes clean rewrites', () => {
    const original = 'Snapdragon 8 Elite Gen 5 delivers 100 TOPS with 220 tok/s decode [3].';
    // Raw URL introduced
    expect(guardRewrite('According to https://docs.octomil.com/blog/x, Snapdragon delivers 220 tok/s [3].', original)).toBeNull();
    // Stacked hedge (the doubled "According to")
    expect(guardRewrite('According to docs.octomil.According to benchmarks, Snapdragon delivers 220 tok/s [3].', original)).toBeNull();
    // Orphaned bold marker
    expect(guardRewrite('Dimensity adds native BitNet 1.58-bit processing**, claiming lower power [3].', original)).toBeNull();
    // Clean attribution passes
    expect(guardRewrite('According to docs.octomil.com [6], Snapdragon delivers 220 tok/s decode [3].', original))
      .toContain('According to docs.octomil.com [6]');
  });
});

import { escalationPriority } from '../../src/pipeline/verification.js';

describe('model-nominated external checks (absence claims)', () => {
  const phantom: Claim = { claim_id: 'e1', claim: 'Meta Muse Glimmer was never released and no weights exist.', claim_type: 'existence', time_sensitive: true, entities: ['Meta', 'Muse Glimmer'], requires_verification: true, external_check: true };
  const nominated: Claim = { claim_id: 'e2', claim: 'The RTX 5090 has 32GB VRAM.', claim_type: 'product_spec', time_sensitive: false, entities: ['NVIDIA'], requires_verification: true, external_check: true, external_reason: 'single source' };
  const routine: Claim = { claim_id: 'e3', claim: 'The RTX 5090 has 32GB VRAM.', claim_type: 'product_spec', time_sensitive: false, entities: ['NVIDIA'], requires_verification: true };
  const heuristic: Claim = { claim_id: 'e4', claim: 'NVIDIA acquired Groq in 2024.', claim_type: 'corporate_event', time_sensitive: true, entities: ['NVIDIA', 'Groq'], requires_verification: true };

  it('escalates existence claims and model-nominated claims; routine specs stay heuristic-gated', () => {
    expect(shouldEscalate(phantom)).toBe(true);
    expect(shouldEscalate(nominated)).toBe(true);   // model nomination overrides the type heuristic
    expect(shouldEscalate(routine)).toBe(false);    // not nominated, not an escalate type
  });

  it('orders the capped budget: existence first, then nominated, then heuristic', () => {
    expect(escalationPriority(phantom)).toBeLessThan(escalationPriority(nominated));
    expect(escalationPriority(nominated)).toBeLessThan(escalationPriority(heuristic));
  });

  it('parseClaims auto-flags existence claims for external check', () => {
    const raw = JSON.stringify([{ claim: 'Muse Glimmer does not exist as a released model.', claim_type: 'existence', entities: ['Meta'] }]);
    const [c] = parseClaims(raw, 5);
    expect(c.claim_type).toBe('existence');
    expect(c.external_check).toBe(true);
  });

  it('tier1Query drops absence-framing words so the search finds the thing, not the doubt', () => {
    const q = tier1Query(phantom);
    expect(q).toContain('muse');
    expect(q).not.toContain('phantom');
    expect(q).not.toContain('exist');
  });

  it('applyTier1 CONTRADICTED on an absence claim escalates to correction', () => {
    const v: VerificationResult = { claim_id: 'e1', claim: phantom.claim, verdict: 'UNSUPPORTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' };
    const out = applyTier1(v, { status: 'CONTRADICTED', source_url: 'https://ai.meta.com/blog/muse-glimmer', evidence: 'Today we are releasing Muse Glimmer.' });
    expect(out.verdict).toBe('CONTRADICTED');
    expect(out.recommended_action).toBe('correct');
  });
});

describe('locateClaimSentence compound tokens (llama.cpp class)', () => {
  it('never splits at a dot inside a compound token', () => {
    const md = 'The local stack matured this week. The llama.cpp and Z.ai releases shipped with vLLM support for all platforms. Downloads rose sharply.';
    const hit = locateClaimSentence(md, 'llama.cpp and Z.ai releases shipped with vLLM support');
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain('llama.cpp');
    expect(hit!.sentence).toContain('Z.ai');
    // the located sentence must be the FULL sentence, not a fragment cut at "llama."
    expect(hit!.sentence.trim().startsWith('The llama.cpp')).toBe(true);
    expect(hit!.sentence).toContain('all platforms.');
  });
});
