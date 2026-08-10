# Gateway Requirements — what Invarail needs from the inference gateway

Audience: the gateway service at `http://10.0.0.20:8001` (custom FastAPI proxy
fronting Ollama on the DGX Spark). Invarail treats this endpoint as a stock
Ollama API. Everything below is either a gap observed in live testing on
2026-07-06 or a contract Invarail actively depends on.

## P0 — blocking Invarail features today

### 1. `format` passthrough (structured outputs) — currently broken two ways
Invarail sends `format` on `/api/chat` and `/api/generate` as EITHER:
- the string `"json"` (JSON mode), or
- a JSON-schema object (grammar-constrained decoding), e.g.
  `{"type":"string","enum":["chat","web_search"]}` or
  `{"type":"object","properties":{...},"required":[...]}`

Stock Ollama (≥0.5) accepts both and constrains decoding at the token level.

**Observed:** the gateway's pydantic model declares `format: str`, so schema
objects are rejected with a 422 (`"Input should be a valid string"`). Worse,
`format: "json"` is *accepted but not forwarded* — phi4 returned markdown-fenced
output, which Ollama JSON mode can never produce.

**Required:** type `format` as `str | dict | None` and forward it verbatim
upstream. This is the single highest-value fix — it eliminates the
malformed-JSON failure class for every small model behind the gateway
(router classification, param extraction, claim extraction all use it).

### 2. Fail fast when upstream is down — currently hangs, then flaps
**Observed:** with Ollama down on the Spark, a request hung ~4 minutes holding
the connection open (no honor of client disconnect). Later, the gateway dropped
connections mid-test-run. Invarail's client retries 4× on connection failure,
so a hanging/flapping gateway turns a 2-second router budget into 12+ seconds
per message.

**Required:**
- Health-check or connect-timeout to upstream: if Ollama is unreachable, return
  **502/503 within ~2 seconds**. Never queue requests waiting for an upstream
  that isn't there.
- Honor client disconnects (propagate cancellation to the upstream request).
- Optional but ideal: `Retry-After` header on 503.

### 3. Native tool-calling round-trip
Invarail now defaults to native tool calling (`tools` field, no text fallback
in the prompt). The gateway must:
- forward the `tools` array on `/api/chat` verbatim,
- return `message.tool_calls` untouched (objects with
  `function.name` / `function.arguments` as an OBJECT, Ollama-style — not the
  OpenAI stringified form),
- preserve `tool` role messages in the conversation on the way upstream.

Verified working for plain chat; **needs an explicit test with `tools` set** —
if the pydantic request model doesn't declare `tools`, it may be silently
dropped the same way `format` is (silent dropping here = every specialist
loses all tools with no error).

## P1 — required for correctness

### 4. Streaming passthrough (`stream: true` on /api/chat)
NDJSON chunks, unbuffered (flush per chunk), with the final chunk carrying
`eval_count` / `prompt_eval_count`. Invarail streams final answers to the Web
console and Chrome extension through this. Also: `tool_calls` arriving in a
streamed response must survive.

### 5. `options` passthrough
Forward all of: `temperature`, `num_predict`, `num_ctx`, `stop`, `top_k`,
`top_p`, `repeat_penalty`. **`num_ctx` matters most** — Invarail sets it from
`session.contextSize` (131072); if the gateway drops it, models run at
Ollama's small default and silently truncate the prompt head (the system
prompt is what falls off first).

### 6. Token counts
`prompt_eval_count` and `eval_count` on every non-streamed response and on the
final streamed chunk. (Currently present — keep it that way. `*_duration`
fields are null; Invarail doesn't need them.)

### 7. Embeddings
`/api/embed` with `{model, input: string | string[]}` → `{embeddings: [[...]]}`.
Invarail falls back to legacy `/api/embeddings` `{model, prompt}` →
`{embedding: [...]}` if `/api/embed` 404s. One of the two must work —
qwen3-embedding:8b powers the entire graph-memory system (4096-dim).

### 8. Error shape + rate limiting
- Upstream errors: non-2xx with a JSON body. Ollama-shape `{"error": "..."}`
  preferred over FastAPI `{"detail": [...]}` (Invarail surfaces the raw text
  either way, but consistent shape helps debugging).
- If the gateway rate-limits, use **429** — Invarail backs off exponentially
  on 429 specifically (600/1200/2400ms) instead of failing the call.

### 9. Misc passthrough
- `keep_alive` (Invarail sends `"30m"`) — forward so models stay warm.
- `messages[].images` (base64 array) — vision path for qwen3-vl.
- Response `message.content` verbatim — do NOT strip `<think>` blocks or
  reformat content; Invarail manages thinking-tag handling itself.
- Tolerate requests without a `Content-Type` header (stock Ollama does;
  currently the gateway 422s — low priority since Invarail always sends it).

## P2 — nice to have

- `/api/ps` (currently 404) — lets tooling see which models are warm before
  firing a request (avoids blind 4-minute cold-load waits).
- `/api/tags` already works — keep it.
- Cold-load feedback: a custom header or log line indicating "model loading"
  would make slow first-hits diagnosable from the client side.

## Acceptance tests

Run from any box that can reach the gateway (`$GW` = http://10.0.0.20:8001):

```bash
# 1a. format as schema object — MUST return 200 and a bare enum value
curl -s -H 'Content-Type: application/json' "$GW/api/generate" -d '{
  "model":"phi4:14b","prompt":"Classify: \"search the web for AI news\". One word.",
  "format":{"type":"string","enum":["chat","web_search","memory","exec"]},
  "stream":false,"options":{"temperature":0.1,"num_predict":20}}'
# PASS: response is exactly "web_search" (possibly JSON-quoted). FAIL: 422 or prose.

# 1b. format:"json" — MUST return raw JSON, no markdown fences
curl -s -H 'Content-Type: application/json' "$GW/api/chat" -d '{
  "model":"phi4:14b","messages":[{"role":"user","content":"Return {\"ok\":true} as JSON"}],
  "format":"json","stream":false,"options":{"num_predict":50}}'
# PASS: content starts with "{". FAIL: content contains ```

# 2. upstream down — stop Ollama on the Spark, then:
time curl -s -o /dev/null -w '%{http_code}' "$GW/api/chat" -d '{...any valid body...}' \
  -H 'Content-Type: application/json'
# PASS: 502/503 in under 2s. FAIL: hangs.

# 3. tools round-trip — MUST return message.tool_calls with OBJECT arguments
curl -s -H 'Content-Type: application/json' "$GW/api/chat" -d '{
  "model":"qwen3.6:35b","messages":[{"role":"user","content":"What is the weather in Boston? Use the tool."}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather",
    "parameters":{"type":"object","properties":{"city":{"type":"string","description":"City"}},"required":["city"]}}}],
  "stream":false}'
# PASS: message.tool_calls = [{function:{name:"get_weather",arguments:{city:"Boston"}}}]
# FAIL: tool_calls null with prose content, or arguments is a string.

# 5. num_ctx passthrough — send a >8k-token prompt with num_ctx 32768;
#    PASS if the model can quote the FIRST line of the prompt back.
```

## Context: why this matters now

Invarail's 2026-07-05/06 session moved to (a) native-only tool calling and
(b) grammar-constrained JSON for all structured tasks, both aimed at making
7-35B models reliable. Both features degrade gracefully when the gateway
doesn't support them — but degraded means "back to prompt-and-pray parsing."
The gateway is the one component between Invarail and those wins. Items 1-3
above are the difference.
