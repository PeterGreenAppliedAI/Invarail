# Building a Production Memory System for Local AI Agents with FalkorDB

*How Invarail gives local models long-term memory using a graph database, vector search, and deterministic pipelines — all running on personal hardware with zero cloud dependencies.*

---

## The Problem with AI Memory

Most AI agent frameworks treat memory as an afterthought — a vector store you throw embeddings into and hope the right things come back. This falls apart fast:

- **Flat vector stores can't model relationships.** "Peter works at DevMesh" and "DevMesh is building an outreach platform" are two separate embeddings. A vector store can find each individually but can't traverse from Peter → DevMesh → outreach platform.
- **No temporal evolution.** When a user changes jobs, vector stores accumulate contradictory facts. "ML engineer at Company A" and "Senior engineer at Company B" coexist with no signal about which is current.
- **Retrieval is single-hop.** You search for "Peter's job" and get the job fact. But you don't get the related project facts, the technology preferences that informed career decisions, or the meeting notes that led to the change.
- **Dedup is an afterthought.** After a few weeks of conversations, you have 14 near-duplicate facts about the same topic — slightly different phrasings from different sessions.

We needed something better. After 4 phases of iteration on a flat JSONL fact store, we moved to FalkorDB — a GraphBLAS-based graph database with native HNSW vector search, running in a Docker container alongside the agent.

---

## At a Glance

A **FalkorDB graph database** (Docker, native HNSW vector search) is the institutional memory; a flat JSONL store is the fallback.

```
(:Fact {text, importance, embedding}) -[:ABOUT]->          (:Entity {name, type})
(:Fact) -[:TAGGED]->    (:Tag)
(:Fact) -[:SUPERSEDES]-> (:Fact)            // evolving truth, history preserved
(:Fact) -[:EXTRACTED_FROM]-> (:Turn)        // provenance to the conversation
(:Turn) -[:MENTIONS]->  (:Entity)           // cross-session search
(:UserModel {communicationStyle, decisionPattern, topicInterests, frustrationTriggers})   // closed schema
```

- **Importance tiers** — 5=critical (never expires) … 1=ephemeral (7 days). Eviction drops lowest importance first; identity facts are never silently trimmed.
- **Auto-injection with a floor** — vector KNN + multi-hop entity traversal on every message, but contextual injection requires raw cosine ≥ 0.52 (launched at 0.55, tuned on the real corpus): scoring orders, the floor rejects. Relevance is earned, not assumed. (Up to five identity-tier facts still ride along on every turn — see Auto-Injection.)
- **Semantic dedup on write**, typed-entity NER bootstrapped from the graph's own prior decisions, `SUPERSEDES` edges instead of overwrites, behavioral user modeling refreshed by heartbeat.
- **Facts carry HOW we know them** — `provenance: stated | observed | inferred`. Only `!save` (a human read the list) may claim `stated`; autonomous extraction is `observed`; consolidation merges are `inferred`. Injection marks the weak classes — but only when the set is mixed, so a distinction that distinguishes nothing never turns into a blanket hedging order.
- **Intake runs continuously** — incremental capture every 8 turns (code-triggered, after the reply is delivered, on the utility tier) closed a two-hour hole that had left the graph at 24 facts after months. `!reset` shows the session's captures alongside any tail facts; `!save` promotes them; the 2-hourly heartbeat keeps the heavy reconciliation (consolidation, contradictions, review). `!forget` removes with re-extraction protection.
- **Identity is a rule, not an observation** — `USER.md` is the owner's hand-written profile, read-only to the agent and fed to extraction as authoritative; it never grows a weaker-provenance copy of itself in the graph.
- **Priming embeds your words, not your attachments** — page and PDF bodies are stripped from the retrieval query and it is capped, after a 9K-char document blew the 8s priming cap on the Mini.
- **Experience & Lessons** — approach-level memory judged only by code-detected signals (👍/👎 reactions, confirm denials, steering — never model self-assessment). Lessons (negative procedural memory) inject only after recurrence (evidence ≥ 2). Both are dense lookups: skipped on voice turns and inert on a no-embedder tier. The retired skills system is the cautionary tale: replayed recipes quietly became an authority surface, so its successors keep the learning, not the power.

---

## Memory Tiers: the Same Memory on a Machine That Is Not This One

Everything below describes the reference setup: FalkorDB beside the process and an
8B embedding model resident on a GPU. That is one of **four tiers** a config can name
(`memory.backend`, `src/memory/policy.ts`), because an 8GB card cannot hold a 10.9GB
embedder beside its chat model and most people do not run a graph database at home:

| Tier | `memory.backend` | Needs | Facts | Knowledge | Retrieval |
|---|---|---|---|---|---|
| **graph** | `graph` | FalkorDB + an embedding model | graph nodes + JSONL | vault, hybrid | vector KNN + entity hops + FTS5 |
| **flat** | `flat` | nothing | JSONL | workspace files | keyword (identity facts + 3 query-relevant) |
| **vault** | `vault` | a markdown folder — your Obsidian vault | JSONL | the vault, lexical (FTS5) | exact words and names; `docs_search` |
| **vault + OKF** | `vault` + `vault.okf: true` | the same folder | JSONL **mirrored as OKF concept notes** under `memory/` | the vault as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle | the model reads `index.md` and opens the one file it needs (`docs_read`) |

`markdown` (the historical default) means *graph if FalkorDB answers, else flat*, so an
existing config changes nothing. `memory.embeddingModel: "none"` turns every embedding
call off; the graph then cannot run (the doctor FAILs a `graph` config without one), the
vault indexes lexically, fact dedup falls back to hash + substring, and `knowledge_import`
is not registered. The wizard asks one question ("How should Invarail remember?") with the
detected default, and `npm run doctor` checks the tier's requirements: FalkorDB reachable
for `graph`, the embedder fitting *beside* the foreground model, the vault folder present,
and OKF conformance.

**The dense extras honour the tier too (2026-09-28).** Lessons and experiences are vector
lookups beside the facts. Under `embeddingModel: "none"` both are now inert: priming skips
them (`embeddingsEnabled` in dispatch.ts), the heartbeat skips experience synthesis, the
experience store's `ensure()` refuses to connect, and `generateEmbedding` returns an empty
vector without a call when handed `"none"`. Before that fix the lesson path embedded on the
hardcoded fallback model (a 45s timeout on every turn) and the experience path asked the
server for a model literally named `none` (a 404 per turn) — found in the 2026-09-28 e2e log.
`memory.embeddingModel` now threads through the lesson path wherever config is in scope.

**OKF, what we use of it (v0.2):** every note carries YAML front matter with a `type`;
`index.md` per folder is a bulleted list of links with one-line descriptions, regenerated
by the heartbeat — the progressive-disclosure map a small model reads *instead of* the
files; `log.md` is the newest-first history. A fact becomes a concept note under `memory/` whose front
matter is our provenance model: every mirrored fact carries `generated: {by: invarail/<source>, at}`,
a **stated** fact additionally carries `verified: [{by: human:<owner>}]`, `inferred` is
`status: draft` (everything else `stable`), and the importance TTL is `stale_after`. Consumers must tolerate missing
fields, unknown types and broken links (§11), which is why an Obsidian vault that was never
OKF can be pointed at as-is: nested folders are indexed, every existing note is listed in the
generated indexes as it is, nothing is moved or cleared, and an `index.md` or `log.md` you
wrote yourself is never overwritten. To bring the notes themselves onto the format —
`type`, title, a one-line description read off the first paragraph, bodies untouched —
`npm run vault:okf` reports and `npm run vault:okf -- --apply` writes; the wizard offers the
same, default no. `src/knowledge/okf.ts`; conformance in the doctor.

## Architecture: Dual-Backend with Write-Through

Invarail's memory has two backends:

```
                    ┌─────────────────────────┐
                    │    Memory Write Path     │
                    │                          │
                    │  !save / heartbeat /     │
                    │  memory_save / capture   │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │    Write-Through Layer    │
                    │   (both stores in sync)   │
                    └──────┬──────────┬────────┘
                           │          │
              ┌────────────▼──┐  ┌───▼─────────────┐
              │   FalkorDB    │  │   Flat FactStore │
              │   (primary)   │  │   (fallback)     │
              │               │  │                  │
              │ • Graph nodes │  │ • JSONL index    │
              │ • HNSW vectors│  │ • facts.json     │
              │ • Entity links│  │ • Importance TTL  │
              │ • SUPERSEDES  │  │ • Hash dedup     │
              └───────────────┘  └──────────────────┘
```

Every fact write goes to both stores. Graph failures are non-blocking — the flat store always succeeds. This gives us the graph's power for search and reasoning while maintaining a reliable fallback that's just files on disk.

---

## The Graph Schema

FalkorDB uses the Redis wire protocol and runs in under 100MB of memory at our current scale (snapshot 2026-09-26: 36 facts, 68 entities, 501 conversation turns, 193 tags, 2 experiences, 1 user model; by 2026-09-28, with incremental capture running, 69 facts — 51 observed, 18 stated. Decay and consolidation keep the fact count deliberately small). The schema:

```
(:Fact {id, text, senderId, importance, embedding, category, confidence, createdAt, source, provenance, superseded})
  -[:ABOUT]->        (:Entity {name, canonical, type, senderId})
  -[:TAGGED]->       (:Tag {name})
  -[:SUPERSEDES]->   (:Fact)              // temporal fact evolution
  -[:EXTRACTED_FROM]->(:Turn)             // provenance

(:Turn {id, text, role, senderId, sessionKey, createdAt})
  -[:MENTIONS]->     (:Entity)            // conversation links

(:UserModel {senderId, communicationStyle, decisionPattern, topicInterests, frustrationTriggers})   // closed schema

(:Experience {text, taskShape, approach, outcome, evidenceCount, model, verified, embedding})   // approach memory, own vector index
```

Experiences live in the same graph (`memory.falkordb.graphName`, default `invarail_memory`) and the same vector space as facts — the experience store's `embeddingModel` must match the fact store's — so provenance edges never have to cross graphs.

The key relationships:

- **ABOUT** connects facts to entities they reference. This enables multi-hop traversal — find all facts connected to a person, then find all entities connected to those facts.
- **SUPERSEDES** tracks fact evolution. When a user changes jobs, the new fact SUPERSEDES the old one. Detection happens on write: neighbours in the band just outside the dedup threshold (cosine distance 0.15–0.4) are put to the NER model as a one-word YES/NO "does B contradict, update, or replace A?". Both persist with timestamps, enabling temporal queries ("what did I know last month?").
- **EXTRACTED_FROM** traces provenance. Every fact links back to the conversation turn it came from.
- **MENTIONS** links conversation turns to entities, enabling cross-session search ("find all conversations where we discussed FalkorDB").

### Vector Index

```sql
CREATE VECTOR INDEX FOR (f:Fact) ON (f.embedding)
OPTIONS {dimension: 4096, similarityFunction: 'cosine'}
```

4096-dimensional vectors from `qwen3-embedding:8b` in the reference setup — the model is `memory.embeddingModel` and the width `memory.embeddingDims`, which must match it or the index is built wrong — indexed with HNSW for O(log n) nearest-neighbor search. This runs inside FalkorDB — no separate vector database.

---

## Entity Extraction: The Self-Improving Loop

This is where it gets interesting. When a fact is stored, we extract named entities and link them to the graph. But entity extraction by a small local model (phi4-mini, `memory.nerModel`) is unreliable — without context, it classifies "DGX Spark" as software instead of hardware, or creates duplicate nodes for "open-source models" vs "open-source model."

We solved this with **bootstrapped NER** — the graph teaches the model how to classify.

### How It Works

Before extracting entities from a new fact, we query the graph for existing typed entities:

```cypher
MATCH (e:Entity {senderId: $senderId})
WHERE e.type <> 'unknown'
RETURN e.name, e.type
ORDER BY e.createdAt DESC LIMIT 30
```

These are grouped by type and injected into the NER prompt:

```
Extract named entities from this text. Return a JSON array of objects.
Types: person, organization, technology, hardware, software, place, event, concept.

Known entities (classify consistently with these):
- "Peter Green", "Alex" → person
- "DevMesh", "Anthropic" → organization
- "DGX Spark", "Mac Mini", "A5000" → hardware
- "FalkorDB", "Ollama", "Invarail" → software
```

Now when phi4-mini sees "DGX Spark" in a new fact, it has graph context showing this is hardware — and classifies correctly. Each correctly typed entity becomes reference context for future extractions. The graph gets smarter over time.

### Canonical Normalization

Entity dedup uses canonical form computation:

```typescript
function normalizeEntityName(name: string): string {
  let n = name.trim().toLowerCase();
  n = n.replace(/[\s\-_]+/g, ' ').trim();
  // Simple plural stripping (skip 'ss', 'us' suffixes)
  if (n.endsWith('s') && n.length > 3 && !n.endsWith('ss') && !n.endsWith('us')) {
    n = n.slice(0, -1);
  }
  return n;
}
```

MERGE operates on `canonical`, so "Open-Source Models" and "open-source model" resolve to the same node. The original display name is preserved separately. Entity type upgrades from `unknown` to a real type on subsequent encounters:

```cypher
MERGE (e:Entity {canonical: $canonical, senderId: $senderId})
ON CREATE SET e.name = $name, e.type = $type, e.createdAt = $now
ON MATCH SET e.type = CASE WHEN e.type = 'unknown' THEN $type ELSE e.type END
```

---

## Fact Extraction: Four Paths, One Provenance Field

Facts enter the system through four paths, each with a different trust level — and since 2026-09-20 that trust level is a property on the fact, not folklore. `provenance` is `stated | observed | inferred`: **stated** = the owner asserted or explicitly confirmed it; **observed** = extracted autonomously from what was said, never confirmed; **inferred** = a model derived it (consolidation merges — a merge is model-authored prose even when both inputs were stated, so merging never launders provenance upward). It is orthogonal to `source`, which is a free-text WHERE (`session/foo.json`, `capture/<session>`). Nodes written before the field existed coalesce **down** to `observed`; an unknown-origin fact must never be presented as something the owner confirmed. Search accepts a `provenance` filter.

### Path 1: User-Approved (`!reset` → `!save`) — the only path to `stated`

When the user clears a session with `!reset`, the extraction model (`memory.extractionModel`, phi4:latest on the utility box) analyzes **only the turns incremental capture has not already read** (see Path 4) and proposes facts; the reply also lists everything capture stored during the session, marked unconfirmed. `!save` writes the new facts as `stated` and **promotes** the session's captures `observed → stated` (graph by id, flat store by text — the two stores mint different ids). This is the highest-trust path and the only way a captured fact ever becomes `stated`. `!discard` leaves captures as they are.

Why the tail only: an 80-turn `!reset` used to hand phi4 the whole 30K-char transcript with no `num_ctx`; Ollama's 4096 default overflowed and truncated from the FRONT, the extraction instructions vanished, and the model continued the chat in the assistant's voice ("No JSON array found", 2026-09-20). The transcript is now bounded to `memory.extractionContextSize` (oldest turns dropped, loudly) as a belt on top of the tail.

The extraction prompt includes:

- **Category definitions** with examples (stable, context, decision, question)
- **Importance tier reference** (5=critical health/family, 4=identity job/projects, 3=preference, 2=context, 1=ephemeral)
- **Already-stored facts** — prevents re-extracting what we already know
- **Recently-removed facts** — prevents re-extracting what the user deleted
- **The owner profile (`USER.md`) as an authoritative block** — identity is a rule, not an observation. The file is read-only to the agent (it was writable via `workspace_write`, which put a family member's name one bad model turn from erasure; `workspace_write` now refuses it and points at `memory_save`) and anything already in it must never become a weaker-provenance graph fact.
- **Do NOT infer** — record what was stated, not what it implies. The first live capture turned "my goal is to make me redundant" into "one-time setup rather than recurring revenue"; the user's next message said the opposite (retainer). Provenance labels the path a fact took, not whether its content is a quote or an extrapolation — that line is held in the prompt.
- **Absolute dates only** — "yesterday"/"next Thursday" are meaningless when a fact is read weeks later; the model must convert to the actual date (relative dates were a real staleness bug class for TTL'd facts)

The model outputs structured JSON:

```json
[
  {
    "text": "Peter switched from qwen3.5 to gemma4:26b for chat",
    "cat": "decision",
    "conf": 0.9,
    "imp": 4,
    "tags": ["model-selection", "architecture"],
    "entities": ["gemma4", "qwen3.5"]
  }
]
```

### Path 2: Autonomous Heartbeat

Every 2 hours, the heartbeat reviews transcripts modified since the last review. Same extraction logic, but writes directly without user approval. The guard rails:

- Existing facts shown to prevent paraphrased re-extraction
- Recently-removed facts shown to prevent re-extracting deleted content
- Each fact gets a 30-day TTL in `removed.jsonl` after deletion

**Deletion is never autonomous (July 2026):** the heartbeat's LLM reasoning pass used to prefix-match-DELETE facts it judged stale — model-judged, destructive, un-itemized in the report. Stale facts are now PROPOSED into the pending `!heartbeat yes/no` review file with their positions, itemized in the heartbeat report under "Possibly outdated," and only removed when the user says so. Writes can be autonomous; deletions are propose-and-confirm.

### Path 3: Explicit Save (memory_save tool)

The user or a specialist explicitly calls `memory_save` with content. Maps category to importance tier (stable→4, context→2, decision→3, question→1) and writes through both backends. Lands as `observed` — the model decided it was worth saving; nobody confirmed it.

### Path 4: Incremental Capture (every N turns)

Before 2026-09-20, Paths 1 and 2 were the only intake, so anything said between heartbeats lived only in the context window and was lost if the session was never reset — the measured symptom was a graph of **24 facts after months** (the process had been off for a month, and the two-hour cadence had never been enough). `MemoryCapture` (`src/services/memory-capture.ts`) now runs the same extraction on the unprocessed window every `memory.capture.everyTurns` turns (default 8, with 2 turns of overlap so a fact stated across the boundary is not split in half).

Three properties are load-bearing: **the trigger is code** (a model deciding "did the topic shift?" would put a model call on the hot path to decide whether to spend another model call); **it runs after delivery**, fire-and-forget on the utility tier with a hard timeout, so nothing new goes in front of a reply; and **it cannot claim `stated`**. The marker advances even on an empty extraction (otherwise the same window re-sends forever) and rewinds on `!reset`. The heartbeat still owns reconciliation. `memory.capture.enabled: false` is the one-line off switch.

### Write-Through to Both Stores

Every path uses the same write-through (capture and `!reset` pass the session key so the graph can draw `EXTRACTED_FROM`):

```typescript
// 1. Flat FactStore (always succeeds — it's just files)
if (factStore) {
  await factStore.writeFactsBatch(facts, senderId, source);
  factStore.rebuildFacts(senderId);
}

// 2. GraphMemory (non-blocking on failure)
if (graphMemory) {
  for (const fact of facts) {
    try {
      await graphMemory.addFact(fact, senderId, sessionKey);
    } catch (err) {
      console.warn('[Memory] Graph write failed:', err.message);
    }
  }
}
```

---

## Deduplication: Triple-Check on Write

Before storing a fact, three dedup checks run in order:

### 1. Semantic Dedup (Graph)

Vector KNN with cosine distance threshold:

```cypher
CALL db.idx.vector.queryNodes('Fact', 'embedding', 1, vecf32($emb))
YIELD node, score
WHERE node.senderId = $senderId AND score < 0.15
```

A cosine distance below 0.15 (similarity above 0.85) means the fact is a near-duplicate. Rejected.

### 2. Hash Exact Match (Flat Store)

SHA256 of normalized text (lowercase, stripped punctuation, collapsed whitespace):

```typescript
const hash = sha256(normalized).slice(0, 16);
if (existingHashes.has(hash)) return null;
```

Catches exact rephrasing with different punctuation or capitalization.

### 3. Substring Inclusion (Flat Store)

If the normalized text of one fact contains the normalized text of another:

```typescript
if (existingNorm.includes(newNorm) || newNorm.includes(existingNorm)) return null;
```

Catches "Peter uses FalkorDB" vs "Peter uses FalkorDB for memory."

### LLM-Driven Consolidation (Heartbeat)

During heartbeat, an LLM reviews pairs of facts with high word overlap (≥50%) and decides:

- **MERGE** — Combine both into one more complete fact
- **REPLACE** — New supersedes old
- **KEEP_SEPARATE** — Distinct facts, both stay

Bounded to 20 pairs per run to limit compute. The heartbeat runs it through the `memory_cleanup` tool (`src/tools/memory-cleanup.ts` → `src/memory/consolidation.ts`) on the model named by `memory.consolidation.model` (utility tier) at temperature 0.1; a merged fact lands as `inferred` — merging never launders provenance upward.

---

## Search: Multi-Signal Scoring

When a message comes in, the memory system retrieves relevant facts using a multi-signal scoring formula:

```
multiScore = similarity × 0.5 + recency × 0.2 + importance × 0.3
```

Where:

- **Similarity** (50%) — Cosine similarity from HNSW vector search. Range 0-1.
- **Recency** (20%) — Exponential decay with a 7-day time constant (half-life ≈ 4.9 days): `exp(-ageMs / (7 × 24 × 60 × 60 × 1000))`. Yesterday's facts score ~0.87, last week's score ~0.37, last month's score ~0.01.
- **Importance** (30%) — Normalized tier: `(importance - 1) / 4`. Critical facts (tier 5) score 1.0, ephemeral facts (tier 1) score 0.0.

This means a moderately relevant but critical fact (similarity 0.6, importance 5) scores higher than a highly relevant but ephemeral fact (similarity 0.9, importance 1):

```
Critical:   0.6 × 0.5 + 0.5 × 0.2 + 1.0 × 0.3 = 0.70
Ephemeral:  0.9 × 0.5 + 0.5 × 0.2 + 0.0 × 0.3 = 0.55
```

A family member's health condition surfaces above yesterday's weather, even if the weather was discussed more recently.

**The relevance floor (July 2026):** multi-signal scoring only ORDERS results — it never rejected any. A fresh critical fact scored 0.50 with ZERO similarity to the query, so identity facts injected on every turn regardless of topic (a topic-drift trap for small models: ask about Docker, get family facts as "context"). Contextual injection now requires raw cosine similarity above a floor (`minSimilarity` filter in `graph-store.search`) before scoring even applies. The floor shipped at 0.55 and was tuned to **0.52** on real corpus data (`scripts/memory-floor-check.ts`: noise clusters ≤ 0.49, genuine signal starts ~0.546 on qwen3-embedding) — `MIN_SIMILARITY` in `buildUserPriming`, dispatch.ts. An irrelevant query injects no contextual or multi-hop facts; the identity layer (below) is deliberately not floor-gated. Floors are per-corpus and per-embedder: re-measure on a model change, never borrow one.

---

## Auto-Injection: Silent Context Enhancement

Every message triggers memory injection before the specialist sees it (`buildUserPriming`, dispatch.ts). Four fact/user layers on the graph tier, plus lessons and experiences:

### Layer 1: Stable Facts (Identity)

High-importance facts (tier ≥ 4) — job, family, projects, critical health info. Always injected regardless of query relevance. Limited to 5 facts.

On the flat and vault tiers (no graph) the same slot is filled from `facts.json`: up to 5 facts with importance ≥ 4 and confidence ≥ 0.7, plus up to 3 keyword-relevant facts for this message (confidence ≥ 0.6) in place of the KNN layer — the flat tier was identity-only before 2026-09-27.

### Layer 2: Contextual Facts (Query-Relevant)

Vector search on the current message finds relevant facts by multi-signal score, subject to the 0.52 similarity floor, capped at 3 (July 2026 — was 5 uncapped). Deduplicated against stable facts.

### Layer 3: Multi-Hop Connected Facts

Starting from vector search results, traverse entity connections to find related facts the vector search missed. Only fires when at least one result passed the similarity floor but results are sparse (<3) — previously it fired exactly when the query was LEAST memory-relevant (zero vector hits), adding tangential facts when they'd be most distracting:

```cypher
-- 1-hop: fact → entity → related fact
MATCH (seed:Fact)-[:ABOUT]->(:Entity)<-[:ABOUT]-(related:Fact)

-- 2-hop: fact → entity → fact → entity → further fact
MATCH (seed)-[:ABOUT]->(:Entity)<-[:ABOUT]-(mid)-[:ABOUT]->(:Entity)<-[:ABOUT]-(far)
```

Seeded from the single nearest fact; scored by distance: 1-hop facts get score 1.0, 2-hop facts get 0.5. Hop facts only fill whatever is left of the 3-fact contextual cap.

### Layer 4: Behavioral User Model

LLM-derived observations about communication style, decision patterns, topic interests, frustration triggers — updated each heartbeat by analyzing recent interactions. **The schema is closed** (`USER_MODEL_FIELDS`, graph-store.ts): the writer drops any other key the model returns and the renderer reads only the four. Before that gate (2026-09-26) the node had drifted to 41 keys — `actionPattern`, `emotionalProfile`, `topicInterworks`… — and rendered to 9K chars, injected on every turn, every category; it was the single largest thing in a voice prompt.

### Lessons and Experiences

Two advisory blocks follow the facts when they match: **lessons** (floor-gated one-liners from failures that have recurred, evidence ≥ 2) and **experiences** (approach notes judged by real user signals, top 2 above 0.6 similarity, evidence ≥ 2). Both are plain prompt text — never routing, permissions or confirm decisions. Both are skipped on voice turns (bare chat, no tools, and each is another embed on the priming path) and whenever `embeddingModel` is `"none"`; each is individually switchable (`memory.lessons.enabled`, `memory.experiences.enabled`).

### Injection Format

The context is injected as a preamble before the specialist's system prompt:

```
## Background context about this user (do NOT reference unless directly relevant)
- Peter works at DevMesh as ML engineer
- Peter runs Invarail on DGX Spark + Mac Mini + A5000
- Peter prefers recipes with precise measurements

## User preferences (adapt your style accordingly)
- communication style: direct and technical, prefers concise answers
- decision pattern: data-driven, iterates through options
```

The header "do NOT reference unless directly relevant" is critical — without it, the model tries to work every fact into its response. The block also ends with a staleness caveat — "these facts reflect when they were written; verify a mentioned file/URL/plan still exists before relying on it" — because a fact is a point-in-time observation, not live state.

**Provenance marks (2026-09-20):** lines the owner never confirmed render as `… [observed, unconfirmed]` or `… [inferred]`, with one added sentence telling the model to ask rather than assert those back as fact — but **only when the injected set is mixed**. Every fact predating the field reads as `observed`, so unconditional marking would have hedged all of memory on day one, a straight downgrade of a system that already recalled things confidently. A distinction that distinguishes nothing is noise; the first `!save` turns marking on by itself.

**What gets embedded for retrieval:** the user's words, not the documents riding with them. The first live priming timeout was a turn with an attached PDF — 8,906 chars embedded for every priming lookup (facts, multi-hop, lessons, experiences) at the Mini's ~120 tok/s prefill, against an 8s cap. `primingQueryFrom` strips `[PAGE_CONTENT]` and attached-PDF bodies (headers stay — "attached a PDF: roadmap.pdf" is signal) and caps at 800 chars.

**Other tenants of the EmbeddingStore:** the SQLite vector store (`data/memory.db`, scoped by a `source` column) holds vault document chunks (`source='vault'`, dense + lexical FTS5 — lexical only without an embedder), `knowledge_import` chunks (`source='knowledge'`, searched by `memory_search source="knowledge"`), and lesson embeddings (`source='lesson'`, failure-boundary one-liners injected only at evidence ≥ 2). The skills system that used to live here (`source='skill'`) was retired 2026-08-10. Facts and experiences are not tenants — their vectors live in FalkorDB. One embedding model, several retrieval systems.

---

## Temporal Intelligence: Fact Evolution

The SUPERSEDES edge enables fact versioning:

```
(:Fact {text: "ML engineer"})
  <-[:SUPERSEDES {at: "2026-05-15"}]-
    (:Fact {text: "Senior ML engineer"})
```

Both facts persist. The old fact is marked `superseded: true` and excluded from active search. But temporal queries can traverse the chain:

```cypher
MATCH (current:Fact)-[:SUPERSEDES*0..10]->(old:Fact)
WHERE current.text CONTAINS $match
RETURN old.text, old.createdAt
```

This answers "what did I know about Peter's role last month?" by walking the SUPERSEDES chain backward.

### Snapshot-Based Diffing

The heartbeat uses deterministic fact diffing — no model involvement:

```typescript
saveSnapshot() → {timestamp, factHashes: string[], factCount}
diffFacts()    → {newFacts, unchangedFacts, removedHashes, snapshotAge}
```

Hash-based comparison between snapshots tells us exactly what changed since the last heartbeat. The model only reasons about the diff — "what do these changes mean?" — never about what changed.

---

## Importance Tiers and TTL

Every fact has an importance tier (1-5) that determines how long it lives:

| Tier | Meaning | TTL | Examples |
|------|---------|-----|----------|
| 5 | Critical | Never expires | A family member's health condition, family members |
| 4 | Identity | Never expires | Job title, major projects, certifications |
| 3 | Preference | 90 days | Tool choices, food preferences, communication style |
| 2 | Context | 30 days | Current tasks, upcoming events |
| 1 | Ephemeral | 7 days | One-off mentions, transient questions |

The extraction prompt teaches the model these tiers with few-shot examples:

```
Examples:
  User: "My <family member> has been dealing with <health issue>" → imp:5 (family + health)
  User: "I work at <Company> as an ML engineer" → imp:4 (identity)
  User: "I prefer dark mode in all my editors" → imp:3 (preference)
  User: "I have a meeting with the team tomorrow" → imp:2 (context)
  User: "Yeah I saw that article too" → imp:1 or skip entirely
```

(Placeholders here; the live prompt in `src/orchestrator.ts` uses concrete first-person sentences, with a definition line per tier above them.)

Without these examples, the model defaulted everything to importance 2 — the 30% importance weight in scoring was dead weight.

---

## Cross-Session Conversation Search

The Turn nodes enable searching across all past conversations:

```cypher
-- Find conversations mentioning an entity
MATCH (t:Turn {senderId: $senderId})-[:MENTIONS]->(e:Entity)
WHERE toLower(e.name) CONTAINS toLower($query)
RETURN t.text, t.role, t.sessionKey, t.createdAt
ORDER BY t.createdAt DESC LIMIT 20
```

This lets the agent say "we discussed FalkorDB in three sessions last week" with actual conversation references — not hallucinated memory.

### Entity Clusters and the Synthesis Pass (designed, not built)

`getClusters` groups facts that share entities; `filterDegenerateClusters` drops the owner's own names (`ownerNames(config)`, from `principals` — every fact is "about" the owner, so that hub is noise) and per-corpus stopword entities. A heartbeat **synthesis pass** — one "so what" note per coherent cluster — is designed in DECISIONS.md but **not built**. Its gate is `scripts/memory-cluster-check.ts`. It failed at 24 facts (2026-09-20: the owner hub, a corpus stopword, NER pairings). Re-run on 2026-09-28 against 69 facts: 22 of 24 clusters survived hygiene (the two dropped were the owner's names, as designed) and read as real themes, but most hold two or three facts, and a synthesis over a two-fact cluster mostly restates its inputs. Coherence passes; size is borderline. Whether to build it now (gated to clusters of four or more) or wait for the median cluster to grow is the owner's call.

---

## The Flat Store Fallback

When FalkorDB is unavailable, the flat FactStore handles everything:

```
memory/{senderId}/
  raw/2026-06-03/mem_*.md     # Raw markdown with YAML frontmatter
  index/2026-06-03.jsonl      # Append-only index
  facts/facts.json            # Deduplicated machine-readable array
  facts/facts.md              # Human-readable, sectioned by category
  heartbeat-snapshot.json     # Hash tracking for diffing
  removed.jsonl               # Recently-removed (30-day TTL)
```

It handles dedup (hash + substring + optional embedding), importance TTL, review candidate selection, and character-bounded rendering (`MAX_FACTS_CHARS = 20000`, importance-aware — tiers ≥ 4 are never evicted). It's not as powerful as the graph — no multi-hop, no SUPERSEDES, no entity linking — but it's files on disk that never fail.

---

## Memory Forget: Respecting User Intent

When a user says `!forget register agent` or uses the `memory_forget` tool:

1. Matching facts removed from both GraphMemory and FactStore
2. Removal recorded to `removed.jsonl` with 30-day TTL
3. Future extraction prompts include removed facts as a guard: "Do NOT re-extract these — the user explicitly removed them"

Word-level matching handles variations — "register agent" matches "registered agent change" through flexible token matching.

---

## What We Learned

### 1. Code computes, model interprets

The model never does arithmetic, date comparisons, or hash-based dedup. Code handles the "what" (which facts changed, which are duplicates, what the urgency scores are). The model handles the "so what" (what do the changes mean, which connections matter).

### 2. Guard the extraction prompt

Without showing existing facts and recently-removed facts to the extraction model, you get re-extraction of known information after every session. The model doesn't know what it already stored — you have to tell it.

### 3. Importance tiers need examples

phi4:14b never returned the `imp` field until we added five concrete examples with emotional weight (a family member's health = 5). Without examples, the model treated all facts as equally important.

### 4. Entity typing needs graph context

Blind entity extraction by phi4-mini classified DGX Spark as software, Solutions Architect as a person, and created separate nodes for singular/plural forms. Bootstrapping from the graph's existing typed entities solved all three problems.

### 5. Multi-signal scoring > pure similarity

Pure vector similarity surfaces whatever is semantically closest, regardless of importance or recency. A weather fact from yesterday can outrank a health condition from last week. The 50/20/30 split (similarity/recency/importance) ensures critical facts surface appropriately.

### 6. Dedup is a pipeline, not a check

No single dedup method catches everything. Hash catches exact matches. Substring catches containment. Embedding catches paraphrases. LLM consolidation catches semantic overlap. Each layer is cheap individually; together they keep the graph clean.

### 7. Graph > flat for relationship reasoning

The flat store was good enough for 6 months — and it is still a first-class tier for machines without a graph (see Memory Tiers). But when we needed "find everything connected to DevMesh" or "how has Peter's role evolved," it couldn't help. The graph answers these naturally through traversal. The SUPERSEDES chain alone justified the migration.

---

## Infrastructure

The memory system is spread across the fleet by what each box is good at (2026-09-19):

- **FalkorDB** — Docker container beside the Invarail process, under 100MB memory, Redis wire protocol on port 6379 (`memory.falkordb` in config; only the `graph` and legacy `markdown` tiers connect it)
- **Embedding model** — qwen3-embedding:8b, resident alone on the Mac Mini (`inference.ollamaBackends[]`; `embed()` routes by model id) — an encoder does one forward pass, so the Mini's weak prefill only bites on document-sized inputs, which priming no longer sends
- **NER model** — `memory.nerModel` (phi4-mini) on the 3060 utility box; consolidation runs on `memory.consolidation.model`, also utility tier
- **Extraction model** — `memory.extractionModel` (phi4:latest) on the 3060, window bounded by `memory.extractionContextSize`
- **Storage** — Graph in Docker volume, flat files in `data/workspaces/main/memory/` (plus `capture-state.json` per workspace); on the vault tier, the vault folder (`vault.path`) with OKF concept notes under `memory/` when `vault.okf` is on

No cloud services. No API costs. No data leaving the machine. The graph, vectors, entity linking, and fact extraction all run locally.

---

*Invarail is an open-source local-model-first AI agent framework. The memory system described here is part of a larger architecture with ~45 built-in tools (plus whatever MCP servers contribute), an arena tool-loop for conversational work, 2 deterministic pipelines (research + heartbeat), and 4 channel adapters (Discord, Telegram, Web, Gmail) plus a Chrome extension on the Web API — all running on personal hardware.*
