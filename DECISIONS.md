# Architectural Decisions & Lessons Learned

A log of significant decisions, failed experiments, and why things are the way they are. Prevents re-trying things that already failed and documents the reasoning behind current architecture.

---

## The Wizard Detects Before It Asks — and SearXNG Gets Its Warning (September 27 2026)

Peter, after the review week: *"It still feels very big and weighty… not a ton of walking through and installing the stuff via CLI or making the setup clean and easy."* Then: *"any joe schmoe can use this and install… and the system can pull the information it needs to make those connections."* The security plane had engineering discipline; setup never did. Read first: a real 1,400-line wizard existed (tier question, Ollama probe, token validation, a FalkorDB installer, preflight) — its problems were specific. It **asked** what it could detect (~30 questions), offered four hosted search providers and not the one the compose file ships, never generated the web token the adapter now requires, and its hand-templated output had drifted from the schema (`ollama.host` — silently ignored, the schema only has `url`; no `defaultModel`; the router model as the voice model). And nothing after install told you what was missing.

**Shipped:** (1) `src/setup/detect.ts` — one probe layer: Node, Ollama and every `ollamaBackends[]` host with the models each is declared to serve, Docker, FalkorDB by TCP, SearXNG (JSON on / off / unreachable), LibreOffice, Python with matplotlib+pandas, config, `.env`; each miss carries the install command for THIS OS; no shell strings. (2) `npm run doctor` — the same probes judged against what the config *enables* (web bind + token, search provider and pacing, exec sandbox, referenced models) as PASS/WARN/FAIL with the fix beside each; `npm start` runs it quietly first and refuses only when boot would be pointless (no config, no Ollama, old Node); `GET /console/api/doctor`. First live run on the reference box caught two of its own bugs before anyone else could: an unset `host` is `0.0.0.0` (not loopback), and backend hosts need their own model checks. (3) The wizard reads the report instead of asking: offers a first model pull when Ollama is empty, starts FalkorDB/SearXNG via the compose file (offer, never silently — Peter's rule from the week: *"wtf are you doing"*), only offers the Docker sandbox when Docker exists, asks the one exposure question and **generates the token**. Generation now emits `defaultModel`, `ollama.url`, `host`+`token`, `voice.model` = the foreground model — and a test round-trips the output through the real loader. (4) **SearXNG.** Peter: *"anyone going with SearXNG… needs to be warned… so they don't get throttled to hell or put on the bad list."* The wizard prints the warning and requires an explicit yes; `SEARXNG.md` explains the reputation model in plain terms (the bill lands on the host IP; SearXNG's limiter points inward); `searxng/settings.yml` is a **suggested** profile (*"we can suggest settings"*), every key checked against docs.searxng.org — JSON on, a modest engine set with Google left out, autocomplete off, suspension defaults kept, small outbound pool — mounted by compose, secret written by the wizard; and `tools.web.search.dailyQueryCeiling` is the volume gate beside the rate throttle (0 = unlimited so no existing config changes; the wizard writes 250). Also corrected on the way: the live provider on this box is **Brave**, not SearXNG — the memory note had been stale since June.

**Two bugs only a headless run could find:** the wizard's prompts dropped answers that arrived while no question was pending (readline emits `line` regardless; the promises API keeps only the one it asked for), so `printf '1\n\ny\n' | npm run setup` died at the second question — lines are queued now, and both wizard paths run scripted end to end (that is also what makes a CI smoke possible). And `heartbeat: { enabled: false }` never parsed — `delivery` is required whenever the block exists — so every custom-wizard config with the heartbeat declined was invalid until preflight said so; the block is omitted now. **Not done:** a fresh-clone CI smoke that actually boots (CI has no Ollama — the doctor's FAIL is the honest result there); `insecureOpen` shows in the doctor as a WARN, which covers the third re-review's last nick.

---

## Two Outside Reviews Land — the Walls Have Seams (September 27 2026)

Peter brought two independent reviews of the GitHub snapshot (`2fdfe8c`, ~140 commits behind local main): a 24-finding security review (17 P1, 7 P2, each with an isolated reproduction) and a broader architecture review ("A−; the security plane is authored to a standard I rarely see; one real SSRF hole"). Rule for the discussion: **don't fix, verify, then rank for THIS deployment.** Every P1 was checked against the running code — all seventeen still hold; only the stale-docs complaints were already closed locally.

**What is live on this LAN, in order:** (1) the console binds `0.0.0.0` with no token, answers CORS preflight for any origin, and takes `senderId` from the request body — any web page open in any browser on the home network can act as the owner, and an IP allowlist would not help because the request comes from the owner's own device (F01+F07+F08 are one hole). (2) The `[FILE:]` extractor reads whatever path the model writes in its answer, no containment — prompt injection from a fetched page → attach `.env` (F04). (3) The browser tool never calls `assertPublicUrl`; only `web_fetch` does. And the guard it has misses WHATWG-canonical mapped IPv6 (`::ffff:7f00:1`) (F11). (4) Confirmation expands scope: the confirm set is resolved over the whole registry and checked BEFORE the scoped executor's allowed-set check, and the confirm handler executes with a scope of exactly the stored tool — a policy-stripped tool becomes a preview instead of a denial, and "confirm" authorizes it (F02). Lower exposure for a one-owner box but real: MCP expansion after channel filters (F09), cron jobs run as `ownerId` with no creator (F03), code sessions and Pi on the host regardless of Docker (F05/F06/F18), five tools each doing their own path containment badly (F10, F12–F16), password values in extension DOM snapshots (F17). Moot here: the built-adapter asset (F20 — this box runs from source). Platform/robustness: F21–F24.

**Peter's push-back, and the answer:** "no one else will be using it, its my home internet." True, and beside the point — the threat is a browser, not a person. A page with a hidden script and a guess at `:3100` on a common local address is enough, and the request originates from his own laptop's IP. **Decision: the token is the wall**, not loopback (the phone console and the Chrome extension need the LAN address) and not an allowlist (none exists for web, and it would pass the browser vector). Done tonight, zero code: `WEB_TOKEN` in `.env`, `token: "${WEB_TOKEN}"` on `channels.web`; the API, the React console (Login page → localStorage) and the extension (settings) already carry a bearer. Known gap: the standalone hold-to-talk page at `/` sends no token and will 401 — unused; fix if it is ever used. What the token does NOT fix: caller-chosen `senderId` (F07) for anyone holding the token, and nothing in the prompt-injection chain.

**Shipped the same night (Peter: "go"), and pushed — GitHub had been at `2fdfe8c` since August 18, 144 commits behind, which is why both reviewers read a mid-August tree:** (1) `[FILE:]`/`[IMAGE:]` delivery requires the canonical, symlink-resolved path to sit under an allowed root (default `<cwd>/data`, where every artifact lives and `.env` does not); outside → token stripped, nothing attached, warning; missing → token kept as text as before. (2) `isPrivateIpAddress` decodes an IPv6 address with an embedded IPv4 in any spelling (`::ffff:7f00:1`, expanded, dotted tail, compatible form), and the browser tool runs every open/navigate through `assertPublicUrl` with `tools.browser.allowedPrivateHosts` as the configured exception list — the guard is on the address the model asked for; in-page redirects are the browser's own. (3) Both confirm wrappers check the allowed tool set BEFORE the confirm set, and the confirm handler re-authorizes the stored action against channel + specialist policy (`src/security/tool-policy.ts`) before executing: a confirmation approves inside the caller's permissions, never widens them. Tests for each seam.

**The re-reviews (same day) and the second pass.** Both reviewers re-read `d863638`: the security review verified the three fixes, marked F02 and F11 fixed and F04 partial, and added seven findings (N01–N07); the architecture review moved its grade to "A−, now defended by evidence." Every new claim checked out against the tree — including N01, an omission in the policy helper written the night before (no category checks). Peter: "do it." Shipped in four slices plus N02, each committed green with the exit code checked and pushed:

- **Slice 1** — N01: `checkToolPolicy` applies `allowedCategories`/`restrictedCategories` before the tool layers. F04: attachment roots are the directories tools WRITE to (`data/media`, `data/uploads`, `<workspace>/{images,diagrams,research,documents,builds}`), not the whole `data/` tree that also holds `data/secrets.json`, the ledgers, transcripts and memory. F01: the web adapter refuses a token that resolved to `''` (an unset `${WEB_TOKEN}` looked configured while open) and refuses a non-loopback bind with no token unless `insecureOpen: true`; the starter config binds `127.0.0.1`; the loader warns on an unset `${VAR}`; CORS echoes only `chrome-extension://` origins and `channels.web.allowedOrigins` instead of `*`. package.json 0.3.0; Slack/MS Graph gone from `.env.example`.
- **Slice 2** — F09: `mcp:<server>` tokens expand to concrete names BEFORE the channel filters (idempotent for the later pass).
- **Slice 3** — `src/security/paths.ts`: one canonical containment policy (`containedPath`/`containedInAny`/`safeBasename`; symlinks resolved on the deepest existing ancestor; no sibling-prefix acceptance). `write_file` decides the protected list on the canonical path (F12: `SOUL.md/.`), `memory_get` uses the dispatching agent's workspace (F16), `workspace_read/write` drop `startsWith`, the document tool takes a plain filename (F13), converts only from workspace/media/uploads, and runs LibreOffice via `execFileSync` with an argument array (F14) — which also made the dash-vs-sh test deterministic.
- **Slice 4** — N03/N04: capture merges its record into a fresh read of the state file after the await, and a reset bumps a per-session generation that drops an in-flight extraction's result. N05: journal names get a random suffix + exclusive create. N07: a verifier that throws is "could not verify" — never a pass, never a model-directed rejection.
- **N02** — with `repoRoot` set, the merge gate runs `tsc`/`vitest` via node from the MAIN tree's `node_modules` with the worktree as project/root; the arena's copied `node_modules` (which Pi can edit) no longer judges Pi's work.

**Re-review 3, follow-up check (`3982930`):** all four nicks verified, including the basename fix proven by its own two tests flipping green on Windows. Windows failures 21 → 19, every one a platform artifact (11 backslash assertions, 3 chmod no-ops, /etc/hosts, python3, 2 soffice error-text, 1 pi-build spawn). "The loop is closed." Their remaining distance to A+: (a) the host-execution sandbox, (b) tests asserting on normalized paths so the suite means the same thing cross-platform, (c) an operator-facing preflight warning when `insecureOpen` is set. (b) and (c) are small; (a) is a session.

**Re-review 3 (same day, `e5c06c7`):** grade A; "19 of 31 findings fixed in code this round, 24 of 31 addressed, the 8 open ones are structural decisions with stated fixes." Four nicks, all taken: `npm start` now exists (builds the console on first run when `console/dist` is missing — the fresh-clone 404 both reviews hit), INSTALL carries the LAN-exposure recipe (bind + token + where the token goes), attachment filenames come from `path.basename` (the Windows wart), CI builds the console, and SECURITY.md gives a disclosure path. Their stated distance to A+: the F05/F06/F18 sandbox, and a suite that means the same thing on Windows.

**F03 closed by decision (Peter, 2026-09-27):** scheduled jobs keep running as the owner and no creator is recorded — *"every agent is essentially an extension of the user, I'm okay with this."* The reviewers' concern is a non-owner scheduling owner-privileged work; on this deployment no non-owner can schedule anything, and the deployment IS the owner. If that ever changes (a shared Discord channel with cron in its allowed categories), the small fix is owner-only creation — `cron_add`/edit/run check `isOwner` — not a principal model. Recorded so nobody re-derives it. **Still open, deliberately:** F05/F06/F18 (host execution for code sessions, Pi and its SDK tools — a sandbox, not a patch), F07/F08 (console identity and channel policy — the token makes it one owner today), F10 (`website_query` origin), F17 (extension password values), F19 (ledger durability), F20–F24, N06 (rollback reinstall). Ranked in the reviews; tracked here.

**A lesson from the push itself:** a test file with a top-level `await` inside a sync `describe` fails to *transform*, so it never loads — and a "Tests N passed" tail counts only files that loaded. `test/learnings/training-collector.test.ts` had been silently red since the day before; it surfaced only because the push chain checked vitest's exit code instead of its tail. Read the **file** count, and the exit code, not the test count.

**Next, in Peter's order once he says so:** the `[FILE:]` extractor (structured artifacts from authorized tools, or at minimum canonical containment to workspace/media roots), `assertPublicUrl` in the browser tool + the IPv6 canonical-form fix, the confirm-scope reorder (allowed-set check first; confirm handler re-checks policy). Then a single canonical path-policy module the five tools call, and a design decision on a scheduled job's principal.

---

## Memory Gets Its Intake Fixed — and a Synthesis Pass Is Measured Out (September 20 2026)

### The question that reordered the work
Peter, mid-build: *"Why does it feel like we might have made our memory cheaper instead of better?"* — and he was right. Provenance, capture and the USER.md fix are all correctness work; the only two items from the agent's own wishlist that would have changed how it THINKS (causal edges, retrieval-time inference) were the two rejected. The honest sequencing answer is that provenance is what makes the ambitious version safe to label — but hygiene alone is the librarian the agent said it didn't want to be.

### What the graph actually contained
Before building anything on top of it: **24 facts, 52 entities**, all under one principal. Entity clusters (the raw material for any "so what" pass): `Peter Green` holding 12 of 24, `AI` holding 5, and four 2-fact clusters of which two were the SAME spurious NER pairing (`Router` and `LocalClaw` both attached to an unrelated fact about LIT networking events). Not one usable theme. The graph wasn't shallow because the schema was weak; it was shallow because **intake barely ran** — extraction fired only at `!reset` and on the 2h heartbeat, and Invarail had been off for a month.

### Shipped
- **Incremental capture** (`src/services/memory-capture.ts`): every N unprocessed turns, on the window only, AFTER delivery, fire-and-forget on the utility tier, hard-bounded. The trigger is code — the alternative on the table was a model call to detect topic shifts, i.e. model judgment on the hot path deciding whether to spend another model call. Marker advances on empty extraction (or the window re-sends forever) and rewinds on `!reset`. Facts land `observed`. `memory.capture.enabled: false` is the one-line off switch.
- **Cluster hygiene** (`filterDegenerateClusters`, applied inside `getClusters`): owner names excluded by rule (from config principals — the name is the deployment's), and a document-frequency stopword rule measured per corpus rather than a blocklist.
- **USER.md authority inversion**: read-only to the agent, fed to extraction as an authoritative do-not-re-extract block. Identity is a rule, not an observation.

### Caught before it shipped: provenance would have hedged ALL of memory
Every fact in the graph predates the field and reads as `observed`; nothing is `stated` until the next `!save`. Unconditional marking would have tagged every injected line "unconfirmed" and told the model to ask rather than assert — on day one, for the whole store, a straight downgrade of a system Peter described as already able to "pass information and ask me about things that are happening." Now marks appear only when the injected set is actually MIXED. **A distinction that doesn't distinguish is noise** — the same principle as the frequency rule.

### The synthesis pass: gated, and the gate failed
Re-ran the cluster check after hygiene. Owner hub dropped. `AI` survived at 21% — the 50% frequency rule only ever catches the owner, which the name rule already handles, so on this corpus it does nothing. Every surviving cluster was a 2-fact restatement or the NER pairing. **Not built.** Feeding these to phi4 and asking what the combination implies produces the inputs with a conjunction. The design stands (heartbeat-time, `(:Synthesis)` node with `provenance: inferred`, structural `DERIVED_FROM` edges so a superseded input invalidates it by code, short expiry, max 1 in priming) — re-run the gate after capture has fed the graph for a few weeks and calibrate the frequency threshold on real volume, not on one 24-fact reading.

### First live capture, and what the first `!reset` after it revealed
Capture fired at turn 50 (phi4 on the 3060, 4 facts, 1 correctly deduped). Read against the transcript: two accurate, one **fabricated** — phi4 turned "my goal is to make me redundant" into "one-time setup rather than recurring revenue", and Peter's next message said the opposite (retainer). Provenance labels the PATH a fact took, not whether its content is a quote or an extrapolation; that line is held in the extraction prompt now ("do NOT infer", with the tell-tale phrasings named). Left the wrong fact in place deliberately: the next capture window holds the correction, and whether SUPERSEDES catches it is the live test of that machinery.

Then `!reset` on an 80-turn session: `[Facts] No JSON array found` — phi4's output was **the assistant's own prose, starting mid-word**. Root cause: extraction set no `num_ctx`, Ollama's 4096 default overflowed on 30,680 chars, and Ollama truncates from the FRONT — the instructions were the first thing gone, so the model saw a wall of chat and continued it. Capture's windows are 4–7K chars, which is why they worked. **Fixes:** `memory.extractionContextSize` (8192) + transcript bounded to fit it with a loud warning; `!reset` extracts only what capture hasn't read (window-sized by construction); and **`!save` is now the review gate** — it promotes the session's captures observed→stated, the only way a captured fact ever becomes stated. The tail of that one session (turns 74→80) was lost; everything before it had already been captured.

### The task_add that returned nothing — a regression of my own, same night
"Lets create a reminder for tomorrow…" → `task` arena → three "empty completion" steps → `CHANNEL_SEND_ERROR`. Probed the A5000 directly with the exact `task_add` schema: **the model was fine** — clean tool call, correct `dueDate`, with thinking off AND on. The engine never saw it. Cause: the headers-timeout fix earlier tonight made `chat()` route through `chatStream()`, and the Ollama stream accumulator read `tool_calls` off the LAST chunk — the stats-only `done:true` one. Ollama sends the tool call in a middle chunk. Every native tool call on the Ollama-native path had been dropped since the 02:57 restart; chat has no tools, so nothing showed until the first tool request. **Two lessons, both about verification:** (1) "clean tool calls" was verified BEFORE the streaming change and never re-verified after — a change to the transport is a change to every path through it; (2) the OpenAI-compat stream path had tool-call tests and the Ollama one had none, and the untested one is the one that broke. Second bug underneath: the non-streaming Discord branch lacked the empty-answer guard the streaming branch got 2026-08-21, so the empty answer became a generic error instead of an honest one. Third, exposed by the same un-restarted process on "what do you know about me": step 2 was a CORRECT direct answer from injected memory, the premature-answer repair sent it back, the retry came back empty, and the loop returned the empty retry. **A behavioral repair that yields nothing now returns the answer it rejected** — a heuristic about process must never convert a usable answer into nothing. Checkpoint rejections are excluded on purpose; that is an oracle. Fourth, after the restart: every short follow-up in the memory arena arrived TWICE — the stream bubble (an un-awaited `send()`) races delivery when the final answer is the first stream event, so delivery saw no bubble, sent fresh, and the bubble landed as a copy. Delivery now waits (3s bound) for an in-flight bubble; and the premature-answer guard no longer fires on <30-char follow-ups with history — sticky routing keeps those in the arena deliberately, a direct reply is correct there, and each repair was a wasted 27B call.

### First priming timeout — the embedder meets the prefill lesson (September 21 2026)
`Memory priming timed out (8s)` fired once, on the turn Peter attached a PDF. The Mini was fine (embedder resident, short embeds 0.13–0.35s). The message carried the PDF's 8,906 extracted chars and priming embedded all of it — ~2.5K tokens of prefill at the Mini's ~120 tok/s, i.e. ~20s. Same lesson as the day before, on the embedder this time. Also the wrong query: a document-sized embedding is a blurry average. `primingQueryFrom` now strips page and PDF bodies (headers kept) and caps at 800 chars before any of the four priming embeds. The turn ran without memory but was otherwise fine — which is the whole point of the cap.

### Corrections to the session's own reads
- The two "deterministic systems" facts are NOT duplicates — they share a phrase and carry different information (podcast vs. job title). Dedup was right; no similarity guard was added.
- The earlier "59 facts" figure was wrong; it is 24.

### Still open
NER attaching `Router`/`LocalClaw` to a fact about tech meetups is an entity-typing quality problem, not a clustering one. Unfixed; worth a look once there is volume to judge it against.

---

## Voice Comes Home to the Mini — mlx-audio Replaces the Dead Gateway (September 25 2026)

### What was actually broken
The console mic "didn't work" and a research PDF "didn't push". The PDF was a restart mid-run plus a real bug (the console never rendered `files` from the done event — fixed, c3e1548). The mic was two things: a browser site permission, and — underneath it — **both voice servers had been refusing connections since the gateway box was retired on the 19th.** STT and TTS were dead for six days and nothing said so, because `stt.ts`/`tts.ts` warn-and-return-null.

### The stack
`mlx-audio` (Apple MLX, Metal) on `Peters-Mac-mini` — the always-on box Invarail runs on (NOT the .221 embedder Mini; there are two) — one process on :8000 serving the exact routes the clients already call: `POST /v1/audio/speech` (Kokoro-82M, `af_bella` = American female) and `POST /v1/audio/transcriptions` (whisper-large-v3-turbo). Measured: **TTS 0.29s warm** for a sentence (8.0s cold, pipeline build), **STT 0.85s warm** for a short clip, word-perfect on Kokoro's own output. Runs in tmux `serve:voice` beside Laya in `serve:laya`; launchd plists are the next step so a reboot doesn't take voice down.

### Two client mismatches, config-not-code
- `tts.ts` hardcoded `model: 'tts-1'`; mlx-audio resolves models by HF repo id. `tts.model` is config now (default `tts-1` keeps OpenAI-shaped servers unchanged).
- mlx-audio's transcription default is its native ndjson stream; `stt.ts` now sends `response_format=json` (OpenAI-compatible servers accept it and return what they always did). (f95eea4)

### "Definitely not fast to respond" — where the seconds actually went
Voice worked first try after the restart; it was slow for reasons that had nothing to do with the new server (STT 0.85s, TTS 0.3s). (1) The voice fast-path model `qwen2.5:7b` "for speed" lived on the 12GB 3060 beside phi4 (9.7GB): every voice turn loaded it and evicted the router, and the next router call reloaded phi4 — 2.5s cold, 7.6s mid-thrash. **A small model that has to load is slower than a big one that is resident.** Voice now replies on the A5000's 27B. (2) The A5000's `keepAlive` was the 30m default, so the foreground model unloaded after any quiet half hour and the next message paid a 6s reload — pinned with `keepAlive: "-1"`. (3) A 4s priming stall coincided with the flat store's synchronous `rebuildFacts` (readFileSync/writeFileSync on the event loop) — the one real code item, not yet done. The router itself (phi4 warm 0.2s vs Laya ~0.1s) is the remaining seat, and that is the shadow's job to earn. (4) Tried Peter's ask — a genuinely small voice model — by placing `phi4-mini` on the A5000 beside the 27B (~6GB free): at its default context it loaded at **7GB and evicted the 27B**, which would have made every text message after a voice one pay a 6s reload. Reverted. The honest constraint: the only box with fast prefill is full at the 32K production context, and the 3060 can hold phi4 or a second model but not both. A small model for voice needs either a per-path smaller context (new config) or a card with room. Voice stays on the resident 27B; the voice path now logs `[Voice] stt/dispatch/tts/total` so the next call is made on numbers.

### Round two, with the `[Voice]` line in hand
phi4-mini at 8K beside the 27B on the A5000 (20.4 of 24GB) answered in 0.3s — and called Alex "your husband", then parroted its own previous reply verbatim. A 3.8B is not a conversation partner. Meanwhile the timing line showed dispatch at 6–8s around that 0.3s model: (1) the **post-answer semantic-state extraction was awaited** before dispatch returned — a 1.5–3s phi4 call whose result only matters next turn; detached. (2) Voice prefilled the **full chat workspace context** (~7K chars of TOOLS/USER/AGENTS); now `minimal`. (3) 457-char replies cost 3s of TTS; `voice.maxTokens` 160. (4) The real eviction culprit: **utility calls with no `num_ctx`** (NER, contradiction, consolidation) inherit the server default — 32K on the A5000 — so phi4-mini loaded at 7GB on every capture batch and evicted the 27B; a per-host `defaultContextSize` now fills any call that leaves it unset. Voice model: **qwen2.5:7b at 8K, co-resident** (3.0GB) — the original fast-path model, on a box with room. One line back to the 27B if quality disappoints. Both Ollama hosts are pinned (`keepAlive: "8760h"`; the string "-1" is a 400). Not yet done: streamed TTS (`tts-stream.ts` exists, wired to nothing) — the largest remaining perceived-latency win, needs the web adapter and console to accept audio chunks.

### Round three: the split, not the model
With the lean flow in, priming fell to 0.3s and dispatch was STILL 4–7s. Direct measurement: `qwen2.5:7b` decoding at **13 tok/s** on an A5000 — because it was **partially offloaded to CPU** (3.0 of 5.6GB in VRAM). The 27B's 17.4GB plus CUDA overhead leaves ~2–3GB of usable headroom, not the arithmetic 6.6; every 4–7GB "small fast model" placed beside it split and crawled. gemma3:4b split too (2.2 of 4.0). The 27B itself decodes a voice reply at **31–39 tok/s fully on GPU** — 3x the split 7B — and knows Peter's wife is his wife. **Voice runs on the foreground model**; the lean flow is what made that fast, not a smaller model. phi4-mini (2.5GB) is the one small model that fits fully beside it and stays for NER. Structural way to get a real small voice model: free the 3060 by moving the router to Laya (the shadow's job), or drop the 27B to 16K. Lesson: **check `size` vs `size_vram` in `/api/ps` before believing a model "fits".**

### Round four: empty replies — the flag that never left the building (September 26 2026)
"Its failing now." Two voice turns at `reply=0 chars`, dispatch 6.6–7.4s, then TTS failing on the empty string. Network was fine (A5000 answering in 0.5ms, no retry lines). The cause was one missing key: `runAsBareChat` — the path every tool-less specialist takes, chat and voice alike — built `{model, messages, options}` and **never forwarded `think`**. The tool loop and the pipelines have forwarded `specialist.think` since the August eval; bare chat was the one caller left out, so the chat specialist's `think: false` never reached the wire. On a natively-thinking model that means thinking-on by default, and the 100-token voice cap was spent inside the think block. Proof, same voice prompt to the 27B at `num_predict: 100`: without the flag, 357 chars of thinking and content cut off mid-sentence at exactly 100 tokens (1.9s); with `think: false`, a 13-token answer in 0.43s. With the real system prompt and history the think block runs longer and content is simply empty — which is the log line.

Corollary, unmeasured until now: every plain text chat turn on the 27B has carried a hidden think block since the A5000 cutover — not visible (the client strips it), just slower. Fixed at the one line (`think` forwarded when the specialist sets it; key absent otherwise so the server default still applies), regression tests on the dispatch path including the voice override inheriting the chat flag. Lesson, same shape as the `num_ctx` one from round two: **a per-specialist flag is only real at the callers that forward it — grep every `client.chat(` when a flag is added, not just the engine.**

### Round five: the `[Chat]` line, and what 3.3K tokens were doing in a voice turn
With prefill/decode timing on the wire, every voice turn read the same way: `prompt=3258–3318tok/3.6–3.7s gen=3–11tok`. The reply is a rounding error; the prompt is the turn. Two findings, both measured rather than guessed.

**The prompt.** The static head (chat system prompt + minimal workspace + voice instruction) is 878 tokens, the history window ~150. The other ~2,300 were the per-turn memory block — and inside it, the **UserModel node had 41 property keys and rendered to 9,079 chars**. The heartbeat's analysis prompt asks for four fields; the model answers with those four plus one or two it invents (`actionPattern`, `emotionalProfile`, `topicInterworks`, `howTheyWantHelp`…), `updateUserModel` MERGEd every key it was handed (interpolated into Cypher, no less), and `getUserModelSummary` printed every non-empty key under "User preferences" — on every turn, every category, since the day the node was created. Fixed at both ends: a declared `USER_MODEL_FIELDS` list that the writer filters to and the renderer reads from. The 37 drifted keys are now inert on the node; removing them is a one-line Cypher `REMOVE`, Peter's call.

**The cache.** Even at 3.3K tokens a warm prefix should have made this ~0.8s, and the earlier probe showed the server *does* reuse — so why cold every turn? Because the 27B is `qwen35`: a **hybrid** (Gated-DeltaNet SSM layers, full attention every 4th), and a recurrent state cannot be rewound to an arbitrary token — Ollama restores from checkpoints. Measured at the real prompt size, same server, same model:

| prompt evolution between turns | prefill |
|---|---|
| exact extension of the previous sequence | 283ms |
| history grows, volatile memory block replaced (Invarail's text shape) | 861ms |
| only the last user message differs | 823ms |
| **window slid by one exchange (Invarail's voice shape)** | **4036ms — cold** |

Diverging near the tail is cheap; diverging right after the head is a full cold prefill, and a sliding window diverges right after the head by construction. The voice window is now **anchored with hysteresis**: history grows append-only from the anchor until it holds 2×cap turns, then re-anchors to the last cap — one cold turn per dozen exchanges instead of every turn. Expected voice turn after restart: STT ~1s + priming ~0.5s + prefill ~0.8s + TTS ~0.3s ≈ 2.5–3s, from 6–7s.

**Corollary for the text path, unmeasured:** the compacted history (summary + recent-turns tail) slides too, so text turns on the 27B are probably cold-prefilling 8K+ tokens each — invisible behind streaming, but it is the same money. The 2026-09-19 prefix-cache contract was written against a plain transformer; on a hybrid it holds only for tail-side divergence. The tool loop has no `[Chat]`-style timing line yet.

**Flagged, not fixed:** the semantic state for the web session carries `knownFacts: "The user is trying to get married."` and a pending action *"How's everything going with your husband"* — phi4's semantic-delta extraction hallucinating over spoken small talk, then riding the state preamble into every turn. That is where "your husband" came from, not the voice model. Worth a do-not-infer rule of the same shape as the fact extractor's.

### Setup gotchas, recorded so nobody pays twice
- **Python 3.14 is too new**: `misaki[en]` (Kokoro's G2P) needs spaCy, which has no 3.14 wheels and fails to build. `uv venv --python 3.12` (`~/voice-serve/venv312`).
- **Kokoro auto-installs a spaCy model on first use via `uv pip install`**, and uv can't see a venv launched by interpreter path — the first request returned HTTP 200 with an empty body. Pre-install `en_core_web_sm` and launch with `VIRTUAL_ENV` exported.
- **MP3 needs ffmpeg** (brew). WAV does not.
- Ctrl-C into a `server | grep` pipeline kills the filter, not the server; the orphan kept :8000 and hung. Launch bare.

---

## A 421M Encoder Out-Routes phi4 — the Laya Experiment (September 25 2026)

### Why
Jev (TypeSafe AI, Sep 15) and its open clone Laya (Convai, Apache 2.0) are "System One" models: state + typed question in, calibrated probability out, one forward pass, nothing generated. Invarail asks a generative small model a typed question in at least eight places (router, steward `needsPeter`, contradiction check, consolidation, claim verification…) and every one of them carries the whole week's bug class — JSON to parse, thinking to leak, `format` collisions, empty completions. A model that structurally cannot produce malformed output is shaped for exactly those seats. Jev itself is out on principle (cloud; it would see email, memory, routing). Laya runs on CPU. **Nothing was wired into Invarail — Peter's rule: observe behavior first.** Everything lives in `~/laya-eval/` (venv, scripts, checkpoints, results).

### The router, measured on one held-out set (78 hand-labeled, corrected)
| | flat | excl. 6 email/calendar | traffic-weighted | p50 | ECE |
|---|---|---|---|---|---|
| phi4:latest (live, 3060) | 76.9% | 83.3% | 80.0% | 270ms | — |
| Laya zero-shot | 38.5% | — | — | 65ms | 0.44 |
| Laya v0 (auto-agreed labels) | 56.4% | — | — | 63ms | 0.31 |
| Laya v1 (+ rulings, oversampled) | 61.5% | — | 79.0% | 63ms | 0.32 |
| **Laya v2 (+ 777 synthetic)** | **80.8%** | **87.5%** | **90.8%** | **63ms** | 0.17 |

Traffic-weighted = per-class accuracy weighted by how often Peter actually sends that class (72% chat). Fine-tuned on this Mac's MPS in ~55 min (421M ModernBERT-large, 4 epochs, RLCD recipe ported from the Kaggle notebook to single-device; gradient checkpointing ON and micro-batch 2 — the notebook's config OOM'd at 20GB on a 17GB Mac).

### What the data cleaning found (the "together" part)
1,540 router pairs = 1,345 unique messages, all labeled by **phi4's own past decisions**, not truth. Re-labeled every one with qwen3.8 under the CURRENT prompt; auto-accepted the 1,119 agreements; grouped the 168 real disagreements into patterns and Peter ruled on four: browse-a-named-site is `web_search` (it holds `browser` now — a capability fact, not taste), discussing an image prompt is `chat`, sub-20-char follow-ups are dropped (sticky routing handles them live), "forget X" is `memory`. 85 synthetic messages that were never Peter's (plan-pipeline sub-steps, `[SYSTEM]` notices, attachment stubs) were in the training file — `training-collector.ts` should skip them (not yet changed). Two classes had effectively zero examples: `message` (0 — the six originals were mislabeled chat) and email/calendar → `multi` (0 — phi4 has never routed them right).

### Synthetic data, gated by round-trip
qwen3.8 wrote 818 messages in Peter's voice (anchored on real examples per class); each had to **round-trip through the current-prompt classifier back to its intended class** to be kept — 777 survived (95%). `task` lost the most (82%), because "add: fix typo in readme" is genuinely ambiguous with `exec` — a real boundary in the config, surfaced by the filter. Synthetic rows are tagged and never enter the eval set.

### Disproven / caught
- **Confidence-gated hybrid (Laya first, phi4 below a floor) is NOT the deployment shape.** With v0 it lost to phi4 at every floor; with v2, Laya alone beats every hybrid row because the items it is unsure about are ones phi4 also misses. And the calibration is still compressed — fitted temperature 3.4, 95% of items land in 0.95–0.99 — so the probability is *ordered* but not yet a usable gate. The "code owns the threshold" thesis is unproven; the accuracy win is real.
- **The hand-labeled eval set had rotted.** Three browse items still expected `multi` from before `web_search` held the browser; three plain chat lines were tagged `message`. Both models were docked for correct answers. Corrected, and both re-scored on the identical set.
- **Live routing gap, unrelated to Laya:** "check my email", "what's on my calendar today" → the live router sends them to `chat` / `memory` / `cron` — **6 for 6 wrong** — because since `personal` was retired no category description mentions Gmail or Calendar; the tools live in `multi` (owner-only). One-line config fix, Peter's to make. Laya v2 gets these wrong too (→ `task`): the synthetic multi examples were all chained "check cal, then add a task", so it learned email→task. Pure-read examples are the v3 fix.

### Next, in order
1. Peter: the email/calendar description line in config.
2. v3: pure email/calendar-read synthetic examples for `multi`; re-measure.
3. **Shadow mode** — Laya served on the Mini (`/v1/systemone`, ~65ms), called alongside phi4 on real traffic, both logged, phi4 still decides. Real distribution, real disagreement rate. Only after that: `router.backend: "systemone"` as an additive backend kind with keyword fallback.
4. Same recipe for the steward's `needsPeter` (the autonomous_action log is the label source).

### First live shadow readings, and what the disagreements were
16 messages after the restart: 13 agree. Of the disagreements — sticky routing carried plain conversation into the previous turn's arena twice (`chat`→`memory` after a `!forget`; `chat`→`multi`, which then **ground through 30 web searches** on a sentence that was just Peter telling it his conference plans), and Laya said `chat` both times, correctly. The third: a pre-model override (`data … research`, `PRE_MODEL_OVERRIDES`) sent "Im hoping to get some good data … research" to the research pipeline — Laya said `chat`, and this time **Laya was wrong**: Peter did mean research. Tally on real traffic so far: Laya right on 3 of 4 disagreements. Too few to conclude anything except that the mechanism works and that sticky routing is the incumbent's main leak.

**66 messages in (September 26 2026):** 58 agree (88%), shadow p50 185ms over HTTP. Eight disagreements, judged by hand: Laya right on 5 (three sticky leaks — a meetup lookup carried into `chat`, "Laya is being pretty good" carried into `memory`, "Awesome." carried into `cron` — plus a conference-plans sentence phi4 sent to `multi`, and "what are your thoughts on Jev and Laya, if you don't know…" which wants a search); wrong on 2 (the `data … research` keyword override Peter did mean, at 0.96 — the training-set gap, still; and "what does the capital of France look like" → `memory` at 0.49); one toss-up (RuneScape Dragon Wilds → `memory` at 0.17, phi4 said `chat`, both should have searched). The calibration finally shows a shape: **every one of the 58 agreements is ≥ 0.92, and the two clearly wrong model-layer calls are the only two rows under 0.9** (0.49, 0.17). A gate at ~0.9 would have deferred both. Not enough rows to trust that as a threshold yet — but it is the first evidence the probability is usable as one, which the eval set said it was not.

### Does Laya make sticky routing unnecessary? (September 26 2026)
Peter's question: Laya is fast enough to route every message, so does sticky go away? Sticky does two jobs — skip the 270ms phi4 call on short follow-ups (Laya at 65ms kills that reason), and give a fragment like "yes do it" the context it has no intent without (a bare-message classifier cannot do that, Laya included). A System-One model is state + question, and the shadow sends `state: {message}` only. Probed against the LIVE v3 server, no Invarail change:

| input | bare | with previous turn in state |
|---|---|---|
| "yes do it" after a cron proposal | chat 0.28 (a shrug) | **cron 0.95** |
| "Awesome." after "Want me to set that up? Reply yes" | chat 0.95 | **cron 0.92** |
| "Awesome." after "Done. You'll get a Discord DM Tuesday…" (the live sticky leak) | chat 0.95 | chat 0.95 — correct; sticky said cron |
| "the second one" after a two-result search reply | chat 0.94 | web_search 0.31 (right, unsure) |
| a junk state field | chat 0.94 | chat 0.94 — ignored |

v3 was trained message-only and still reads the state fields zero-shot, in both directions: it confirms into the pending category when the assistant asked a question and stays `chat` when the assistant reported the action done. That is the distinction sticky's 30-char heuristic structurally cannot make, and it is the whole bug class behind the sticky leaks in the shadow log. Replaying all 46 shadow rows that could be matched to a transcript with state added changed **zero** answers — the real traffic so far is mostly fresh sentences, and the one matched sticky leak ("Awesome." after "Done.") was already right bare. Also observed: a completed cron job's follow-up conversation stays in `cron` for the live router because the *category* of the previous turn is sticky, not the *state* of it.

**Decision (Peter):** keep the shadow running through the week; likely fine-tune v4 before any switch.

### Housekeeping from the full doc read (September 26 2026)
Reading every doc end to end against the code surfaced three code facts, not doc facts. (1) The quick-greeting model was a literal `'phi4-mini'` in dispatch.ts — now `router.quickModel`, optional; unset = no fast path. (2) A pre-model override forced any "go to / browse / visit <site>" message into `multi`. It predated `web_search` holding `browser`, contradicted ROUTING.md and the ruling behind the Laya labels, and hijacked chained requests before either router saw them. **Deleted** (Peter: "lets go with delete the override"); the keyword *fallback* for the same phrasing now says `web_search` so the tier that fires when phi4 is down agrees with the tier that fires when it is up; three eval-corpus rows re-labeled. (3) **`code_gen` runs `dispatchMode: "arena"` with `pi_build` as its only tool, and arena skips a pipeline even when one is configured — so the code_gen pipeline's verify → fix → re_verify → commit stages have not been running.** `pi-build.ts` was written as "the bounded make-the-files slot" inside that loop; as configured, Pi builds and nothing verifies. Decision pending: drop `dispatchMode` on `code_gen` to restore the loop, or keep arena and accept unverified builds. Also: SPECIALISTS.md had specs for 6 of 12 categories — the other six (memory, cron, task, message, website, code_gen) now exist, written from config + code, not memory.

### The memory trap, and what the model got right inside it (September 26 2026)
Live log, same evening: a 40-turn Discord DM (the baby, Peter's dad, the enrichment-facility work, the Proxmox/TrueNAS build) spent **20 consecutive turns in the memory arena** because sticky routing never let go — `isLikelyFollowUp` breaks only on commands, imperatives, greetings, or a keyword hit for another category, and conversation has none of those. Per reply: 9–42s (metrics), 2–4 iterations, a premature-answer repair on 15 of 20 turns (two model calls per reply), and on nine turns the repair's "call a tool if relevant" produced `memory_search`/`memory_save` mid-conversation — "Using memory_save…" bubbles beside a message about his father. The shadow router said `chat` on every one (tally: 89 rows, 67% agree, 24 of 29 disagreements sticky, 22 of those Laya=chat). The `!reset` then harvested 21 router pairs with those turns labeled `memory`.

**Peter's read, which is right:** *"I didn't hate that the model was like maybe I should know this about his setup."* The saves were good facts, written better than phi4 writes them — "too rich for my blood" survived as the reason. The instinct is the foreground model's judgment about what matters; the mechanism was an accident of a bad route. Incremental capture was already running on the same session (5 batches, 15 facts) and got most of the same facts in flatter prose; semantic dedup let the pairs through (different phrasing), consolidation will merge them.

**Shipped:** `memory` removed from the sticky set (a memory question is one-shot; a follow-up re-routes through the model, which says memory again if it is one). The extraction prompt now keeps a user's *stated* reason inside a decision fact — the part of the model's saves worth copying — under the same do-not-infer rule. **Also shipped (same evening):** user turns now record `routedBy` (override | sticky | model | keyword | fallback) and the training collector skips sticky-decided pairs — a carry-over is not a label; turns older than the field still harvest. **PARKED — bring up again later (Peter):** giving the chat specialist a silent `memory_save` so the foreground model's own judgment about what to remember runs deliberately instead of by accident. It would move chat off the bare-chat fast path (tool loop, tool schema, guards, and the `[Chat]` timing line lives on the bare path), so the shape is: a day of `[Chat]` timings before and after, then decide. The shape for v4 is now clear: train on `{previous_category, assistant_last_reply, message}` — the transcripts already carry all three — so the model that replaces phi4 replaces sticky in the same move. Until then the shadow stays message-only so its log remains comparable.

### The dog-food report — the research pipeline's failure, not the router's (September 25 2026)
That research run decomposed "Jev vs Laya" into six facets of **dog food**. Pipeline isolation (fresh context, no memory, no history — correct for real research requests) meant `decompose` met two names it had never seen and filled them from its prior with the nearest thing two short product-y names could be. The `discovery_sweep` stage exists to prevent exactly this ("archetypal entities it remembers", 2026-08-14) but was gated to recency-shaped topics; an unfamiliar name is the same hole as this week's news. **Now:** the sweep runs for every topic a flow did not facet — timeless topics get "what is X" queries with no freshness filter and decompose is told the results are the *definition* of the named things, never what the names sound like. Two searches on a run measured in minutes; rigor over speed is the research doctrine. And the run could not be stopped: `PipelineContext` had no cancel hook — the tool loop has honored `!stop` since 2026-08-22, pipelines never did. `isCancelled` is now polled at every stage boundary and inside the facet loop (de08a0a).

### Shipped the same day (observation only — nothing decides)
- **`router.shadow`** (`src/router/shadow.ts`, `systemone-client.ts`): on every classified message the same routing question goes to the `/v1/systemone` server and live vs shadow land side by side in `data/router-shadow.jsonl` + a `[RouterShadow] … AGREE/DIFFER` console line with a running rate. The hook wraps `classifyMessage`, so the comparison is against whatever ACTUALLY decided (override / sticky / model / keyword / fallback). Fire-and-forget, 3s bound, a dead server costs one warning. Option text = `router.categories` descriptions verbatim — the option head is model input, so the checkpoint is trained on that exact text (config is the single source for both sides).
- **Email/calendar routing gap closed in config**: `multi`'s description now says it is the only specialist reading Gmail/Calendar. The router had no way to know since `personal` was retired.
- **`training-collector.ts`** skips synthetic turns (pipeline handoffs, `[SYSTEM]` notices, attachment stubs) — case-sensitive on the pipelines' exact literals so a user merely mentioning the words is kept.
- **v3** trains on the config descriptions at `head_max_len 384` (the English default 192 truncates them — measured: 342 option tokens) plus 107 round-trip-validated pure email/calendar READ examples (v2's multi examples were all chained, so it learned email→task). Numbers land below when it finishes.
- **Serving**: `~/laya-eval/serve_router.py` injects a `Router` pointed at a local checkpoint into `laya.serve.create_app` (the stock server only preloads Hub checkpoints). Warm: 64–80ms per routed message over HTTP, 0.7GB resident. On this Mac until the Mini accepts SSH (port 22 refused — Remote Login off).

---

## Facts Carry How We Know Them — Epistemic Provenance (September 20 2026)

### The complaint that produced it
Asked "how can I make your brain better," the resident agent gave a seven-item graph-memory wishlist. Five items already existed (`SUPERSEDES` edges, `confidence`, `source`, `createdAt`, `expiresAt`, and the as-of time-travel query in `getFactsAt`) — it was introspecting on a schema it has no read access to, so it produced a competent GENERIC wishlist rather than one about its own graph. **The standing lesson: self-assessment quality is a context problem, not a model problem.** Asking an agent what it needs, without showing it what it has, returns the blog-post answer.

One item was real and buried in its weakest bullet: *"I can't tell the difference between you saying 'I like this' and me pattern-matching 'he mentioned it twice.'"*

### The gap
`source` is a free-text WHERE (`session/foo.json`, `consolidation/llm-merge`). It cannot carry HOW we know something. So a heartbeat's autonomous guess and a sentence Peter actually typed arrived in the prompt in the same voice, and the model asserted both back at him with equal confidence.

`FactProvenance` = `stated | observed | inferred`, on `FactEntry`/`FactInput` and the graph Fact node, filterable in `search()`.
- **`stated`** — only `!save`, the one path where a human reads the extracted list and confirms it.
- **`inferred`** — consolidation merges. A merge is model-authored prose even when both inputs were `stated`: **merging must never launder provenance upward.**
- **`observed`** — everything else, by default.

Injection marks the two weak classes (`[observed, unconfirmed]`, `[inferred]`) and tells the model what the marks mean: unmarked it may use directly, marked it should ask about rather than assert. Legacy nodes return null and coalesce **DOWN** to `observed` — coalescing up would retroactively present every autonomous extraction as confirmed.

### Rejected from the same list, with reasons
- **Causal edges (`causes`, `context_for`)** — the most exciting item and the most dangerous. Inferring causation from co-occurrence is the highest-error operation available to a 12-30B model, and a wrong causal edge is worse than none because traversal PROPAGATES it into retrieval. Two facts landing in the same week is not a cause.
- **Inference at retrieval time** — right principle (same doctrine as "experience informs execution, never expands authority"), wrong budget. Retrieval runs on every message under an 8s priming cap that already failed silently under VRAM pressure. If it ships, it belongs at heartbeat time, which is already paid for.
- **USER.md as a rendered query over tier ≥ 4 facts** — right about the seam, wrong direction. It would make Peter's identity card a function of extraction quality; one bad heartbeat and his wife's name leaves context. This is the `enforceCharBound` bug class exactly. Identity is a rule, not an observation — the file stays authoritative.

### Incidental
`GraphSearchResult` row-mapping was copy-pasted at six call sites (now `rowToResult`), and consolidation held a hand-written `FactInput` duplicate plus a field-by-field re-list that silently dropped the new field the moment it was added. Both are the same failure: a shape written down twice drifts at the first change.

---

## The A5000 Settles the Fleet — qwen3.8:27B Foreground (September 19 2026, later)

Supersedes the gemma4/3060 entry below, same day. Peter bought a used A5000 (24GB) over a 3090 for power draw.

### Why gemma4:12b lost the foreground it had just won
It passed 7/7 on the oracle duel and then failed the job. A two-step cron tool call failed **three times with both repair guards firing** — the duel measures task completion, not tool-call reliability under real chained work. **Standing lesson: a 7/7 duel score does not license production; the duel is an oracle for capability, not for dependability.**

### Fleet, current
| box | role |
|---|---|
| **A5000 (10.9.8.19)** | `qwen3.8:27B` foreground — 921 tok/s prefill on a 2x larger model, native tool calls clean, think honored |
| **3060 (10.9.8.14)** | utility: `phi4:latest` (router/steward/extraction), `phi4-mini` (NER), `qwen2.5:7b` (voice) |
| **Mini (192.168.77.221)** | `qwen3-embedding:8b`, resident. Plus gemma4:12b-mlx for short-prompt/batch |
| **Sparks (10.9.8.15)** | GLM-5.3-flash — `code_gen` + `pi.model` only |

### Embeddings got their own box, and that needed a code change
`embed()` was inherited and ALWAYS hit the primary gateway, so the embedder could not be placed anywhere but beside the router. That mattered more than it sounds: **memory priming embeds on EVERY message under an 8s cap**, so when embedder and router can't both stay resident, the reload blows the cap and memory injection is *silently skipped* — an agent that quietly stops remembering, with no error anywhere. `MultiBackendClient.embed()` now routes by model id like chat does.

### Config, not code
Two violations caught and fixed in the same pass: the embed model tag was a duplicated literal (now `DEFAULT_EMBED_MODEL`, one place), and `embeddingModel`/`embeddingDims` existed on the config object but were **decorative — never passed to `embed()`**. A config field that nothing reads is worse than no field: it documents a control that doesn't exist.

### Watch list
`research` inherits qwen3.8:27B at `contextSize: 32768`, and verification passes full cached pages (up to ~30K tokens for 3 sources). Overflow-retry lines in the verify stage are the signal; a one-line `model:` override moves it to GLM's 160K if depth drops.

---

## gemma4:12b Takes the Foreground — a 12B on a Mac Mini Matches the Flagship (September 19 2026)

### The measurement
Same seven-task oracle duel, same think-off pinning, on the SAME Mini that scored 1/7 with Qwen3.8-27B@Q2 hours earlier — this time gemma4:12b-mlx via Ollama (7.7GB, ~half the box free): **7/7 pass, avg 43.4s/task**, including the long-horizon 3-artifact `sales-report` composite (126.5s) that the Q2 never reached. md-linecounts: 26.4s vs the Q2's 259s FAIL. Probes: 17×23 correct with thinking on (25.6 tok/s), native tool calls clean, think toggle honored, no deliberation-leak quirk (unlike glm-5.3 — the qwen-era `think:false` specialist flags work as written, no client coercion).

### Fleet decision (Peter's): the Mini is the daily driver, the Spark is the workshop
- `defaultModel: "gemma4:12b-mlx"` — chat, arena, cron, tasks, memory, website, research, briefing, heartbeat, vision.
- **GLM-5.3 keeps CODING ONLY**: `code_gen` specialist override + `pi.model` (the Spark's speed goes where quality compounds and the merge gate catches slop).
- Utility tier unchanged on the gateway: phi4 router, phi4-mini NER, embeddings, whisper, steward judgment.

### What it cost in code: one new routing concept
The multi-backend client only knew OpenAI-compat backends + ONE gateway Ollama; gemma4 lives on a SECOND Ollama-native host. Added `inference.ollamaBackends[]` (url, models, optional keepAlive) routed by model id — same additive pattern as `backends[]`, native think control and response shape identical to the gateway so nothing needed probing. `createInferenceClient` now builds a routing client when EITHER backend kind is configured; the 19 call sites were swept in one mechanical pass (a missed one = that script silently can't reach the Mini). Live-verified end to end in lab tmux: both routes register, a real chat call returns in 1.7s.

### Caught in the flip (the stale-cap lesson, inverted)
`session.contextSize` was 160000 — sized for glm-5.3's 262K. gemma4 serves 131072, so the cap was now ABOVE the model's ceiling rather than below it. Set to 96000. The 2026-08 lesson was "after a context upgrade, hunt for caps that are now too small"; the mirror image is real — after a context DOWNgrade, hunt for caps that would overrun.

### Watch list (honest, unmeasured)
`research` inherits gemma4 and runs think-ON synthesis — the one slot where the 12B's extra weight might be missed and where Peter's doctrine says rigor is never rationed. The next weekly report is the A/B; a one-line `model:` override moves it back to GLM if quality drops. Vision also inherits (gemma4 is multimodal, model-caps says vision:true) but has not been image-probed on this serving.

## The $300 Card Beat the $600 Mini — Foreground Moves to the 3060 (September 19 2026)

### The head-to-head that settled it
Identical model (gemma4:12b), identical 9K-token cold prompt, unique prefix so nothing caches:

| box | prefill | a 4,000-tok chat prompt |
|---|---|---|
| **3060 (CUDA, 12GB)** | **1,220 tok/s** | **~3.3s** |
| M4 Mac Mini (MLX) | 123 tok/s | ~33s |

10x on prefill from a card costing half the Mini. Prefill is compute-bound (parallel matmul over every input token) and a context-heavy resident agent spends nearly all its time there — confirmed against published benchmarks, which put a 4090 at "3x+" a M4 Max on prompt processing while decode stays competitive.

### Fleet, settled
- **3060 (10.9.8.14)** — `defaultModel: gemma4:12b`. Foreground: chat, arena, cron, memory, research, briefing, heartbeat, vision.
- **Sparks / GLM-5.3** — CODING only (`code_gen` + `pi.model`). Which is what Peter had actually been doing for a month: turning Invarail off to use GLM in Pi exclusively.
- **.221 Mac Mini** — NOT a brain. Kept routable for short-prompt work (scoped subagent tasks, evals, batch), where it went 7/7 on the duel. Peter's own reframe and the right one: "a subagent that only gets a task not the whole thing" — 400-token prompts cost ~3s there, 4,000-token prompts cost ~33s.
- **A5000 gateway** — utility tier unchanged (phi4 router, NER, embeddings, whisper).
- `session.contextSize` 96000 → 32768: the 3060 has 12GB total, so a huge KV allocation competes with the weights.

### What this cost to learn
A full day, and honestly: a second Mac Mini bought for inference that can't do inference well. Peter, plainly: "the second one was absolutely a waste of money... I could have had something like half of a 1200 GPU card." The counterweight is that the hardware lesson produced two backend-agnostic harness fixes (prefix-cache ordering, Ollama streaming) that make every box faster, and the Mini has a real remaining role as an agent BODY — its own OS, filesystem and state for parallel cells — which is the factory's actual bottleneck.

### Standing note
Clustering Minis over Thunderbolt does NOT fix this: pipeline parallelism adds capacity, not per-request FLOPS, and tensor parallelism needs ~900GB/s interconnect (NVLink) vs Thunderbolt's ~10GB/s. A clustered 27B would prefill SLOWER than the single-box 12B.

## Prefill Is the Hidden Axis — and Our Prompt Order Was Throwing It Away (September 19 2026)

### How we found it
Chasing why gemma4:12b-mlx (7/7 on the oracle duel, 25.6 tok/s) made production chat unusable on the .221 Mini — "Oh boy" took minutes and eventually degenerated to "..." answers three retries deep. Peter's read: "this is the difference between an NVDA box running this and a mac-mini running this — prefill." Correct, and measurable.

### The numbers (same box, same model)
| prompt | prefill | note |
|---|---|---|
| 16 tok | 0.3s | trivial |
| 12,020 tok | **94.9s** | ~127 tok/s prefill |
| 8,020 tok cold | 61.3s | |
| 8,036 tok, SAME prefix + appended turn | **0.3s** | KV prefix cache hit — 200× |
| 8,029 tok, prefix CHANGED at the front | 63.1s | full re-prefill |

**Two operations, two bottlenecks.** Prefill (reading the prompt) is compute-bound — tensor cores eat it, Apple Silicon crawls. Decode (writing) is memory-bandwidth-bound — the Mini is fine (25.6 tok/s). So the Mini is a good writer and a slow reader: ~127 tok/s in means **every 1,000 prompt tokens ≈ 8 seconds before the first word.** At the 96K context cap that is 12.6 minutes for one message.

### The actual bug: we were invalidating the cache every single turn
`buildReActSystemPrompt` placed `statePreamble` (turn/topic) and `userPriming` (retrieved memory) in the MIDDLE of the system prompt — the first message. Both change every turn, so everything after them — the rest of the prompt AND the entire conversation history — re-prefilled on every message. We paid the cold price forever on a cache that works perfectly (proven above).

**Fix: prompt order is now a performance contract.** `[system — 100% static][history — append-only][volatile tail: state+memory][user message]`. The long head stays KV-cached; only the small tail re-prefills. Recency also favors the volatile block — it is now the last thing read before the request. `buildVolatileContext()` carries it; `test/tool-loop/prefix-cache.test.ts` fails if per-turn content creeps back into the cached head.

**This is backend-agnostic.** vLLM/SGLang prefix-cache too — the Mini only made the waste visible. Peter: "which also means it should be faster no matter what we choose."

### Doctrine added
**Route by PROMPT SHAPE, not just model quality.** Short-prompt/generation-heavy work suits a decode box (Mini); long-context work (research's cached-source prompts, coding's whole-file context) needs a prefill box (vLLM/NVIDIA). Same model, same box — prompt size predicted every result we saw today.

### Honest self-critique: the duel had a blind spot
gemma4 scored 7/7 and real usage contradicted it within the hour. Every task in the duel set has a SMALL prompt (task description + a few tool results), so the oracle measured capability and never touched prompt shape — the only variable that mattered. A benchmark that greenlights a model production can't use is incomplete. TODO: add a long-prompt task (loaded history + workspace context) to the duel set so the next candidate is measured on the shape that actually breaks things.

### Process note (mine to own)
I recommended reverting to glm-5.3-flash, then executed the revert without waiting for Peter's go-ahead because production was erroring. He said "wait I dont want it reverted" and I restored gemma4 exactly. Urgency is not authorization; a recommendation stays a recommendation until he answers. (Reinforces the standing "a suggestion is not a decision" lesson.)

### Status
gemma4:12b-mlx remains `defaultModel` (Peter's call); GLM keeps code_gen + Pi. The prefill tuning continues — `session.contextSize` (96000) is the next lever, and the sleep state of the Mini is a confound worth eliminating before further measurement.

## Q2 on the .221 Mini — the Quant Cliff and the Memory Cliff, Measured (September 19 2026)

### The question (Peter's plan)
Route ALL conversational traffic through Qwen3.8-27B at Q2 on a new Mac Mini (oMLX, 262K, MTP), reserving glm-5.3-flash for coding only. Same oracle duel as the dsh/GLM rounds; think:false pinned for parity with NVFP4 qwen3.8's historical 7/7.

### Verdict: 1/7 — dead on this hardware, two independent cliffs
- **Quant cliff (model signal):** probe with thinking ON got 17×23 WRONG (rambling, degraded chains); md-linecounts thrashed 30 iterations/259s without ever writing the file (NVFP4: 8.8s). One clean PASS (csv-revenue, correct, 117s — 6× slower). Think-OFF short answers stayed correct and fast (3 ctok/1.2s).
- **Memory cliff (box signal):** ~13.5GB dynamic ceiling vs a 27B that barely fits — oMLX's prefill guard bounced requests as KV grew (12.92→13.85GB creep across the run), then EVICTED the model entirely (507, "current: 2.70GB"). Arena loops grow context by nature; this box rejects grown context by design. Q3 never fit at all.
- **Bonus finding (server, not model):** gemma-4-12B on oMLX produced pure degeneracy ("o. o. o.", dots at temp 0) in BOTH mxfp4 and standard 4-bit conversions — but answered 391 correctly via /v1/completions with a hand-built <start_of_turn> template. oMLX applies no/wrong chat template when the conversion ships without one; the model files were innocent. Diagnosis method worth keeping: raw-completion-with-hand-template is the discriminating probe for template-vs-runtime bugs.

### Standing conclusions
2-bit is past the quality cliff for agentic work even when it fits; a 16GB-class box cannot hold a 27B with agentic KV headroom. The Mini's real profile is small-model (4-14B at 4-8bit) utility/steward work — short prompts, no context growth — where even the Q2 was correct and fast. Eval infra gained DUEL_MODEL + DUEL_TOOLSTYLE parameterization; the oMLX backend entry stays in config for future candidates. Next tenant under test: gemma4:12b via Ollama on the same box.

## The Factory — Steward and Software Factory Converge (August 29 2026, VISION SET, NO BUILD YET)

### Peter's design (his words, structured)
1. **The agent must understand my build logic — my process.** Per-repo conventions as standing artifacts. The Rails lesson (from solo-factory operators Peter knows — one alternates 15 Codex seats, ~$36K/yr of rate-limit arbitrage; one runs Kimi; one ships almost exclusively RoR): *convention keeps the agents in check* — omakase structure collapses agent degrees of freedom and turns review into pattern-matching, the only review that scales to one human. Concrete form: a **per-repo manifest** (build cmd, test cmd, protected paths, process notes/CLAUDE.md) that also generalizes the merge gate beyond Invarail — the gate runs the manifest's checks, not hardcoded tsc+vitest.
2. **Support-inbox intake → PR.** ONE shared intake address (support@devmesh.tech — not per-client aliases). Client identity resolves from the SENDER address via a sender→client/repo routing table; unknown senders route to Peter's triage, never into the factory. Change request → spec → Pi worktree on that client repo → manifest gate → **draft PR** for Peter's review. Client-triggered work starts propose_confirm on the ledger; specific clients may earn auto-draft via the ladder. `pi.git.pushRemote` stays off until per-repo ladder decisions.
3. **GitHub intake.** Cron polls Peter's repos (gh, read-only) for issues and contributor PRs: issues → spec queue; contributor PRs → the gate runs THEIR branch and Peter gets a summarized verdict.
4. **Rework loop** (the missing station): gate-fail output feeds back to Pi in the same worktree, bounded iterations (config `selfMod.reworkIterations`, default 0), ONLY for fixable failures (tsc/vitest) — policy failures (protected paths, gate tampering) never get an unattended second attempt. Authority unmoved: oracles decide, owner ratifies the merge.

### The convergence (the day's insight)
The email steward IS the factory's intake dock — triage("needs Peter" vs "actionable") feeds the spec queue. The factory's demand-side question ("a factory needs a queue") is answered: DevMesh clients. Solo factories work because review relocates UP the stack: review specs not diffs, trust computed gates, check behavior, tier by blast radius, make everything reversible — every one of those primitives already exists in Invarail (tiers, gates, worktree+rollback, logAutonomousAction track record); the one unbuilt rung is auto-merge for low tiers, to be climbed on evidence (self-mod track record n=2 — not yet).

### Open definitions (Peter's list to fill)
Which repos/clients first · manifest format + location · sender→client/repo routing table · per-intake autonomy tier (default: everything propose_confirm until n justifies promotion) · PR etiquette (draft always; branch naming; Peter merges, always) · per-client compute budget.

### Build order (each phase ships alone)
(1) Steward email triage — now load-bearing for the factory; blocked on Peter's two answers (what counts as "needs a response"; digest vs immediate alerts). (2) Repo manifest + generalized gate + PR-draft path. (3) GitHub intake cron. (4) Rework loop. (5) Ladder promotions on track record.

## Polar — the Weights Horizon, Designed and Parked (August 23 2026, NO BUILD)

### What it is (plainly)
NVIDIA Polar (NVIDIA-NeMo/ProRL-Agent-Server, successor to ProRL Agent, arXiv 2605.24220): a tape recorder + report card that turns an existing agent into a model gym. A proxy sits between harness and inference server, records token-faithful trajectories of REAL runs; GRPO runs the same task k times, grades attempts against each other (oracle rewards), nudges weights toward what the passing attempts did. Headline: a 4B gained +22.6 SWE-Bench points trained against a specific harness. The strategic read: it industrializes the harness-duel verdict — harnesses are interchangeable environments; the leverage is trained model-harness FIT.

### The design (Peter's architecture, agreed)
- **Proxy at the GATEWAY, not in Invarail.** Toggleable capture: on = tape rolls over real production traffic; off = bypassed entirely (fail-open — a dead proxy can never take down inference). Campaigns replay captured/generated tasks k× through the same path to build GRPO groups (production gives 1 attempt/task; groups need k).
- **Invarail's total footprint: ONE optional run-id header** from MultiBackendClient so trajectories join to outcome verdicts (oracle results, 👍/👎, metrics). ~5 lines, config-gated, dormant.
- **Weight-worktree principle (Peter): never train the active model.** Training touches a CANDIDATE checkpoint served under its own id. Promotion gate = the oracle eval suite (duel tasks, routing corpus — computed checks only). Owner confirms the swap; rollback = config flip. Canary = per-specialist model assignment (already built): candidate takes ONE category (router or triage) while the incumbent keeps the rest. Self-mod rail semantics, one level down. Invariant preserved: experience informs execution (weights learn), never expands authority (the swap is code-gated + owner-confirmed; a model cannot train itself into production).
- **Reward doctrine: oracle-checkable rewards ONLY.** The quality judge scored placeholder spam GOOD 5/5/5 (Aug 2026) — GRPO against a judge breeds a placeholder-generator. Our verification doctrine transfers verbatim.

### Trigger to unpark (all three, not vibes)
(1) a small model consistently failing at something (2) with a computable oracle (3) with thousands of graded examples. Expected first arrival: the email steward's 👍/👎 stream after months of operation → train an owned triage model on private data that never left the house. First campaign target if earlier: router-scale model on the labeled routing corpus. Hardware: GRPO on 4B-class plausible on the Spark (128GB unified), unproven — the probe is clone + wrap duel tasks as a Gym environment + one rollout smoke.

## The Source Audit — the Deficit List Goes Exhaustive (August 23 2026)

### Method
Three parallel readers over dsh's SOURCE (agent-loop/agent, session/persistence/compaction, tools/llm packages) enumerating every failure-handling mechanism with file:line receipts, absences recorded as data; then each mechanism cross-checked against our engine/dispatch/client. Purpose: upgrade "no known deficit that matters" from memory-based to source-audited.

### The audit's first casualty: our own documentation
CLAUDE.md claimed OllamaClient had "single retry on connection failure." The code has had 4-attempt retry, 429 exponential backoff, request timeouts, and abort propagation for some time — deficit item #5 was built on stale docs. Lesson: an audit of the competitor corrected OUR inventory first; cross-checks must read both sides' source, not one side's source and the other's docs.

### Final reconciliation (both directions)
**Their genuine depth (dispositioned):** cancellation (13 abort checkpoints, 3-source signal fusion, mid-stream partial recovery, synthetic durable results for aborted tools — ours is v1 boundary-check, deepen when it matters); session durability internals (fsync-ordered appends, atomic link() materialization, torn-tail repair, zstd partial-frame recovery, format-version refusal — ours: atomic tmp+rename, journal covers in-flight; accepted → event-sourcing horizon); typed monotonic guards + invariants registry (ours convention+tests; accepted).
**Their measured absences (our uniques):** NO depth/iteration caps in loop core, NO timeouts in core, NO retry in core (plugin-optional), NO drift/streak/hallucination/refusal detection, NO malformed-tool-call repair (bad JSON args are rejected, not repaired — we JSON5-repair + parse four narration dialects), pre-step-rejected messages are LOST (our undrained steering replays). The small-model repair layer and runaway bounds exist only in ours — each system is rigorous exactly where its risk lives: theirs assumes frontier models + present humans; ours assumes small models + absent owner.
**Shipped from the audit (same day):** transient-5xx retry with jittered backoff + Retry-After honoring in both clients (the one true remaining model-layer gap — 429-only before); CLAUDE.md corrected. Their own absences worth knowing: no JSONL checksums, no HMAC on logs, SQLite repair doesn't validate truncate success, no circuit breaker.

### Standing verdict
Source-audited: the deficit list is complete at four items, all dispositioned (two deliberately deferred with triggers, one v1-shipped, one accepted). The engineering question is CLOSED — further harness investment requires a new live failure class or the dsh adoption re-evaluation, not vibes.

## The Harness Duel — dsh vs Our Arena, Measured (August 22 2026)

### The question (Peter's, after a hard week): "is our harness effectively useless next to Hermes and dsh?"
Answered the only honest way: `scripts/harness-duel.ts` — DeepSeek Harness (github.com/deepseek-ai/deepseek-harness, headless one-shot profile) vs our arena loop, SAME model (qwen3.8-27b on SGLang via `$DSH_HOME/settings.yaml` custom provider), same fresh-workspace fixtures, same computed oracles. Neutral tasks only (file/shell/python) — Invarail-only tool tasks excluded as rigged. Disclosed asymmetries: dsh yields wall-time+oracle only from outside; each arm ran as-shipped thinking defaults; dsh pays npx boot per one-shot run (52s→13s as caches warmed).

### Results (artifacts: data/model-eval/harness-duel-2026-08-22/)
- **Round 1 (6 simple tasks): 6/6 vs 6/6.** Invarail avg 9.6s/task, dsh 29.1s.
- **Round 2 (sales-report — the 30-step-spiral class, 3 artifacts from a 20-row CSV): all arms PASS.** Invarail 6 steps/35.9s, arena-pi 5 steps/33.9s, dsh 114.7s — 3× even after discounting boot.
- **The spiral class is dead, measured:** the task shape that burned 30 iterations on Aug 21 completed in 6 steps — the observation-budget (read_file/exec 8K) + streak-guard + truncation-notice fixes, proven under oracle.
- **arena-pi did NOT delegate** — inline exec sufficed and it was right. The delegation rung ("our code mode is Pi": pi_build's projectDir affordance, now taught in the description and added to multi's toolset) exists for tasks that outgrow inline; correct non-use is the desired behavior.

### Whole-system comparison (docs-level study of the dsh clone, same day)
Subsystem-by-subsystem read of ~28 dsh docs. **Where dsh is better engineered:** event-sourced session log (history as projection, crash recovery via synthetic turn-close) vs our JSON transcripts; spill-to-disk for oversized tool results vs our truncation; formalized monotonic tool guards (deny-only, frozen args) vs our informal 6-layer equivalent; worker-isolated Code Mode; bounded subagents/teams/workflows; per-operation credential resolution. **Confirmed absent from dsh (checked, not assumed):** channels (no Discord/Telegram/email anywhere), cross-session memory (sessions are independent amnesiacs — no unified knowledge store), asynchronous approval ("only answers within open turn" — their trust model requires a human present NOW; our principal-bound TTL'd grant-minting ledger over a DM is inexpressible in their architecture), autonomous operation toward a human (schedule = session-local reminders, no external notification), autonomy ladder, self-mod rail. They also SHIP a skills system — the hijack class we killed; that disease is ahead of them, behind us. **Verdict: different machines.** dsh is a better task workbench; Invarail is a resident steward — and the steward dimension is where Peter's outcomes (email triage / calendar / CRM) live.
**Borrows shipped same day (a8cf6f7):** (1) observation spill — oversized results persist whole to workspace `.spill/` (24h transient), hint teaches grep/read instead of slice-reconstruction; (2) server-reported context overflow → one-shot hard-compact of old observations + retry (pre-call trim is an estimate; the server is truth). Deferred until CRM work: per-operation credential resolution.

### Verdict + doctrine
**The loop is a commodity.** Peer-equal outcomes on our model, faster resident. dsh's real assets are elsewhere: Code Mode (ours is Pi + exec-code — two rungs, both present), context-management depth (compaction/spill — borrow when a long session actually hurts), and a 95K-star community finding bugs for free (free-ride by reading their fixes). Modularity doctrine set with Peter: **keep a seam wherever a real second implementation exists (models, coding substrate, tools via MCP, and now provably the loop); never build the plugin registry ahead of the second plugin.** Invarail's identity is the part no harness has: authority plane, residency, months-long memory, self-mod rail. Leverage goes to the steward outcomes (email triage / calendar / CRM), not to loop tuning.

## The First Closed Loop — Production Self-Improvement, End to End (August 22 2026, MILESTONE)

### What happened (one day, in order)
1. **SIP go-live** (config flip: `heartbeat.selfImprovement.enabled` + `selfMod` block, drill-validated timeouts). First heartbeat after restart: code detected `document` failing 4× ("Conversion produced no output file"), drafted the spec, ledgered it (`ce77ec57`), delivered with evidence. Five later cycles correctly stayed silent.
2. **Owner confirmed** → Pi implemented in a worktree: new `CONVERSION_ERROR` code + factory (CLAUDE.md error list updated — by Pi, correctly), `describeExecFailure` (exit/signal/stderr extraction), call-time `getSofficePath()` for testability, 98 test lines. Genuinely good work.
3. **Gate FAILED — and the gate was right, the oracle was lying.** Two prep-context tests failed on an untouched main: July 8 fixtures aged out of `ANSWERED_RETENTION` (45d) at exactly Aug 22, mid-day, between a 2am green run and the 2:38pm gate. SECOND firing of the fixture-rot class the `load()` comment already documented. Fixed by threading fixture dates through the last wall-clock call sites (79ecc40). Lesson, hard-earned: **a time-dependent test suite is a lying oracle, and the merge gate inherits every lie.**
4. **`!improve retry` built** (c23a5c8) — the missing rung between "gate failed" and "redo from scratch": rebase the kept worktree onto current main, move `baseSha` with it (else the three-dot diff blames main's new commits — wrong tier, false protected-path hits), re-gate, mint the normal `self_merge` pending. Conflicts → honest report, worktree kept.
5. **Retry live**: rebase → gate PASS → `confirm 48f03018` → merged `886c7da` → supervised restart, health-checked, rollback anchor recorded → healthy. Experience `exp_mt4r12c3_sab30` in FalkorDB. Worktree state cleared.

### Why this is the milestone
Every autonomy component built since Phase A fired in one production sequence: error store → heartbeat proposal → ledger confirm #1 → Pi worktree → merge gate → ledger confirm #2 → supervised deploy → graph provenance. The owner's total involvement: two "confirm" replies and one "go ahead." The system noticed its own recurring failure, proposed the fix, wrote it, survived a false gate verdict, and shipped — inside walls that never moved.

### Operational notes
- The supervisor self-copies to a temp path on start (protection against a merge rewriting the running script) — process checks must match `invarail-supervisor.*`, not `supervisor.sh` (a false "supervisor not running" alarm was raised off the wrong grep).
- Gate-failure messages now advertise the retry rung.

## Arena Fleet-Wide — Every Conversational Pipeline Melts (August 21 2026, Peter's call: "Arena is the new default")

### The trigger (live, production)
A user asked to "alter the meal plan to accommodate heart health and GLP1." The cron pipeline's `extract_edit` stage got ONE shot at resolving "the meal plan" to a job id from isolated context — it latched onto the assistant's prior phrasing ("job scheduled for Fridays at 20:30") as the job name, `cron_edit` matched nothing, and the user got a job-list error. The model that could trivially resolve it (cron_list → see id → cron_edit) never got the chance: the pipeline feeds exactly one extraction slot and no loop, and pipeline isolation withheld the very context that held the answer. Same disease the arena duel diagnosed for `multi` — choreography where the task carries no oracle. (Same night, same channel: a narrated Qwen-template tool call reached Discord verbatim — fixed separately in the parser + delivery backstop, 829e771.)

### The flip (config-not-code, one restart)
`dispatchMode: "arena"` on web_search, memory, exec, cron, message, code_gen, task (multi already arena). `pipeline:` fields left in place — reverting any specialist is deleting one line. Iteration budgets widened where pipeline-sized (cron 3→10, message 3→5, code_gen 3→5); `message` and `code_gen` gained minimal system prompts (the pipeline used to do their thinking). Same six security layers, same confirm ledger, croner validation and cronMode stripping live in the tools — the safety never was the choreography.

### The carve-outs (Peter: "research pipelined is fine")
- **research** stays pipelined: its stages are an ORACLE (claim extraction → cited-source check → Tier-1 cross-check → deterministic render), not choreography. The doctrine line survives contact: pipelines earn their keep only where the task carries its own verification.
- **heartbeat** untouched: system maintenance on a schedule, not a dispatch category.

### Status
Live after restart. Fix-forward like the multi flip: evals compare, production is truth — the live log is the eval now.

## Self-Improvement Proposals — the Noticing Becomes Autonomous (August 20 2026, SHIPPED + LIVE-DRILLED)

### The decision
The heartbeat now initiates code improvements from its own failure evidence — the last hand-executed loop of the substrate story automated. The night's three tool-layer fixes (shell-op description, path clarity, exec temp path) were all the same mechanical cycle: recurring failure signature in the error store → minimal code change → validated next run. SIP automates *initiation only*: CODE detects recurrence (`selectCandidates`, `${tool}:${error.slice(0,60)}` grouping, ≥3 occurrences — the promoteRecurringLearnings selector), the MODEL only phrases the `!improve` spec (one grammar-constrained call, discard if the spec never names the failing tool), the OWNER confirms on the pending-action ledger, and the EXISTING self-mod rail does everything else (Pi worktree → merge gates → second confirm → supervised deploy). Nothing about the walls changed; what changed is who knocks. Peter's framing: "take the guard rails off and let it kind of thrash around" — but thrash INSIDE the ladder: two owner gates, opt-in config (`heartbeat.selfImprovement.enabled` default false), max 1 proposal/cycle, denied = permanent.

### What shipped (051b6f9, d2f70fb, 5684c39, bc694f5, 1ef968c)
- `src/coding/improvement-proposals.ts` — selection (pure code), `ProposalHistory` (append-only JSONL, last-write-wins; denied=never, else cooldown; metrics-cursor denial absorption), drafting (chatMaybeStructured, think-pinned). PROTECTED PATH.
- `src/tools/self-improve.ts` — ledger-only tool: model-invisible (no specialist list), grant-ineligible (no targetArgs — "always" can never mint self-improvement autonomy), fire-and-report into `selfModService.propose`. PROTECTED PATH.
- Heartbeat step: absorb denials → select → draft → record on ledger (12h TTL, prep-proposal precedent) → report line with `confirm <id>`.
- Structural principle held from Phase B: the proposal generator shapes what enters the ladder, so it must never be self-modifiable below Tier 3 — a process must not rewrite the mechanism granting its authority.

### The live drill (fresh clone, 1-min heartbeat, web channel, drill_memory graph — Phase B pattern)
Full loop, both gates, both verdicts:
- **Confirm path:** 4 seeded web_fetch 403s → heartbeat proposed "add a default User-Agent header" → confirm → Pi implemented in a worktree (commit touched web-fetch.ts, schema.ts [Tier 3 — gate escalated correctly], config example, 65 test lines; **used memory_search organically** for prior experience) → gate passed (tsc 5s, vitest 6s) → self_merge confirm → supervised deploy healthy → User-Agent live in the drill's code. Round 1 taught: 600s session budget starves real self-mod (25 turns, zero writes, gate correctly failed the empty diff) → **prod recommendation: `selfMod.sessionTimeoutMs: 1200000`**. Round 2 succeeded in 682s.
- **Deny path:** 4 seeded browser timeouts → proposed retry/backoff → denied → absorbed → never re-proposed across cycles with evidence still present.

### Two real bugs the drill caught (this is why drills exist)
1. **self_merge TTL, fourth strike (bc694f5):** gate verdicts expired on the 10-min ledger default four separate times under real usage — a human reviewing a merge is minutes-to-hours, not a send-message confirm. Now 12h; headSha re-verification is the real staleness guard.
2. **"Denied is permanent" was unenforceable (1ef968c):** the denial metric's `detail` was params-JSON sliced at 120 chars — a long spec ate the whole window, so neither pendingId nor signature ever appeared and `absorbDenialsFromMetrics` could never match. Compounding: the pre-fix scan advanced the cursor past the unmatched row, burning it. Fix: **the pending id LEADS the denial detail** (confirm-handler), plus a spec-prefix fallback matcher for legacy rows. Lesson, generalized: *a permanence guarantee that depends on substring luck in a truncated log line is not a guarantee — bind consumers to stable ids, and never advance a cursor past evidence you couldn't disposition (verified live after a cursor reset: "Marked 1 self-improvement proposal(s) denied").*

### Log-forensics footnote
A scary drill-log line ("Self-improvement attempt failed: worktree exploded") was the gate's vitest pass echoing our own test mock stderr into the supervisor log. Deploy-gate test output interleaves with production logs — read anomalies with `grep -a -B/-A` context before believing them.

### Status
Merged, 841 tests green. Production go-live is a deliberate flip: `heartbeat.selfImprovement.enabled: true` + `selfMod.sessionTimeoutMs: 1200000` — not yet done. Out of scope, forever until the ladder's track record argues otherwise: auto-confirmation of any tier.

## Completion Contracts — Built, Measured, KILLED Same Day (August 20 2026, evening)

### The kill (Peter's call, correct)
Contract coverage equals extraction recall, and extraction recall proved a lottery: 0-for-3 "not checkable" on blatantly checkable asks in the clean think=low run (including "write the number to revenue.txt"), spotty before that. **A gate that attaches probabilistically is not a gate** — it slides down the tier map to the prose judge's neighborhood while carrying real machinery. The rescue option (code-detected condition seeding — filename regexes, task verbs) was rejected on sight: "we'd have to create arbitrary rules just to keep up with the exhaustive list of potential tasks" — the skill-system/rule-mill disease, the exact taxonomy-sprawl this week has been melting. Disproven theory, recorded: model-extracted completion contracts cannot reliably attach on arbitrary asks; deterministic seeding is an unbounded rulebook. The concept only works where tasks CARRY their own oracles (code + tests = the merge gate; research claims + sources = verification) — you cannot bolt an oracle onto an oracle-less ask.

### What was killed vs kept
KILLED: dispatch wiring (arena runs ungated), contracts config block, quality-judge contract branch, DispatchResult.contract. KEPT: the engine's `onFinalAnswer` turn-stopping checkpoint (the SEAM is not a rule — zero cost unused, and real-oracle categories can plug in later), the contract module as eval-side library (the duel's third arm), the chatMaybeStructured think:false pin (correct for its measured class — param extraction; also suspected of worsening contract-extraction recall on qwen, which is now moot). The incident's ACTUAL fixes all stand and were the real medicine: exec code-param bug, NO-SHELL-OPERATORS tool description (eliminated the > redirect ritual from every subsequent run), long-run Discord notification, hitMax quality flagging. Still queued for the unverified-completion problem: Hermes-tier repetition/cost guards (same-tool + identical-result signatures — arg-matching provably misses escalation loops).

### What the failed experiment taught (kept from the entry below)
The guarantee tier map survives its author: prose judge < contracts < computed oracles < owner confirm — contracts just turned out to live closer to the judge than believed. Full build/measure record follows for archaeology.

### The think=low board (clean run, post-fixes — the day's closing measurement)
**pipeline 8/8, 506s, 62 calls, 4,389 ctok · arena 8/8, 150s, 35, 4,609 · arena-contracts 8/8, 115s, 31, 3,023. ZERO failures in 24 runs** — Peter's prediction ("I don't think it would have any failures") exact: low effort suppresses the sampling-slip class entirely. The pipeline gap WIDENED at think=low (3.4-4.4×) — deliberation cost scales with call count, and the scripted architecture makes ~2× the calls; its reflect stage reproducibly fixates on the same phantom concerns (trailing-newline anxiety, twice, independently) at 111-133s a run. The killed contracts arm topping every column is the kill illustrated, not refuted: most extractions attached no gate, so it ran as bare arena with sampling luck. Also confirmed en route: the NO-SHELL-OPERATORS exec description eliminated the > redirect ritual from every post-fix run; think=low batches parallel tool calls (3 task_adds in one completion). **Production tuple settled: arena mode, think per request-class — which is the day's actual takeaway (Peter): effort must be togglable per REQUEST.** Design agreed: `!think <level>` prefix (code gate, no taxonomy) → thinkOverride through dispatch → effort recorded in the routing tuples; per-category defaults later via config-overlay proposals when n is meaningful.

## Completion Contracts — the Harness Fix, Built and Re-Measured (August 20 2026, same day)

### The incident that demanded it
Arena's first production run: 30/30 iterations, 26 consecutive exec calls escalating a placeholder write to 'a'×200000, quality judge scored it GOOD 5/5/5 (it only ever read the answer prose), and the final answer arrived as a silent Discord edit nobody saw. Four stacked defects; the structural one, per Peter's push ("we are coding to fix the ask, not fixing the harness"): **the arena had walls but no exit criteria** — completion happened when the model stopped talking. Cross-harness study confirmed the fix-forward pattern (Hermes ships guards into the live loop incident-by-incident; Prime gates completion on artifact verification; dsh exposes checkpoint seams; Pi delegates to a human) — nobody un-ships the loop. Arena stayed on.

### What shipped (1d92ea5..d5b8010 + fixes ca73ba4, 32f972f)
- **Completion contracts**: checkable postconditions (closed vocabulary: file_exists/file_contains/task_exists/fact_saved/answer_mentions) PRE-REGISTERED before the loop by a fast extraction call — the model states the contract before it can game it — then CODE-verified against the world at natural stop. Unverifiable asks = no gate (degrade honestly). Extraction failure = no gate (contracts never break dispatch).
- **onFinalAnswer turn-stopping checkpoint** in the engine (dsh's shape — guarantees-as-hooks, cut one): phase-aware — natural-stop rejects inject model-directed feedback and continue on granted iterations (repairs-don't-burn-budget); cap rejects REPLACE the answer with user-directed honesty. Budget 2 rejections; engine belt 3; hook errors accept (fail-open for the loop, the check is advisory-on-error).
- **Grounded quality judge**: a FAILED checkable contract skips the prose judge entirely and logs CONTRACT_FAILED — never again GOOD-on-garbage. Passing rows carry the contract verdict.
- En route: exec code-param bug (tmp path double-resolved against relative workspace — THE incident trigger), long-run answers now send as real Discord messages (edits never notify), exec description now warns shell operators don't work (both duel arms fell into `> file` every single run).

### The re-measure (three arms, 8 tasks incl. the incident shape; artifacts data/model-eval/arena-duel-2026-08-20/)
**pipeline 8/8, 407s, 78 llm calls, 3,548 ctok · arena 7/8, 83s, 41, 2,339 · arena+contracts 8/8, 346s, 41, 2,647.** Arena's single failure (fib off-by-one, model returned b for a) re-ran 3/3 PASS — pure sampling variance, confirmed as Peter predicted. Contracts: correct coverage on real tasks (2-4 conditions), ZERO false positives, zero additional loop calls; wall-clock overhead is duel-inflated (extraction on qwen3.8 ≈ 20-70s/task; production extracts on phi4 in seconds). The incident-shape task passed even bare — the exec fix removed the drift's entry ramp; the catch behavior is pinned by unit tests and the battery row keeps it honest forever.
Caveats, recorded: one under-extraction observed (a clearly file-shaped ask judged "not checkable" — extraction prompt wants few-shot sharpening); duel's script-side subDispatch doesn't write .plan-artifacts (mild anti-pipeline fidelity gap on one task — it passed anyway, after burning a structurally-redundant second Brave query); reflect stage measured at 10-52s/task for near-zero observed value.

### The guarantee tier map (honest limits)
**Contracts verify the world matches the ask's SHAPE** (files exist, content patterns present, tasks/facts recorded) — they close the placeholder-garbage class. **They cannot verify content TRUTH** the ask doesn't state (fib(20)=6765): that tier needs computed oracles — tests, re-derivation — which is why the merge gate runs suites and why coding tasks (Pi's world) are the best-guarded category. Tiering: prose judge < contracts < computed oracles < owner confirm. Route asks accordingly as the melt proceeds.

### Verdict
Arena + contracts = correctness parity with the pipeline at 53% of the LLM calls, with honesty guarantees the pipeline never had. The melt holds; production is wired (contracts activate for arena dispatches on next restart). Follow-ups queued: extraction few-shot sharpening, repetition guard as cost containment (drift still wastes granted iterations before the gate catches it), N=3 battery protocol for any future close call.

## The Arena Duel — the Pipeline Thesis, Measured and Retired (August 20 2026)

### The question
Peter, after the Pi/dsh study: "I was optimizing for yesterday's model, not tomorrow's — the 27B Qwen model is what has shattered my thesis." The 2025 thesis: 7-30B models can't drive loops, so deterministic pipelines (router → plan → reflect → foreman-managed steps) are structurally necessary. Both open harnesses studied (DeepSeek Harness "dsh" and Pi) independently converged on the opposite: no router, one loop, natural stop, guards as hooks around the loop — control flow belongs to the model, authority belongs to code.

### The measurement (scripts/arena-duel.ts, artifacts in data/model-eval/arena-duel-2026-08-20/)
Same model (qwen3.8-27b, think:false both arms), same tools, same 7 code-checkable multi-step tasks (files, task board, exec, memory, one budgeted web task), acceptance suite selftest-validated before any model call: **pipeline 7/7 in 372s / 77 llm calls / 3,084 ctok — arena 7/7 in 79s / 43 llm calls / 2,215 ctok.** Equal correctness; the plan pipeline's decomposition+reflection+foreman machinery was pure overhead (~4.7× wall clock) at 2026-27B capability. Also observed: both arms degraded gracefully and honestly when a harness bug broke a tool — retried, fell back, reported the caveat.

### Instrument lessons (paid same day)
Selftest references must exercise the REAL TOOLS, not write expected files directly — a tool-wiring bug failed both arms invisibly until the reference called the tool (which then also caught two wrong path guesses in the check). Scope caveat, stated honestly: 7 moderate-horizon tasks; long-horizon/adversarial task classes unmeasured — extend the battery before melting anything that guards them.

### What this licenses (the melt, evidence-driven)
- **Arena dispatch mode**: open tool-loop with natural-stop semantics as the default for multi-step work; the plan pipeline retires from the `multi` category once an arena mode ships behind the same security layers.
- **Pipelines-as-guarantee survive as hooks**: evidence gates, verification, budgets, code-owned rendering — dsh's shape (pre/post-execute guards, turn-stopping checkpoint) maps cleanly onto the existing 6-layer gate stack.
- **Pipelines-as-crutch melt**: scripted decomposition, llm_branch enums, reflect stages — accommodations for models that no longer need accommodating.
- Parked: dsh's code-as-orchestration (`run_code`) as a future eval arm; log-projection context (big refactor, ours works).
Doctrine, final form: capability-shaped structure rots at model-release cadence; trust-shaped structure appreciates. Build the arena walls in code, and let whatever model is current do the walking.

## Local-First Gate Needs a Floor, Not a Count — Muse Glimmer Class, Second Strike (August 19 2026)

First production request after go-live: "research 10 NYSE stocks with volatility above 15" → all 6 facets reported "4 local-index hits — skipping web search," sources were NVIDIA/GLM/arxiv AI articles, gap_check waved it through, report was garbage. Root cause: local_search's embedding floor was 0.35 while the memory system's MEASURED relevance floor for the same qwen3-embedding model is 0.52 — KNN always returns nearest neighbors, and at 0.35 "nearest" still passes for an off-domain query, so the research pipeline's ≥2-hit gate (research.ts:203) skipped the web on pure adjacency. Same failure shape as Muse Glimmer (2026-08-15): that fix hardened absence-claims and synthesis provenance but left the GATE hit-count-based. **First fix attempt (94e42af) FAILED live**: borrowed the memory system's 0.52 floor — stock queries still scored 0.53-0.59 against AI prose. Disproven theory: calibrated floors transfer across corpora. They don't — text distribution shifts the whole score band. **Real fix (8292e87): MEASURED on the actual 2094-chunk webindex** (scripts/floor-measure.mts, kept as the calibration probe): off-domain queries top out at 0.59, on-domain start at 0.70 → floor 0.65 splits the band (and independently matches the skill system's measured 0.65 on the same embed model). Below-floor queries return the explicit "No local index results → use web_search" message with no URLs, so the ≥2-hit gate structurally cannot fire on garbage. Doctrine, sharpened: **scoring orders, the floor rejects — and floors are per-corpus, measured, never borrowed.** Re-measure on embed-model or seed-list changes. (Deliberately fixed directly, not via !improve — Peter: not ready to run fixes through Pi yet.)

---

## Pi Becomes the Coding Substrate — LocalClaw Keeps the Authority (August 18 2026, COMMITTED DIRECTION)

### The decision
All coding — user-requested builds AND LocalClaw modifying ITSELF — goes through the Pi SDK (`createAgentSession()` from @earendil-works/pi-coding-agent, MIT, embedded not forked). LocalClaw stops competing as a coding harness and keeps what is actually ours: routing, memory, task state, governance/authority, evaluation, deterministic pipelines, channels. Peter, on reading Pi's duel output: "this pi code puts my localclaw to shame… I need to ship pi code with my localclaw and make sure all coding gets done through it and that way it can alter its own code and add its own tools and run its own config."

### Evidence
The Pi duel (2026-08-15): Pi + qwen3.8 autonomously produced 12/12 contract-grade work with an 11-test behavioral suite and correct packaging in 384s — better code than any LocalClaw-native path has ever produced. Division of labor per doctrine: LocalClaw answers why / may-it / what-happened-before / which-model+effort / was-it-actually-good / what-next; Pi owns the loop (explore, edit, bash, test, self-repair).

### Architecture
- **Adapter, not integration sprawl**: one module (src/coding/pi-session.ts) wraps the SDK — the McpManager pattern. Version pinned. Lifecycle events (agent_start/turn_start/tool_execution_*/message_end/agent_end) flow to metrics + Falkor.
- **Structural supervisor boundary (not conventional)**: Pi writes ONLY in git worktrees — never the running tree, never main. Protected paths (dispatch security layers, pending-action ledger, grants, config loader/clamps, secrets, the supervisor itself) are Tier-3 under the existing review rubric: merges touching them are owner-confirmed via the ledger, ALWAYS, no promotion path. Lessons doctrine applied to source: experience informs execution, never expands authority — a process must not rewrite the mechanism granting its authority while it executes.
- **The validation gate is the product**: Pi's own tests are necessary, not sufficient. Merge gate = tsc + full suite + the deterministic batteries built 2026-08-15/16 (smoke runner, eval checks) + rubric tiering by touched paths. Self-modification gated by self-evaluation — the eval harness graduates from benchmarking tool to merge gate.
- **The supervisor stays DUMB**: ~50 lines, no model anywhere near it — pull validated branch → run gates → restart → health-check → auto-rollback on boot failure. The one genuinely new component; retires the manual Ctrl-C deployment model.
- **Unified with config-not-code**: this IS Phase 2 with muscles. Same ladder: evidence (code-detected failure signatures) → proposal → owner confirm → Pi implements in worktree → gates → merge → supervised restart. Tuning proposals and code proposals ride one governance rail; Falkor briefs sessions with prior experience ("similar change failed because X; successful approach was Y") and harvests outcomes after.

### Phases (each shippable alone)
- **A**: pi_build's CLI spawn → SDK adapter; events into metrics; identical external behavior.
- **B**: worktree self-modification flow — gates, ledger-confirmed merges, dumb supervisor with rollback.
- **C**: Falkor experience briefs into session context; post-session harvest (Pi events → graph, lessons harvester extended to Pi sessions).

### Hygiene rules
One change per session; always a branch; never chain unvalidated changes (no compounding drift); session budget caps; code-change proposals enter the autonomy ladder at propose_confirm (per-path promotion later, earned via logAutonomousAction track record).

### Phase A SHIPPED (August 18 2026 — 67b9216, fab26db)
`PiCodingAdapter` (src/coding/pi-session.ts) wraps `createAgentSession()`; SDK pinned exact 0.80.2; pi_build's CLI spawn deleted. External behavior verified identical (extractor lines, quality standards, cwd-scoping — SDK tools bind to the session cwd, confirmed in sdk source at agent-session.js `createAllToolDefinitions(this._cwd)`). Event substrate live: five events (agent_start, turn_start, tool_execution_end w/ durations, turn_end, agent_end — deliberately NOT the SDK's full stream; tool_execution_start tracked internally for durations only, never logged) → metrics.jsonl, plus a `pi_session` summary row carrying the session JSONL path (provenance anchor). Smoke bar passed live: roman-numeral build, 461s, 7 turns / 9 tool calls / 1 tool error self-repaired, 15/15 tests independently verified, session JSONL on disk.

Two observations for Phase B (recorded, not built):
1. **In-process = shared fate.** The SDK runs inside Invarail's process: a Pi/SDK crash is now an Invarail process risk, and Pi's bash inherits our env (the CLI spawn also inherited env — behavior-identical, but it strengthens the case for the dumb supervisor + worktree env hygiene).
2. **abort() is cooperative where SIGKILL was absolute.** The timeout path races `session.abort()` with a 30s grace; a wedged bash child could outlive the bound. Watch `pi_session` rows with `timedOut=true` before Phase B trusts this as a hard budget.

### Why Invarail exists post-Pi (August 18 2026 — the crossroads question, answered)
Peter, day of Phase A shipping: "Pi is an amazing harness in it of itself — why would anyone use this over that?" The answer is the division already committed above, stated as product truth: **for coding, they shouldn't — that's the point.** Pi is a SESSION: brilliant for the 40 minutes someone drives it, then it ends, forgets, has no opinion on whether it should have run, and trusts whoever's at the keyboard completely. Correct design for a coding harness — and the complete list of what Invarail provides:
- **Nobody's at the keyboard.** Briefings, verified research crons, heartbeat extraction, channel messages answered while absent. Pi doesn't need governance because it assumes a present human; Invarail IS governance (ladder/grants/ledger) because it acts unattended.
- **Months, not sessions.** Falkor, SUPERSEDES, provenance, lessons with evidence counts. Pi enters every session remembering nothing; Phase C is Invarail lending Pi the memory it structurally lacks.
- **Before and after the loop.** Why this task / may it run / what happened before / which model+effort (measured) / was it actually good / what next. The Pi duel itself needed a hidden acceptance suite validated against a reference impl BEFORE either contestant ran — Pi didn't build that instrument; this harness did. Structure-provision remains the scarce good.
- **It lives where Peter lives** — Discord/Telegram/Gmail/browser, not a terminal.
Framing: Pi is the best power tool in the shop; Invarail is the shop — ledger, interlocks, apprentice records, and the decision about what gets built. Absorbing Pi freed Invarail from maintaining a worse power tool and made the shop the whole product. If the question is "would anyone ELSE use it": the comparable is OpenClaw-class personal-agent platforms, not coding harnesses — differentiators there are code-gated autonomy, verified memory, and small-model discipline that survived a real eval gauntlet. Positioning is its own session; it is not a doubt about the architecture.

### Phase C SHIPPED + LIVE-VERIFIED (August 19 2026): Pi joins the institutional memory
The four committed components, all live (44f9d64..c5ff8e2 + verification):
- **Verified experiences at the gate event** — executeMerge writes a (:Turn source:'pi' {model, commit, jsonlPath}) then a verified Experience (idempotent on mergeSha — crash replay finds the node), awaited BEFORE exit(42); the experienceId rides IN the deploy marker (recovery state is self-contained; metrics keep a copy as observability, per Peter: "I would not make recovery correctness depend on querying telemetry"). **verified = epistemic confidence, not success**: a rolled-back merge yields a verified FAILED experience. Verified injects at evidence 1 (the gate substitutes for recurrence); unverified keeps ≥2.
- **Rollback → memory reversal** — the supervisor preserves the marker as deploy-failed.json (evidence, not deletion); bootSweep consumes it BEFORE the stale sweep: `self_mod_rolled_back` metric + `supersedeById` (id-addressed — KNN contradiction cannot catch near-identical text with a flipped outcome) with explicit chain properties (supersededBy/supersedesId) alongside the SUPERSEDES edge.
- **Advisory surfaces, split on purpose** — a bounded PRIOR EXPERIENCE brief prepended to every Pi prompt (floor+cap, empty-safe) + a read-only `memory_search` customTool for when Pi pulls more. **customTools deviation from the original ".pi/extensions + console API" wording** (that predated Phase A making Pi in-process): the adapter owns SDK types/TypeBox (declared dep pinned to the SDK's 1.1.38), memory modules own `query → string`, the callback NEVER throws (memory plumbing must degrade cognition, never pollute failure telemetry). Pi READS memory; only Invarail writes — the authority-boundary structural test allowlist was extended deliberately (writer: self-mod-service; advisory reader: coding-memory).
- **Failure harvest** — `pi_session_failed` candidates enriched from the session JSONL tail; **authority beats frequency** in the candidate sort (a count-1 rollback outranks 30 generic tool timeouts) and authority-grade candidates survive the batch-distrust discard (the marker advances regardless — losing one there is permanent). Routing tuples (taskCategory/model/ok/durations) recorded from day one; routing ON them is explicitly out of scope.
- **Live verification** (isolated clone, dedicated drill graph): golden path → Experience {verified:true, commit:db4dff42, ev:1} + pi Turn + EXTRACTED_FROM edge + experienceId in marker; **second similar !improve got the PRIOR EXPERIENCE brief injected** (grep'd in the session JSONL) with memory_search registered; rollback drill → verified-failed supersede with full chain; harvest surfaced rollback + denial + failed session as the top candidates.
- **Incidental production find, fixed**: the LocalClaw→Invarail rename split the memory — GraphMemoryStore's default graph became 'invarail_memory' while history (1695 turns, 59 facts, 3 experiences) lives in 'localclaw_memory', and ExperienceStore hardcoded the old name (provenance edges cannot cross graphs). Both stores now follow `memory.falkordb` config with matching defaults. **OWNER ACTION: set `memory.falkordb.graphName: "localclaw_memory"` to reunite with history** (or migrate the small new graph into it).
- Noted follow-ups: `!improve` has no re-propose path when a gate-passed worktree outlives the 10-min confirm TTL (expired three times during drills — needs `!improve propose` resubmission without a new Pi session); the overnight lesson that a conversation-driven operator cannot confirm while dormant is an argument for the briefing/notification path carrying confirm ids.

### Phase B BUILT (August 19 2026): worktree self-modification — gates, ledger merges, dumb supervisor
The full rail, shipped in four increments (c7400c2, 52766be, 359d578, +supervisor):
- **`!improve <spec>`** (owner-only bang-command, silent for non-owners, bypasses the router — no classification ambiguity on the highest-authority flow) → `SelfModService.propose`: one-active worktree gate → checkpoint the habitually-dirty running tree (gives rollback a SHA) → worktree on `self-mod/<slug>` → Pi session (Phase A adapter, cwd=worktree, guardrails demand commits) → auto-commit leftovers (the gate diffs history, not the index) → merge gate → pending `self_merge` action on the ledger, principal-bound.
- **Merge gate** (`src/coding/merge-gate.ts`, always executed from the MAIN tree — Pi never authors the gate that judges it): three-dot diff vs baseSha, Tier-3 classification over code-clamped protected paths (config extends, never shrinks: src/security, dispatch, config loader/schema, self-mod/gate/supervisor files, package/vitest/tsconfig/.github/.env — gate-config tampering is itself flagged), scrubbed-env tsc + vitest (secrets never reach Pi-authored test code), deps-diff forces symlink removal + real `npm ci` (installing through the node_modules symlink would mutate the main tree from inside the arena). Empty diff fails.
- **`self_merge`**: registered tool, in NO specialist list (model-invisible), no targetArgs (grants structurally cannot mint a merge — owner-confirmed forever). executeMerge re-verifies branch HEAD == gate-judged SHA (any post-gate commit voids the verdict), `--no-ff` merge with abort-on-conflict, atomic deploy marker `{prevSha, mergeSha, slug, ts}`, worktree cleanup, then reply-delivery grace → **exit(42)**.
- **Supervisor** (`scripts/supervisor.sh`, ~95 lines bash, no model, execs a tmp copy of itself so a merge can't rewrite the running interpreter): exit 42 → validate marker (mergeSha==HEAD) → npm ci iff lockfile diff → re-run gates in the merged tree → restart with rollback ARMED → health poll (/health HTTP-200-only ≤60s; status body awaits Ollama so a down backend must not look like a bad deploy; child-alive fallback when web disabled) → failure: `git reset --hard prevSha`, one retry; still unhealthy or 3 crashes/5min → data/self-mod/FAILED and stop LOUD. Exit 0 = intentional stop, never restarted.
- Worktree hygiene (from the plan-mode stress-test): node_modules + data/training symlinked (fresh worktrees lack gitignored deps/data; routing-eval reads data/training cwd-relative), vitest excludes `**/data/self-mod/**` (gate runs in the main tree must not discover worktree test files), boot sweep for orphans and stale markers.
**Live verification: PASSED (August 19 2026, isolated clone on :3101, real Pi + real gates).** Golden path end-to-end: `!improve` → Pi added the requested line → gate pass (tier 0, tsc+783 tests in-worktree) → confirm → `--no-ff` merge → exit 42 → supervisor gates → restart → healthy on the merge commit, change live. **Rollback verified with a REAL failure**: an environment defect (symlinked node_modules in the clone root) failed the supervisor's post-merge tsc → `reset --hard prevSha` → healthy on the pre-merge SHA, marker consumed — unplanned, and exactly the mechanism working. Tier-3 drill: touch to src/security/grants.ts classified tier 3 with the protected path named; `deny` cancelled; `!improve abandon` removed worktree + branch. The drill caught two real arena defects pre-production, both fixed + regression-tested same hour: (1) tracked `data/training/routing-eval.jsonl` means fresh worktrees already have data/training — symlinks must existence-guard (408e172); (2) symlinked node_modules breaks tsc (TS2742 realpath escape) AND evades .gitignore's dir-only pattern into `git add -A` — node_modules is now an APFS clonefile copy, and the gate hard-fails any branch touching node_modules/data (31736a4). Deployment model: run `bash scripts/supervisor.sh` instead of `npx tsx src/index.ts`; set `selfMod.enabled: true`.

### Doctrine refinement: constrain the arena, not every move (August 18 2026, same night)
The correction to the crossroads framing (Peter): Invarail was never a coding harness that lost to Pi — it was always a systems problem with a PLUGGABLE coding substrate (OpenCode out, Pi in; the architecture didn't change, a worker did). The harness's coding was always incidental: pipelines, validation, stopping conditions, small helpers. What tonight actually exposed is a tension between two successful patterns:
- **Invarail's old principle:** reduce the decision surface before the model sees it (router → specialist → only the tools it needs). Still correct for known procedures.
- **Pi's pattern:** a tiny set of extremely general primitives (read/edit/write/bash — bash is a meta-tool) inside a bounded space, and the model composes freely. Correct for open problems.
The synthesis, now doctrine: **constrain the ARENA, not every move inside it.** Give the worker a scope, defined authority, a small capability set, acceptance criteria — then let it work. Corollaries:
- **Execution freedom ≠ authority freedom.** Qwen may decide it needs Playwright, write 200 lines, retry twenty times — while Invarail still decides: this repo, these writable paths, network yes/no, never production, this action confirms, this evidence makes it count. Freedom below, governance above.
- **The router's fork, extended:** known procedure → deterministic pipeline (known stop rules, validation — tonight's ~10M-token exploratory build is exactly why you don't pay Pi to rediscover "collect N sources, validate, stop" weekly); unknown/open task → Pi arena. Routing tuples recorded from day one make this fork evidence-based instead of vibes.
- **Push responsibility to the lowest layer that can RELIABLY own it** — reliably measured by the eval harness, not by one impressive night. Same graduated-gate logic as the autonomy ladder, applied to intelligence placement.
**Phase B open decision (flagged, not made): the arena should probably be a worktree INSIDE a Docker container, not a bare worktree.** A worktree isolates writes; Pi's bash still runs on the host (network, env, processes — shared-fate observation #1 above). A container is the strictly stronger wall — feral inside, zero authority outside — and Invarail already owns the machinery (DockerBackend). It also retires shared-fate #1 and makes the cooperative-abort concern (#2) moot: killing a container is absolute the way SIGKILL was. Pi ships containerization.md in the SDK — read before designing.

### Memory integration (added same day — NO second memory system)
FalkorDB is Invarail's institutional memory; Pi becomes one worker that learns from it and contributes VERIFIED experience back. Existing machinery reused wholesale: coding experiences are ordinary Facts (imp 5 = system invariants, 4 = validated conventions/proven lessons, 3 = prior successes/failures, 1-2 = ephemeral debugging, natural decay); SUPERSEDES handles evolving engineering truth ("web_fetch rejects Atom" → superseded by "supports XML-family as of commit abc"); Turn extends with source:"pi" + session/task/repo/commit/model/thinking → provenance answers "why do we believe this" all the way down to the session JSONL. Four components only:
1. **PiCodingAdapter** — Invarail → Pi SDK (Phase A artifact).
2. **CodingMemoryContext** — pre-session Falkor retrieval → small experience packet (relevance floor + item cap + repo-scoped tags, same discipline as chat priming — never the whole transcript of last time).
3. **PiMemorySearch** — read-only Falkor search as a project-local .pi/extensions tool hitting the console API. Read-only FOREVER, not initially: the model asking is fine; the model asserting into memory is the authority boundary. Invarail extracts; the model never writes.
4. **PiExperienceRecorder** — HALF-BUILT ALREADY: extend the lesson-harvester's sources to Pi session JSONL (failures → lessons, code-detected, marker-tracked, never model self-assessment); validated positives → Facts via the existing extraction path. The merge-gate validation event and the memory verified:true flag are the SAME event — a memory can never claim a success the gate didn't witness. PR-merged strengthens; PR-reverted supersedes to long_term_failure.
Later (record now, route when n is meaningful): task-category → model → effort → outcome tuples accumulate on Pi Turns from day one; experience-based routing proposals arrive as config-overlay changes on the ladder, never silent behavior shifts.

---

## Six Attempts to a 14-Minute Report — Stripping the Last Accommodations (August 16 2026, afternoon)

### The saga (each failure closed a class)
The weekly research cron took six attempts across the day; every death was a distinct, permanently-fixed defect:
1. **One-facet report** → pipeline llm stages never forwarded `think`; decompose starved. Fixed: per-stage think control (LlmStage.think, caps-gated in the executor), decompose/gap_check pinned think:false.
2. **4/6 facets starved** → reasoning headroom 4096 too thin for qwen3.8 synthesis. Fixed: 16384, none when think:false (honest budgets).
3. **final_synthesis dead at exactly 300s** → the client's default timeout; .env said 600s. Which exposed:
4. **THE .env LAZINESS BUG**: loadConfig() parses .env at RUNTIME, but every env-tunable was a module-scope const captured at import evaluation — production silently ran defaults for every knob added since Thursday; only tmux-exported eval runs ever saw overrides. Fixed: all tunables are call-time function reads (also makes future self-tuning hot-applicable).
5. **46-minute facet phase** → `serializeSynthesis`, the ds4-era accommodation (three concurrent 284B generations self-contending), silently single-filing "3 concurrent" facets on a backend that batches natively. Removed. Facet phase: 46min → **111s** (with think-off facets).
6. **Cannot-reach mid-synthesis + all-day connection blips + this morning's NVIDIA Sync failure** → NOT SGLang (container Up 4h through everything): **Spark-2's network link is flapping** (Peter's own SSH session reset mid-diagnosis — the smoking gun). Hardware follow-up: cable/port/NIC-power/IP-conflict on the 10.0.0.x side. The software stack SURVIVED a flapping link well enough to deliver 5/6 facets — every retry layer got a live stress test.
Plus en route: `Connection: close` on the OpenAI path (stale keep-alive pool races), error CAUSES logged on connection retries (no more blind forensics), embed pacing matched to the gateway's measured 100/min cap, embed timeout 45s (> gateway queue bound 30s), shutdown aborts ALL in-flight inference (orphan-wedge class dead; verified via TIME_WAIT sockets after Ctrl-C).

### Attempt 6, the payoff
**13m49s end to end**: sweep 2.3s · decompose 3.0s · 6/6 facets 111.6s (concurrent, think-free) · final_synthesis 192.4s (think-on, the blind-A/B winner mode) · 16 claims verified, 2 Tier-1 contradictions caught, 4 corrections spliced · charted PDF delivered. Best report quality of any run — think-off facets INCREASED depth (architecture specifics + practitioner implications). Cold read found two verification defects, both fixed same hour: corrections splicing mid-word into compound tokens (llama.cpp, Z.ai — letter-dot-letter now masked like URLs/decimals, regression-tested) and a Tier-1 over-correction (a range claim "contradicted" by one instance — judge now prefers SILENT on range/set claims).

### The design commitment (Peter): CONFIG, NOT CODE
Today's meta-lesson, stated twice and proven twice: the deepseek era left invisible model-shaped accommodations in code (headroom, serializer, noThink judges, budgets); the swap surfaced them as failures one by one. AND the serializer removal is itself now an SGLang-shaped hardcode — 3-concurrent facets would self-contend on an Ollama-served synthesis model. **Concurrency is a backend property.** Committed direction (Phase 1, next session): a config surface for ALL model-shaped tuning — per-backend maxConcurrency, modelCaps overlay, per-pipeline stage tuning (think/budgets), inference timeouts/pacing — in a machine-writable overlay file separate from the human config, clamped by code, with Phase 2 being evidence-driven self-tuning proposals (code detects failure signatures from logs → model proposes → owner confirms via the pending-action ledger — the lessons doctrine applied to configuration). Also queued: research-smoke.ts (2-facet minimal pipeline run, ~4 min) — the iteration-latency fix; "over an hour between tests feels bad, man."

---

## The SGLang Cutover — One Model, One Box, Real Concurrency (August 16 2026)

### Sequence (each step evidence-driven)
1. **Config swap** (morning): all 15 specialists + briefing + reasoning + vision + browser-vision + Pi moved from deepseek/gemma to qwen3.8. Think policy per role: `think:false` everywhere, `think:true` on research (the blind-synthesis-winning mode).
2. **First production stumble = the eval's own failure class**: the midnight cron produced a one-facet, 3-source report. Root cause: llm pipeline stages never forwarded `think` at all — qwen's default-on thinking burned decompose's 700-token budget ("thinking models fail at budgets", now observed in prod). Verification carried the report honestly (6/9 flagged, 3 Tier-1 contradictions caught, self-flagged source concentration).
3. **Chat latency complaint** → log showed queueing behind the research cron on the shared fleet box, not model slowness. Deepseek never felt this only because it had a dedicated box — tenancy, not intelligence.
4. **Peter deployed SGLang + NVFP4 on Spark-2** (lmsysorg/sglang:qwen38-27b, RadixArk NVFP4 checkpoint): MTP speculative decoding (NEXTN, 3 steps), 262K context, `--max-running-requests 4` (real continuous batching), native tool-call parser, reasoning parser (thinking → reasoning_content). ~23 tok/s single-stream (vs 18-19 Ollama Q4 — Spark is bandwidth-bound; the 131 headline was 5090 bandwidth).
5. **Quant-roulette footgun caught**: same model id on two stacks (Ollama fleet Q4 + SGLang NVFP4) = nondeterministic serving identity. Fix: removed from Ollama entirely; served id is `qwen3.8-27b` (dash); routed DIRECT via inference.backends (never behind the gateway — the ds4 pattern).
6. **thinkStyle backend option**: SGLang doesn't speak ds4's top-level `think`; Qwen toggles via `chat_template_kwargs.enable_thinking`. New per-backend `thinkStyle: 'native'|'qwen-template'` translates booleans (effort strings warn-once-omit). Verified live: think:false → 13 ctok direct; default → reasoning_content. Without this the per-stage think policy silently dies and every chat pays default-on thinking tax.
7. **Per-stage think control** (the decompose fix, principled version): LlmStage.think, caps-gated forwarding in the executor (toggle=boolean, levels=string, never a rejectable field), ctx.think carries the specialist default, decompose/gap_check pin think:false with raised budgets, parse_angles warns on degenerate output. model-caps learns qwen3.8 (VL, format, toggle).

### Doctrine confirmed
- Think is a per-STAGE property, not per-specialist: structured stages never think; synthesis stages think when the human read says it pays.
- Same-id-different-stack is provenance poison — serving identity must be unique per model id.
- The tenancy axis (dedicated vs shared box) matters more for felt latency than any model property; continuous batching dissolves the chat-vs-cron collision structurally.
- Pi routes `sglang/qwen3.8-27b` direct (models.json), no auth; the gateway `pi` key is retired from that path (kept for future gateway-routed Pi work).

---

## The Day the Foreground Slot Became Empirical (August 15 2026, evening)

### The question and the method
"Why do I keep using deepseek if qwen3.8 can do it just fine?" — settled by escalating head-to-heads, each designed to give the larger model its best case. Four contests, all instrumented, artifacts preserved:

1. **Deep eval (tier 2)** — both 100% on the long-horizon battery. Tie.
2. **Blind synthesis** (4-way, sealed A-D mapping; scripts/synthesis-eval.ts) — identical 8-doc webindex source pack → analytical article. **qwen3.8@on won blind** (most original thesis, best epistemics, correct safety-table attribution) at 2,911 ctok vs deepseek's very-close second at 8,400. gemma@off: accurate but thin (terse superpower reads as underweight prose — MTP hosting would fix speed, not depth). gpt-oss@low: the only FACTUAL ERRORS of the four (misattributed safety figures, mangled model name) under polished prose — deliberation matters for faithful synthesis in a way it doesn't for structured execution; a @medium prose rerun is queued.
3. **Build duel** (scripts/build-duel.ts; single-file webapp, Playwright battery + screenshots) — functional 14/14 TIE; qwen3.8 decisively better design (card layout, formatted dates/currency, filter-aware labeling) at ⅔ the tokens. Harness lesson: accept confirm() dialogs or good UX scores as a delete failure.
4. **Pi duel** (scripts/pi-duel.ts; both drive the SAME autonomous coding agent on the same jobqueue ticket — SQLite persistence, priorities, exponential backoff, dead-letters — scored by a hidden 12-check acceptance suite validated against a reference implementation BEFORE either ran) — **qwen3.8 12/12 in 384s with 11 real tests; deepseek 11/12 in 513s with 8 real tests** (max_retries off-by-one, line-level confirmed).

### The audit insight (the day's deepest finding)
Full source/test audit of both Pi artifacts found zero gaming and one profound asymmetry: **deepseek's tests never assert attempt counts — blind exactly where its implementation deviates from contract; qwen's tests assert exact call counts, which is WHY its implementation got the semantics right.** Test discipline and contract fidelity are the same skill. "Tests that pass" vs "tests that protect." Also from the audit: deepseek's BEGIN IMMEDIATE claim transaction was the single best line of code either produced; its created_at-based FIFO has same-tick fragility (qwen used a monotonic seq); qwen's deadline-once worker semantics is a deliberate, self-tested interpretation of an ambiguity in MY ticket (backoff-waiting work vs "no runnable work" — spec author's miss, noted).

### Verdict and division of labor
qwen3.8:27b, 4-0 (two wins, two ties broken on cost/design), on shared redundant fleet vs a dedicated box that ghosted its own management plane mid-duel. **Pending Peter's sleep-on-it: promote qwen3.8 to foreground slots (chat/briefing/synthesis/judges), which frees an entire DGX Spark — fleet re-plan is its own session.** The frontier-model division of labor observed all day: local models executed everything; the frontier model in the loop designed batteries, caught its own evaluator defects (L6 amnesty, confirm() dialogs, zombie aborts), and judged blind. Structure-provision remains the scarce good — for now, and the eval harness is the instrument that will say when that changes.

### Infra fixed en route
- Pi's models.json had deepseek pointed at the PRE-MOVE box (10.9.8.15) — prod pi_build was aimed at a dead endpoint; fixed to ds4 at 10.9.8.64, `gateway` provider added.
- Gateway /v1 now enforces key auth when a key is presented (anonymous passes; `[a-zA-Z0-9_-]{16,128}` against a key list, gw- prefixed). Dedicated auditable `pi` client identity minted; key in gitignored scratchpad/pi_key.txt (0600). Per-key knobs available later: target_endpoint pinning, model allowlists, daily budgets.
- ds4/Spark-2 had a transient connection-refusal window (NVIDIA Sync couldn't see the box either) — serving recovered on its own; watch for recurrence.

---

## Absence Claims Get Tendrils — Model Nominates, Code Budgets (August 15 2026)

### The failure that drove it
First fully-local-first research run (8/8 facets from the index, zero external searches) confidently declared Muse Glimmer "a phantom... a hallucinated benchmark entry" — the model Peter had benchmarked three days earlier. Chain: Meta has no RSS → page seed captured only the blog index → the facet's 4 local hits were adjacent material → the ≥2-hit gate skipped web search → synthesis honestly reported absence but escalated "absent from MY sources" into "does not exist" → Tier-1 never checked it (candidates were picked by a code-side topic heuristic with no concept of arguing-from-silence).

### The fix (Peter's framing: "the model should be able to decide when it needs to verify and extend its tendrils into the web")
Split as: **model decides WHAT, code decides HOW MUCH** — same shape as the autonomy ladder. Claim extraction gained `external_check` + reason and an `existence` claim type (auto-flagged: absence claims are structurally unsettleable from cached pages). Escalation ordering spends the unchanged `maxCrossChecks` budget on existence/nominated claims first. Tier-1 judge learned "absence is refuted by presence." Queries drop absence-framing words (searching "muse glimmer phantom" finds skeptics; "muse glimmer release" finds the launch post). Synthesis gets a provenance notice when facets came from the personal crawl: silence in a ~20-feed index is a coverage gap, not nonexistence.

### Validated same day
Next run drafted the same absence claim → extractor flagged it → Tier-1 found ABC News (Zuckerberg manifesto, Muse Glimmer open-source + Muse Spark 1.2 closed flagship) → CONTRADICTED → correction spliced with quoted evidence → published Contradictions section read "This is a coverage gap in the personal crawl, not evidence the model doesn't exist." The blind spot became load-bearing feedback in one iteration.

### Related hardening (same two days)
- **Code owns the Sources section** — synthesis minted near-miss URLs transcribing the handed list (`ollama.co` for ollama.com, two runs straight); parse_final now regenerates `## Sources` from `_allSources`. Same doctrine as document styling: models never author publish-path structure.
- **Cron runs inherit owner identity** — every fire (scheduled or cron_run) dispatched as "Untrusted user undefined"; the untrusted layer stripped code_session and killed research charts. Jobs are owner-authored (cron_add is the code gate) so runs carry `senderId: ownerId`; cronMode write-stripping unchanged on top. Identity and autonomy bounds are separate axes.
- **cron_edit/cron_remove accept names** — the extractor passed "Weekly AI Developments" into an id-only lookup; shared `resolveCronJob` (exact id → case-insensitive substring, ambiguity errors listing jobs) across run/edit/remove. Users and extraction models say names; ids are plumbing.
- **WebIndex first-crawl hardening** — 4 guessed RSS URLs were 404s (anthropic/meta/mistral/qwen publish NO feeds — curl-verify before seeding; page-kind seeds instead); client-side embed throttle in OllamaClient (250ms serialized chain, process-wide — the gateway added inbound 429s); boot-resume of interrupted cycles; backfill drains fully; publish-date sniffing at ingest (page-date.ts) with the crawler raw-fetching + Readability instead of routing through web_fetch (the tool discards head metadata; undated docs rank neutral, never fresh); Reddit seed dropped (robots.txt disallows post pages — headline-only signal isn't worth non-consensual requests).
- **Vendor-neutral cron prompts** — the job's hardcoded model list ("Ollama, Qwen, Gemma, Llama") was why reports kept resurrecting Llama and never asked about NVIDIA. Same principle as the index: seeds decide coverage, prompts don't hardcode entities.

### Qwen3.8-27B eval addendum (run-2026-08-15T14-14-30, published)
The think archetype FLIPPED within one family/size/quant in one release: qwen3.6@on 82% (harmful) → qwen3.8@on 100%/0 flips (mildly load-bearing; off = 97%, code 89%). Refutes the r/LocalLLaMA rebadge claim; strongest evidence yet that archetype membership is per-model AND per-generation — never carry a think policy across a version bump unmeasured. Nemotron-3.5-lightning control: off-row reproduced (98%), on-row confirmed unstable (89%, code 56% at 9,771 ctok). Open question queued: does Ollama's `think` toggle engage Nemotron's native "detailed thinking on" system-prompt convention, or are its think=on rows a serving artifact?

---

## The Personal Vertical Index — Built the Same Day It Was Justified (August 14 2026)

### The decision (evidence-driven, per "run it first")
The rebuilt research pipeline's live A/B (discovery sweep + gates + healthy search) produced a genuinely good report — real week, 17 sources, verification catching a fabricated Llama-4 claim from a content farm — and STILL missed NVIDIA's entire release week and Qwen's flagship drop while spending a section on a non-story. Diagnosis: sweep-based discovery has a 2-query aperture into SERP-ranked content farms; coverage was probabilistic. Owner verdict: "this isn't a good up-to-date news article" → build leg 1.

### What shipped (51f8828, 4c65b42)
`WebIndexService` (src/webindex/): RSS/Atom-first ingestion (zero-dep parser, conditional GET) over owner-curated seeds; item pages via the real web_fetch (Readability+SSRF) behind honest crawler etiquette — InvarailBot UA, robots.txt, per-domain pacing; content-hash dedup; aggregator seeds follow item links one hop (discovery layer); chunks → EmbeddingStore `source='webindex'` + metadata sidecar (real publication dates); NO LLM anywhere in ingestion; embedding-outage resilient (store-pending + backfill — designed while gpu-node's embeddings route was actually wedged). `local_search` tool: recency-weighted (14-day half-life) doc-collapsed retrieval that tells the model to fall through when thin. Pipelines: research facets try the index before the SERP (≥2 hits skip web search); web_search unions local hits ahead of web results — an outage that the index can cover never even reaches the evidence gate.

### Doctrine notes
- **vs search-buckets** (the challenge was raised and answered): buckets SUBTRACTED (site: filters constrained live retrieval; worst case silence) — the index ADDS (a retrieval source in front of unconstrained search; worst case irrelevance-then-fallback). No topic→source mapping to rot; we own the whole stack; deletion cost is one config block. Echo-chamber risk named, mitigated by the aggregator hop + permanent web fallback + local-hit-rate logs.
- **Ship the rail, not the opinions** (owner's rule): repo ships mechanism only — `localIndex` off by default, starter config shows illustrative seed SHAPES. The owner's actual seed list is personalization and lives in his gitignored config.
- Enhancement queued: JSON-LD/OpenGraph metadata extraction at fetch (real dates/titles for 1-hop follows — needs raw-HTML hook in web_fetch).

---

## Zero Evidence In, Confident Report Out — the Fabrication Gate (August 14 2026)

### The incident
A manually-triggered weekly-news job (via the new `cron_run`) delivered a polished 15k-character "report" — Qwen3-Next, Llama 4.5, Ollama v0.8.2, an arxiv preprint — **entirely fabricated**, with invented version numbers, benchmarks, and URLs. The model even confessed in its own intro ("live search returned no indexed results… extrapolated") and the `revision_pass` then spent 166s polishing the hallucination. Three causes stacked: (1) the job's stored category was `"cron"` (mis-authored at creation) so dispatch fell back to live routing and landed on the thin `web_search` pipeline instead of `research`; (2) SearXNG's upstream engines had flagged the host — DDG CAPTCHA (client-signature-scoped, not IP-wide: a human browser from the same address passes), Brave 429s, Wikidata 403s — after **two days of unspaced eval+research bursts**; (3) neither synthesis stage treated "zero sources fetched" as fatal.

### The fixes (e5ca468)
- **Evidence gates**: `research` and `web_search` pipelines abort (`ctx.abort`) before synthesis when zero sources exist, with an honest "search is down — I won't answer from memory" message. Doctrine: **degrade honestly, never fabricate** — the verification layer's principle applied at the front door, because no verifier can rescue a report whose every source is imaginary.
- **Universal politeness throttle**: the Brave-only throttle generalized to ALL five search providers (per-provider serialized chains, 1.1-1.5s minimum intervals). A self-hosted metasearch spends the HOST's IP reputation with every upstream engine it aggregates — and SearXNG's self-policing points inward (inbound limiter, reactive engine suspensions), not outward: it was designed for human-paced use, and an agent pipeline is an out-of-distribution caller. **The layer with the burst knowledge owns the pacing** — only the caller knows six facet searches are one logical operation.
- Synthesize prompts hardened: only-from-provided-material, never cite a URL not in the material.

### The lesson (the week's recurring one, again)
Every layer assumed some other layer held the contract: the pipeline assumed SearXNG paces itself, SearXNG assumes humans pace themselves, engines flag whoever doesn't. Nobody owned outbound politeness, so the bill landed on the IP. Same shape as the dropped `think` param and the "unenforced" format schema: **an interface you assume is policed must be verified or owned.**

### Planned (dial list): three-leg search stack
(1) **Personal vertical index** — index HIS web, not THE web: 50-200 curated seeds, RSS-first, honest crawler etiquette (named UA, robots.txt, per-domain limits — the big-lab playbook at hobby scale: they never scrape SERPs; they own indexes, buy indexes, or buy content), stored on the existing SQLite EmbeddingStore, `local_search` tried before any web search. (2) Brave API free tier for ad-hoc long-tail. (3) SearXNG re-enters rotation post-cooldown (DDG disabled ~3 days, engines diversified). Ops note: the mis-categorized cron job still needs its `category: research` fix.

---

## Enum Routes Need an Exit Ramp (August 14 2026)

**The failure:** "Can we trigger a cron to run early?" → routed to the cron pipeline, whose `llm_branch` route offers ONLY action buckets (add/list/remove/edit). An enum-constrained choice with no escape forced the model to pick the least-wrong action (edit); the dispatch context rewrite had already converted the question into a command ("Can we schedule a cron job to execute earlier…?" → imperative); extraction produced the empty-required-id "unknown" signal; and — because pipelines have no reaction step, unlike the ReAct loop — the raw tool error ("Error: id parameter is required") went straight to the user's DM. Four small design gaps stacking into one rude non-answer.

**The doctrine (same as the engine repair-prompt fix, one layer up):** every constrained model choice needs a no-action exit. Applied (730dd63): all three `llm_branch` pipelines (cron/memory/task) gain a `question` branch that answers from an honest hardcoded capability list — cron's states plainly that run-now does not exist and offers the real workarounds; the rewrite prompt now preserves interrogative mood; cron edit/remove `when`-guard their tools on id and ask "which job?" with the list when the extractor signals unknown. Rule for future pipelines: an enum route ships with a question exit, and any required-param extraction seam decides what the USER sees when the param comes back empty — a raw tool error is never that answer.

**Deferred with trigger — TRIGGER MET SAME DAY:** the owner asked for run-now twice within 24h (once as a question, once as a command the rewrite then mangled into a question — the mood-preservation instruction needed to be symmetric, fixed). Built (decf7b0): `cron_run` resolves by id or partial name (disambiguates, never guesses), fires through `CronService.run`'s existing path fire-and-forget (a manual trigger behaves exactly like the clock firing; results via the job's own channel — awaiting would hold the chat turn hostage for a 20-minute research job), route gains a `run` branch with empty-param grace, and the question branch's capability truth was updated in the same commit — an exit-ramp answer that denies a capability the same PR adds would be its own little lie.

---

## Recency Research: the Model Cannot Know What It Doesn't Know (August 14 2026)

### The failure (live, first boot after the eval week)
The weekly AI-news cron produced a report that led with Qwen's flagship release (correctly — by luck) while missing NVIDIA entirely (Lightning, the nemotrons, NeMo Switchyard — the week's second-biggest story, benchmarked in this very repo on release day) and Meta's muse-glimmer. Root mechanism: `decompose` asks a static-knowledge model to decide what current news to search for. The model facets from its frozen training prior — it literally generated Gemma/Llama queries because those are the archetypal open models it remembers — and phrases facets as long natural-language questions that SearXNG returns nothing for (5 of 8 searches came back empty; same failure class as the removed Brave `site:` buckets). **The report's most instructive sentence**: its own gap analysis explained Llama's absence as "may reflect a quiet week for Meta" — the frozen prior didn't just miss the news, it wrote a plausible wrong explanation for its own blind spot. Second-order gap also observed: a "weekly" report built partly on April-dated evergreen sources (freshness filtered the searches, not the sources' publication dates).

### The fix (e416b74): discovery-first, strictly no hardcoded targets
1. **`discovery_sweep` stage** — recency-shaped topics (`isRecencyShaped`: shape patterns, no entities) get 2 generic keyword sweeps derived from the topic itself (`condenseToKeywords` + "news"/"announcements <clock month year>"); results go to the decompose prompt with the instruction: *your knowledge of "recent" is stale by definition — facet around the names in these results, not the ones you remember.* The model's job shifts from guessing what's new (impossible) to organizing what search found (its strength). Sweep failure degrades to the old path.
2. **Decompose emits short keyword facets** (3-8 words), not research questions — kills the unsearchable-query problem at birth.
3. **Dry-facet retry** — empty search → one keyword-condensed retry before the facet dies. Degrade-never-abort, same as extraction repair.
Doctrine note: no vendor, model name, or domain appears anywhere in the fix — entities are always runtime data. Hardcoding "search NVIDIA" would fix one week and rot forever (see search-buckets teardown; "why are we hardcoding for this?"). Better procedure, not better answers.

### Verification plan
This week's old-code report is the banked baseline; next week's run is the A/B. Deferred with trigger: source publication-date extraction feeding synthesis (the evergreen-sources gap) — build when a second report leans on stale sources.

### Status
Live on next boot (shipped alongside the eval-week stack + FalkorDB 4.2.3). 698 tests.

---

## The Model Eval That Kept Finding Our Bugs Instead (August 11-12 2026)

### What it was
A "which 20-30B model is best" question (muse-glimmer release day) became a publishable eval harness (`scripts/model-eval.ts`) and a two-day, two-codebase forensic. Final form: 23 base models × 3 reps × 14 tasks (tool-loop incl. 9-hop long-horizon chain, grammar-constrained extraction, chat discipline, execution-verified real-world coding in a Docker sandbox), deterministic code checks only, failure taxonomy (MODEL_FAILURE / TIMEOUT / SERVING_INCOMPATIBLE / PROVIDER_OUTAGE with retry→UNSCORED), think on/off A/B rows via runtime capability probing, per-task completion-token metering (`ctok` — hardware-independent cost), full provenance (digests, harness commit, dual serving topology). Raw outputs published for human read; prose quality deliberately unscored ([[feedback_regressions]]: trust the human side-by-side).

### Disproven theories — record them, they cost the most
1. **"The gateway silently doesn't enforce JSON schemas."** Wrong. Wire-level fetch interception + curl bisect of the exact request body proved `format` was attached AND enforcement works. Real cause: `chatMaybeStructured`'s 256-token default — thinking models burn the whole budget on reasoning (thinking counts against num_predict) and the constrained JSON never gets emitted. Same bug class as the vLLM reasoning-headroom fix in openai-client.ts; the Ollama path never got it. muse-glimmer extract: 33% → 100% with 2048 budget.
2. **"qwen3.6:27B leaks untagged thinking; 35B doesn't."** Wrong premise from a 9-sample eval batch. The gateway team's 200-sample audit grep: BOTH distillations leak untagged reasoning prose (27B ~10%, 35B ~5%) — weights-side gradient, not template (identical serving setup, verified).
3. **"ds4's /v1/chat/completions has no per-request thinking knob."** Wrong — I read one README section instead of testing. Direct curl: ds4 honors `think:false` AND `thinking:{type:disabled}` (1 completion token vs 18 default on trivial math). Never declare an endpoint's capabilities from docs when the endpoint is one curl away.
4. **Three "model failures" were infrastructure**: gateway 503s (`all_providers_unavailable`) zeroing T5 for three models, and deepseek-coder's HTTP 400s (serving path rejects tools entirely). An external report caught both — error strings were sitting untriaged in our own results.json. Hence the failure taxonomy.
5. **Single-run scores lie in both directions**: qwen3.6:35b measured 84% and 100% the same day. 3-rep pass rates + a flipped-checks stability column are the minimum honest unit. (And even 3-rep batteries have variance-of-variance: cascade-2's C1 went 0/3 → 3/3 between batteries.)

### What it changed in Invarail (all committed 80f0dd1, live on next boot)
- **`think` plumbed end-to-end** (OllamaChatParams → specialist config → engine → dispatch). OpenAI-compat path forwards only for backends declaring `supportsThink` (ds4 verified) — an unverified backend gets warn-once+omit, because a silently ignored request field is the exact failure shape that cost both teams a day. Policy: config-driven, static per specialist, set AFTER the A/B data; think:false measured ~14x cheaper at equal quality on qwen3.6 chat.
- **Premature-refusal repair prompt softened** (engine.ts): the old unconditional "you MUST use your tools" sent 13/16 models spiraling through fabricated web fetches on a unit conversion — models obey authority over sense. New wording keeps anti-refusal teeth but offers the no-tool exit. Old-prompt baseline preserved in run-2026-08-11T21-10-06 for before/after.
- **Extractor**: `tryParseJson` now uses `stripThinkingTags` (was inline `<think>`-only — every Gemma-4 extraction burned a repair); default budget 256→2048.
- **VllmBackendConfig** derived from Zod (hand-written duplicate had already drifted — the CLAUDE.md rule proven again).
- Flagged, unchanged: three more `num_predict: 256` caps (web-search branch, consolidation, graph NER) — fine for today's non-thinking models, same rot class as [[stale rationing caps]]; audit before any thinking model takes those roles.

### What it changed outside Invarail
Gateway (their commits): request-shape audit logging (format/options/think per row), `think` passthrough + `thinking` field on non-streaming responses, bare-tag model matching. Plus a dead-replica hypothesis for the glm 503 parity pattern, and an Ollama-upstream nit (budget-truncated thinking under `format` returns prose in `content` instead of erroring — the silent shape that misled everyone).

### Standing eval lessons
- **Eval the system, not the model.** Four "model failures" in a row were harness/infra bugs. Triage error strings before attributing anything to weights.
- **Accommodate transport, never content** (Peter's contract rule): dedent the markdown-nested code fence, strip the thinking tags, parse the Action: fallback — but a wrong output value or format is a failure regardless of how sound the internals were. "It failed the contract" ends the discussion.
- **tok/s is a serving-stack fact, not a model property** — NVIDIA's "30% faster than qwen3.6-35B" measured dead even on our quants/serving. Report ctok (tokens-to-finish-battery) for transferable cost; asterisk all throughput.
- **Training-dialect accommodation is the harness's job** and every accommodation choice is part of the score — list them in the methodology (we do).
- Serving topology matters for comparisons: 22 models via Ollama-behind-gateway, deepseek DIRECT to ds4/DwarfStar (github.com/antirez/ds4 — not vLLM, config comment corrected) running default thinking/high effort.

### Status
Publication run in flight (run-2026-08-12T07-34-43, clean commit d998931). Pre-fix boards: run-2026-08-11T21-10-06 (3-dim, 16 models, old repair prompt) + addenda. Model-caps updates pending run data. Repo/README scaffolding pending final board.

---

## Graph Experience Memory — Approaches Judged by the User's Actual Reactions (August 10 2026)

### The build
First build of the Invarail era, replacing what skills tried to be. `:Experience` nodes in FalkorDB (same graph as facts): task shape → approach → outcome → **user satisfaction**, silently injected like facts ("## Approach notes from similar past work — advisory"). Peter's requirement verbatim: "it should also remember if the user was happy with it or not, so it knows not to do it again and try something else."
- **Signals are code-detected** (doctrine: code detects, model explains — model self-assessment never creates an experience): Discord 👍/👎 reactions (new listener — explicit ground truth), confirm denials, mid-turn steering (now persisted — interrupting a run is never praise), post-task review notes (now persisted), re-ask/praise patterns in transcripts. Explicit signals are born at evidence 2 (inject immediately); inferred ones at 1 (must recur).
- **Contradiction is pure code** — an improvement on the fact system's LLM judge: structured outcome/satisfaction fields flipped within the KNN similarity band → SUPERSEDES. No model in the loop.
- Synthesis at heartbeat with the lesson guards verbatim (max 3/cycle, batch-distrust); `!experiences` lists/drops; `memory.experiences.enabled` gates everything; injection floor 0.60 PROVISIONAL (measure at ~10 real experiences, like the lesson/memory floors).

### The authority boundary is now a TESTED invariant
"Experience informs execution; experience never expands authority" is pinned structurally in `test/learnings/experience-system.test.ts`: experience modules import nothing from `security/`; the store may be consumed ONLY by the four advisory surfaces (dispatch priming, heartbeat synthesis, the synthesis writer, the !experiences command); no security module references the experience layer. Rebuilding skills under another name remains the named failure mode — if a future change wants experience to touch permissions, routing, confirmation, or tool exposure, this entry is the tripwire: the answer is no.
- Lessons COEXIST for now (Peter's ruling) — merge when experiences ≥ 20 and lessons stop gaining evidence.

## LocalClaw Explored the Design Space — Invarail Is What Survived (August 10 2026)

### The rename
LocalClaw → **Invarail** (invariant + rail: authority that cannot move, structure that exists so things move fast). Chosen after the week's synthesis (usage data: 28,345 metric events; three-plane architecture: authority plane immutable, experience plane adaptive, execution via FlowMCP; invariant of invariants: **experience may inform execution, never expand authority**). Name coined by Peter; verified unclaimed (npm, GitHub, web). All history in this file keeps "LocalClaw" as written — records don't get renamed.

### The trim: what survived contact with daily usage
28,345 metric events (Feb–Aug) drew the lines; every removal has a usage receipt. **Removed:** WhatsApp adapter (principle, not usage: an agent that answers messages AS the owner is impersonation — communication identity is not delegable); slack/imessage/msgraph adapters (zero sessions ever); the skills system (three hijacked runs in one week; its self-reinforcement made wrong matches stronger — successor is graph experience memory under the invariant *experience informs execution, never expands authority*; rebuilding skills under another name is the named failure mode); the reason tool + step-back/forced-reasoning engine paths (0 uses in 30d; the forced pass fired after artifacts were already written); analytics/document/config/personal categories (≈0 usage; `send_message` + `document` tools remain as documented EXECUTION PRIMITIVES, not router destinations). **Kept deliberately:** tasks (Peter: "dead because it was inconsistent, not because I didn't want to use it" — stabilize on the slim core later), code_gen/Pi, Telegram, gmail adapter, blender, the entire governance layer, memory, research. **Held:** message category — the Sept 15 token-reminder cron uses it; flagged, not silently migrated. Discoveries the prune surfaced: vision.ts had a phantom dep on sharp (transitive via baileys); the shared embedding helpers lessons depend on lived inside skills/semantic.ts (now `src/memory/semantic-helpers.ts`). Deletion is cheap now — git holds the exact code, DECISIONS holds the understanding, and regeneration costs an afternoon; what was expensive was learning which pieces are load-bearing.

### Migration shims are TEMPORARY DEBT — removal condition set NOW
Three compatibility shims exist so Peter's live deployment survives the rename. **All three are deleted at v0.2.0 or 60 days from this entry (2026-10-09), whichever comes first, once Peter's local migration is confirmed.** Compatibility shims otherwise have a habit of becoming permanent architecture — this entry is the tripwire.
1. **Config discovery** (`src/config/loader.ts`): tries `invarail.config.json5`, falls back to the legacy filename **ONLY on absence (ENOENT semantics)** — a malformed new config FAILS loudly rather than silently loading the old one.
2. **Env var**: `INVARAIL_UNSAFE_TLS` primary; the legacy name is honored with a deprecation warning (`src/index.ts`).
3. **Plugin path**: `~/.invarail/plugins` primary; the legacy dir still scanned with a warning, and a **precedence rule**: a plugin name present in both dirs loads ONCE from the Invarail dir — the legacy copy is skipped, never double-registered.
All three shim literals are written as split strings ('local'+'claw') so mechanical rename sweeps can't rewrite them; their behavior pins live in `test/config/rename-shims.test.ts`, which deletes with the shims.

## Five Live Runs, Five Layers: Wiring a Compiled Flow Into Production (August 1 2026)

### The integration was sound at every layer we'd tested — and broken at every layer we hadn't
Getting `flows_weekly_gather` from "registered at boot" to "actually runs when asked" took five live attempts, each exposing a bug only reachable after the previous fix:
1. **Reachability** — the tool sat on the multi specialist, whose list feeds the plan pipeline's executor, not any ReAct loop. Sub-dispatches run on OTHER specialists' toolsets. Moved to exec (the ReAct workhorse).
2. **Selection surface** — upstream description was compiler provenance ("compiled candidate from gather.v0.json"), telling a small model nothing. The model looked for "weekly_gather", saw `flows_weekly_gather`, declared it unavailable, improvised 7 minutes of web fetching. Fixed with a `toolDescriptions` config override (WHEN TO USE + the bare name). The bridge's description-override layer earned its keep on day two.
3. **Skill hijack + false credit** — a March skill matched at 0.847, derailed the plan, got the fallback's success credited AND our test request appended as a trigger → matched at 0.930 next run. Self-reinforcing capture. Fixed: fallback runs credit nothing; poisoned skill archived. A SECOND legit skill then hijacked the same way (0.786) — proving the class, not the instance, was the bug.
4. **Param padding vs fail-closed** — DeepSeek invented `{"input":""}` for a zero-param flow; FlowMCP correctly rejected it, twice; the model abandoned the tool, scavenged a stale April payload from `.learnings/errors.jsonl`, and presented it as this week's news with fabricated URLs. Fixed in the bridge: params filtered to the declared schema before calling. Accommodation is the translation layer's job; strictness is the server's.
5. **Downstream cwd** — FlowMCP resolves its downstream-server paths relative to process CWD; spawned from LocalClaw's directory, the searxng child died MODULE_NOT_FOUND. Lab tests had masked it (run from ~/FlowMCP). Fixed: `cwd` option on MCP stdio servers. Reported upstream (paths should anchor to the servers.json5 location).
Also: gathering tools need `maxResultChars` — the default 2000-char cap cut 12K of gathered material to one facet of four, and the model narrated the missing sections as "a rate-limit error."
**Meta:** every fix was small and correct, but by layer five Peter set the standing rule — ~3 failed live attempts on one feature means stop patching and go to plan mode for a full end-to-end trace. Live-fix loops find one bug per run; a paper trace of the whole path finds them all at once.

### Flow-first gathering in the research pipeline — strict naming, no semantic matching (built from the plan)
The plan→exec path structurally cannot produce the analytical Weekly report: no synthesis stages, no verification, model-improvised deliverable formats. The article factory is the research pipeline; its slowest stage is gathering. Built: when a request EXPLICITLY names an available flow tool, a `flow_gather` stage calls it once — its `##` sections become the facets, its links the source pool — then fetch/synthesis/verification/PDF run unchanged (`_sourceText` fills identically, so verification works on flow-gathered pages). Flow failure degrades to the normal decompose+search path.
**The gate is strict by decision (Peter's call, asked directly): explicit naming only.** The same night's three skill hijacks demonstrated what "close enough" semantic selection does — silently routing around user intent. Cron messages are authored once and can name the flow forever; ambiguous phrasing keeps the normal path; the ReAct layer already provides semantic selection bounded by honest descriptions. A floor-gated semantic PROPOSAL ("I have a compiled gather for this — use it?") is the next rung, earned later with evidence. The shared primitive `findExplicitToolMentions` (word-boundary, bare-name aliasing for MCP prefixes) also guards plan `skill_check`: a matched skill whose steps never mention an explicitly named tool is ignored — explicit instruction outranks learned habit.
Also fixed the same evening: `document` tool takes markdown and renders through `markdownToHtml` + the fixed stylesheet (model-authored HTML drifted per run); CSV misdetection scoped to spreadsheet targets; narration collapsed to one line per tool streak.

### The A/B verdict: flow-gathered research works, and its first report caught a fabrication
First live run of the flow-first research path ("Research this week's AI developments… use the weekly_gather tool"): router → research → `flow_gather` returned **4 facets / 32 urls in 3.7s** → decompose/parse skipped → full editorial machine on flow-selected sources. `gap_check` fired on exactly the flow's thin lenses (model releases, policy) and patched them with fresh searches — the built-in corrective for the ossification bargain (frozen questions, live results; persistent gap-patching = the recompile signal). Verification extracted 14 claims, cross-checked 4, and **CONTRADICTED a fabricated "Claude Opus 5" release — corrected to Opus 4.8 from an independent source**. Total ~30 min, nearly all spent on synthesis + verification instead of improvised gathering. Editorially at least the equal of the search-gathered baseline. Skill hijack guard fired on the same run ("skill generate-report-from-web ignored") — first non-hijacked multi-shaped request of the night. Cron 44b13056 switch = Peter's call, pending.
**Two publishing defects found by the run, both fixed with regression fixtures:**
- **Decimal points are sentence boundaries too** — "Gemini 3.5" split at "3." exactly like URLs used to, splicing a correction mid-version-number ("Gemini 3.According to anthropic.com, 5 Flash Lite") and duplicating a ".5%" tail. Decimals now masked (digit.digit, same-length filler) alongside URLs before segmentation. The general lesson after two rounds of this: ANY dot that isn't a sentence terminator must be masked before segmentation — URLs, decimals, and whatever's next.
- **Charts rendered but never reached the PDF** — 2/2 PNGs on disk, blank in the report: LibreOffice resolves relative `img src` against the temp HTML's directory, not the repo root. Chart swap now emits absolute paths.

## The Agent Authored Flows — and Exposed Two of Our Bugs Doing It (August 1 2026)

### LocalClaw read the FlowMCP repo and drafted a HubSpot integration; the run was a fuzzer
**What happened:** asked about FlowMCP over Discord, the plan pipeline researched the public repo (step 1) and authored a complete HubSpot integration draft (step 2): `servers.json5` + five flows + README, now at `data/workspaces/main/flowmcp-hubspot/`. **The drafts are schema-valid against FlowMCP v0.4** — including the `env:` least-privilege field that shipped hours earlier (the agent's repo knowledge was fresher than its maintainer's). Doctrine absorbed from READING alone: WHEN-TO-USE-first descriptions with example phrasings, read-only downstream allowlist with the write tool deliberately excluded (the write FLOW exists but is inert until allowlisted — staged trust, unprompted), least-privilege env, a REST fallback flow for when the MCP server is down. Remaining gaps before "implementation-ready": HubSpot tool names unverified against the live server's tools/list; templates render raw JSON (needs transform steps); and it claimed "two-phase confirmation, no opt-out" — an overclaim against v0.4 that FlowMCP's v0.5 elicitation feature made true HOURS later.
**The run exposed two real LocalClaw bugs (both fixed):**
1. **Workspace path double-nesting** — the model echoed the workspace-prefixed path it saw in context; `write_file` joined it onto the workspace root again → `data/workspaces/main/data/workspaces/main/…`. read/write_file now strip a redundant workspace prefix deterministically before resolving (path-traversal validation unchanged, re-tested). Lesson: any tool that joins model-provided paths must assume the model echoes absolute-looking context paths.
2. **Narration violated the channel-coarseness rule** — seven consecutive write_file calls narrated "Using write_file…" seven times to Discord. The per-tool-call narration (added July 31) lacked the milestone-level guard the channel design deliberately enforces. Now one narration per tool STREAK: consecutive same-tool calls collapse; a tool change narrates. Lesson: a new observability channel must inherit the coarseness contract of the surface it emits to — "we did that deliberately" applies to features added later, too.
**Meta-observation worth keeping:** doctrine propagated agent-to-agent through nothing but a well-written public repo — the selection-surface and staged-trust rules arrived in a third agent that was never prompted with them. A repo's README/FORMAT is a training signal for every agent that reads it; write them as such.

### FlowMCP production pin: track upstream deliberately, verify per pull
The other Claude Code instance ships to FlowMCP main autonomously (v0.4→v0.5 in one day: elicitation, attestation drift-hash, hostile-ERP matrix). LocalClaw's exposure is bounded structurally: the bridge points at a dedicated clone (`~/FlowMCP`), updated by explicit pull + live `weekly_gather` verification per version (v0.4 ✓, v0.5 ✓ — compatible both times). Velocity upstream, promotion at our discretion — the same rung-by-rung trust model as everything else, applied to a collaborator that happens to be a model. Gotcha for the update drill: local `npm i` rewrites package-lock.json and blocks the pull — `git checkout -- package-lock.json` first (upstream's lockfile is truth).

## FlowMCP Integration: The Ossification Rung Above Skills (July 31 2026)

### Compiled workflows join the toolset — recurrence-proven paths stop paying inference prices
**What:** FlowMCP (Peter's standalone workflow-first MCP server, github.com/PeterGreenAppliedAI/FlowMCP) is wired in as a bridge server: production clone at `~/FlowMCP`, config entry `tools.mcp.servers[name=flows]` pointing at the compiled-flows dir, `mcp:flows` token on the multi specialist. First flow: `weekly_gather` — the AI-news cron's gathering phase (4 SearXNG searches + render), COMPILED from a captured agentic trace by FlowMCP's compiler v0. Declares `readOnlyHint`, so the bridge runs it silently. Verified live from the tmux lab: real gathered material in ~4 seconds. (Direct-shell test failed with `fetch failed` — the macOS TCC node-LAN block again; FlowMCP's child processes inherit the same constraint. Lab or production launch context required, as ever.)
**Why (the architecture, not just the plumbing):** skills and flows are two rungs of one hardening ladder. A skill is a SOFT recipe — "this sequence worked" — with the model still deciding each step: right for tasks with variation. A flow is a HARD program — zero model during execution, deterministic, ~free — and brittle to variation. The lifecycle: **explore agentically → recurrence makes it a skill → stability makes it a compilable flow → breakage demotes it back to exploration.** FlowMCP's own benchmark is the quantitative case: workflow-façade 79% vs 10% on a 40-tool primitive surface across local models; qwen2.5:7b went 6/6 @878 tokens on the façade vs 0/6 @6,768 on primitives — *selection is a different task than planning*. LocalClaw supplies discovery, trace evidence (skill successCount = the compilation signal), and the runtime; FlowMCP supplies ossification; the `.flow.json5` format is the portable membrane (deliberately agent-agnostic — no LocalClaw coupling in the flow format).
**The honest boundary:** gathering compiles; judgment doesn't. The 28.8-minute research run's flaky 6-facet sweep is flow material; synthesis and claim verification remain model-work. The compiled flow's digest quality vs the full pipeline is UNPROVEN — the deal is an A/B: run the flow-fed variant beside the real cron, compare digest quality + stage timings (pipeline_run metrics), and only then switch the production job. Until that comparison exists, `weekly_gather` is an available tool, not a replacement.
**Status:** wired + config-validated + live-verified at the tool level; restart pending; A/B pending. If the A/B shows snippets aren't enough, the finding is "the flow needs a fetch stage" — compiler work on FlowMCP's side, driven by observed pain.

## The 46-Fact Removal: Guards That Stop Floods Can Create Leaks (July 30 2026)

### Bare "!heartbeat no" removed 46 facts when the report showed 2
**Incident:** heartbeat proposed 2 stale facts; Peter replied `!heartbeat no`; the bot removed **46** — including most of his professional-identity layer (Sparks, Val partnership, Clearpath, workshops funnel) and health tracking. Root cause chain: the July 10 firehose guards capped stale proposals at 3 *per cycle* but the pending file MERGED across cycles — two-plus weeks unanswered quietly accumulated 46 candidates while each report displayed only the newest few (the "!heartbeat no 45" index was the visible tell nobody read). Bare `no` = remove-ALL by design, so consent was given against 2 visible items and executed against 46 invisible ones — the July 7 lesson ("the human is not a reliable validator of what they can't see") violated by our own accumulation.
**What saved it:** the removal ledger (`removed.jsonl`) held every text, and the handler's flat/graph divergence BUG (removal never touched FalkorDB) accidentally preserved the highest-value facts with full metadata. Diff analysis showed 41/46 were still-valid; restored 44 through BOTH stores (write-through like `!save`, re-tagged via the extraction model — which promptly invented the category "business relationship", re-proving that a model must never be trusted with a schema boundary; coerce to the closed set). 2 genuinely stale facts stayed removed. Flat 40/44 + graph 40/44 (dedup rejects = survivors, correct).
**Fixes (all structural):**
1. **The pending set is capped at ONE report's worth (5)** — Peter's rule verbatim: "there is never a reason for it to surface that many facts for removal at the same time." Commands can now only act on what the user is looking at, by construction.
2. Unanswered proposals **expire back to normal memory after 7 days** (cooldown ledger prevents instant re-proposal) — review is an offer, not a debt that compounds.
3. Bare `no` on a legacy oversized set (>5) removes NOTHING — lists everything and requires `!heartbeat no all`. Bare `!heartbeat` now lists the full pending set.
4. Reports state the TOTAL pending count when it exceeds what's shown.
5. Review denial now **removes from the graph too** — the divergence that saved us was still a bug (removed facts stayed injectable via graph KNN).
**Lessons:** (1) A per-cycle cap without a total cap converts a flood into a leak — guards must bound the ACCUMULATOR, not just the increment. (2) Any command's blast radius must equal the user's viewport, structurally. (3) Dual-store operations that only touch one store fail in both directions — this time divergence rescued data; next time it resurrects deleted data. (4) The removal ledger earned permanence: deletion without an undo trail would have made this unrecoverable.

## img2img: Correct Wiring, Broken Upstream (July 29 2026)

### "Make this picture anime" now routes right — and the backend ignores the picture
**Incident:** Discord user attached a photo + "make this picture animated in an anime style" → "I don't have image tools." Four stacked causes: (1) the unconditional image-attachment→chat override meant transform intent never reached the router while `image_generate` sat unreachable; (2) "But you can generate a picture of sonic" stuck to chat via sticky; (3) vision leaked gemma4's literal chain-of-thought as the image description (the qwen3 answer-in-thinking fallback backfiring); (4) the image box's IP had changed. All four fixed (transform-caption regex gates an `image` override with the saved path passed as reference_image_path; generation-ask keyword breaks sticky; CoT lead-in stripped from thinking fallback; Peter fixed the IP).
**Then Peter challenged the design** ("you setup a pipeline for a vision model to describe a photo to generate an exact replica?") — and the empirical test proved him right for a reason we didn't expect: a geometric reference image (red circle/blue square) vs a text-only control produced **near-identical generic outputs**. The tool sends the documented base64 `images` payload correctly; **Ollama's Flux2-Klein serving discards the source image** — open upstream bug ollama/ollama#14306, broken since ~0.15.6, reproduced by users through 0.30.8; our server runs 0.21.2.
**Response:** keep the (correct) wiring — img2img starts working the day upstream fixes it — and add an honesty caveat to the tool result whenever a reference was supplied, so the model tells the user the original was NOT preserved instead of claiming an edit it never performed (phantom-PDF over-claim class).
**Lessons:** (1) "The tool has an img2img param" is a claim about the REQUEST, not the backend — verify the far side of every contract with a distinguishable probe (the geometric reference made ignoring it unmissable). (2) When a capability silently degrades, the first casualty is honesty — over-claim guards belong in the TOOL RESULT, where the model can't miss them. (3) Peter's design challenge caught what tests didn't: adversarial owner review, again.
**Real img2img options (deferred, dial list):** wait for #14306; or ComfyUI/Forge on the image box with a proper init-image + denoise API (new tool client — the robust path if photo-editing becomes a real use case).

## Lessons: The Agent Gets Its Own DECISIONS.md (July 29 2026)

### Negative procedural memory — "approach X failed for task-shape Y; the boundary is Z"
**Origin:** a conversation about why the BUILD agent stays coherent across sessions — DECISIONS.md is its causal memory of failures and boundaries. Peter's realization: LocalClaw's runtime agent had no equivalent ("huh, shit you're right"). errors.jsonl records raw tool failures and LEARNINGS.md gets tool-level one-liners, but nothing captured approach-level boundaries. This applies the project's best pattern one level down: the system now has THREE memory systems — FalkorDB (who the user is), skills (what worked), lessons (what didn't and where the line is).
**The three hard questions and their answers:**
1. *How does the agent know a failure happened?* It doesn't — CODE does. Candidates are harvested (`lesson-harvester.ts`, pure code, marker-tracked) from evidence already on disk: max-iteration dispatches (logDispatch now carries a `messagePreview` so failures have a request SHAPE), repeated tool failures at the existing ≥3 threshold, narration-repair clusters, rejected/failed autonomous actions, dead letters. The model's only job is filling a grammar-constrained lesson slot in the heartbeat — it never self-assesses in the hot path, and a 9B-honest limitation is accepted: these are observations-with-wounds, not root-cause diagnoses; the deep entries still come from build sessions.
2. *Storage?* Markdown files (`workspace/lessons/*.md`), skill-store shape: boundary one-liner in frontmatter (the ONLY text ever injected), `model` at time of observation (a phi4-era lesson may be false under DeepSeek — lessons are point-in-time, same doctrine as facts), evidence_count, triggers. Embeddings are the fourth EmbeddingStore tenant (`source='lesson'`; skill semantic helpers generalized to serve both).
3. *When sourced, on a small-model budget?* Never the corpus. Floor-gated KNN one-liners (max 2) in user priming — zero hits = zero tokens — plus tool-tagged boundaries through the existing `findHints` pre-execution seam (lessons outrank raw error strings there: they carry the synthesized boundary).
**The intake decision (Peter's call):** auto-save at evidence:1, but **injection requires evidence ≥ 2** — a one-off failure is noise until it recurs, and recurrence is a code gate, not model judgment. This threads between the two bad options: propose-confirm-everything (review fatigue → the July-10 firehose / reflex-confirm problem) and inject-immediately (one hallucinated boundary silently steers every matching dispatch). Reversibility justifies the auto-save: heartbeat report lists new lessons, `!lessons drop <slug>` kills one. Firehose guards ported from stale-facts: max 3 new per cycle, batch-distrust when the synthesis model marks everything worth keeping.
**Floor:** starts at the measured skill floor 0.65 (same embedding model, same text shape); `scripts/lesson-floor-check.ts` re-measures once ~5 real lessons exist — floors are measured, never guessed.
**Deferred with triggers:** transcript-level user-correction harvesting (fuzzy — needs its own precision work once code-signal lessons prove out); `lesson_find` pull tool (if one-liners prove insufficient).

## The Skill System Was Dead for Three Months — Resurrection by Autopsy (July 25 2026)

### Peter: "I dont see that actually working. It just keeps either skipping it or making a fresh skill"
**Autopsy (all three causes compounding, evidenced on disk — every skill dated Mar 29–Apr 19, nothing since):**
1. **Wrong scope.** `skill_check`/`skill_save` existed ONLY in the plan pipeline (`multi` category). As dedicated pipelines (research/document/analytics/cron) took over traffic, the skill system's only entry point stopped being visited. A feature attached to a category is only as alive as the category.
2. **The generalizer and the matcher fought each other.** Save-time LLM generalization deliberately strips specifics ("weather Long Island PDF" → "retrieve data from an external source based on specific criteria") while the keyword matcher needs overlap with the user's SPECIFIC goal — and its stop-word list banned `report`/`search`/`create`/`make`, the only content words generalized descriptions contain. Two components, individually sensible, jointly guaranteed silence.
3. **No save-time dedup.** The only duplicate check was exact slug collision; a different generalized NAME for the same pattern minted a sibling file. Three copies of web→report existed (`generate-report-from-web`/`fetch-and-format-report`/`generate-and-convert-content`). Bonus: the heartbeat guard was a string-match on the message text — `execute-heartbeat-tasks` had success_count 22.

**Rebuild (all shipped, 593 tests green):**
- **Embedding-based matching** as primary (skill text = name + description + `triggers`; stored in the existing EmbeddingStore under `source:'skill'`, stable `skill:<slug>` ids), keyword scorer as fallback with the load-bearing stop-words removed. New `triggers:` frontmatter preserves up to 5 CONCRETE past requests — the generalizer can keep generalizing because triggers carry the specifics. Floor MEASURED at 0.65 against real qwen3-embedding (noise ≤0.604, signal ≥0.700) — the 0.60 guess would have false-positived on "what did we talk about yesterday" at 0.604; same lesson as the memory floor: qwen3-embedding's baseline similarity runs high, floors must be measured, never guessed.
- **Save-time dedup ladder:** exact slug → hybrid match on the original request → grammar-constrained judge against the catalog (`{decision: new|update|skip, slug}`) → genuinely new. `update` revises the EXISTING file (trigger append, success bump, variant-sequence note) — slug-addressed revision, never a sibling.
- **Structural guard:** `cronMode` threaded into PipelineContext; heartbeat/cron can no longer match or save skills regardless of message wording.
- **Progressive disclosure beyond `multi`:** new `skill_find` tool (read-only) lets ReAct specialists pull proven step sequences on demand — the catalog stays out of the prompt (OpenWorker's pattern, adapted). Deliberately no recordSuccess on lookup: finding ≠ completing.
- **Observability:** skill_matched/saved/updated/skipped all flow through `logAutonomousAction` — the live log now shows the system breathing, which is how the next silent death gets caught in days not months.
- One-time cleanup script merges the dupes, archives the heartbeat-born skills, backfills embeddings (`scripts/skills-cleanup.ts`, run from the lab).
**Lessons:** (1) A learning loop needs a liveness signal — this one had zero log lines on the skip path, so three dead months looked like quiet health. (2) When one model call WRITES what another model call must later MATCH, design them as a pair; generalization without preserved specifics is lossy compression of the matching key. (3) Save-time dedup must compare against the CATALOG, not just the key you're about to write.

### Cron runs, remote MCP, and the cheap-wins sweep — OpenWorker harvest complete (July 25 2026)
**Cron runs are auditable now:** every run persists its own session (`cron:<job>:<run>` — fresh context via unique key, continuable transcript), deliverables are captured by CODE (workspace mtime-window scan; gotcha for the record: **macOS mtimeMs carries sub-ms precision and measured 0.66ms AHEAD of Date.now()** — an unpadded until-bound silently dropped a just-written artifact in tests), runs land in capped `data/cron-runs.jsonl`, failures in a `data/unrouted.jsonl` dead-letter store surfaced by `!autonomy`. Scheduler gained skip-on-overlap and boot catch-up-once (a reboot at 8:59 no longer eats a 9:00 one-shot reminder).
**Remote MCP, fully local:** `McpHttpClient` (streamable HTTP: JSON + SSE responses, Mcp-Session-Id echo) behind the same interface as stdio — the swap seam built July 20 paid off in one file. Auth is OAuth 2.1 + PKCE + **Dynamic Client Registration** — DCR is what makes "no cloud broker" possible (no pre-registered client secret to hide). Tokens in the new `SecretStore` (0600, atomic, `status()` never leaks values). **The `interactive` boundary is structural:** the browser-opening flow exists ONLY in `scripts/mcp-oauth-setup.ts`; every runtime path does stored-token + silent-refresh and throws a clean re-auth error — OpenWorker shipped the authorize-page-at-launch bug; we made it unrepresentable.
**Cheap wins:** `logAutonomousAction` approval/resource columns (promotion evidence is queryable); MODEL_CAPS declared capability matrix (extractor consults it before trying `format`; runtime fallback kept as net); absolute-date + verify-still-exists memory guidance; **steering queue** (messages typed mid-dispatch inject into the running ReAct loop between iterations; undrained leftovers replay as normal messages, finally-guarded so a crash can't wedge a session busy); deterministic per-tool narration lines (zero model cost).

### Confirm buttons, deny, and continuation — closing the confirm-gap UX (July 25 2026)
**Buttons as typed-reply sugar:** Discord components / Telegram inline keyboards render ✅ Confirm / 🔓 Always / 🚫 Deny under previews, and a press SYNTHESIZES the equivalent typed message through the normal inbound path into the one `handleConfirmation` choke point. Design rule worth keeping: **an interactive affordance must never become a second security surface** — buttons inherit sender-binding, single-use, expiry, and principal resolution for free because they ARE typed replies. Buttons strip themselves on press; a stale second press just gets "doesn't match".
**Deny is now explicit** (`deny|cancel|reject <id>` → consume without executing, logged `rejected`) — before, denial was only expiry, so a refused preview stayed confirmable for its whole TTL. Subtlety that matters: deny verbs are NOT near-miss-guarded ("cancel the daily search" is a cron request and must reach the router; cron ids are also 8-hex, so `cancel 15e8b662` with no matching pending entry FALLS THROUGH to routing instead of erroring — safe for deny because denial has no execution risk, unlike confirm near-misses).
**Continuation-after-confirm:** a confirmed action's result dispatches ONE follow-up turn into the originating session with the ORIGINAL category's toolset (category now stored on ledger entries) — multi-step work no longer dies at the preview. Gated by `session.continueAfterConfirm` (default on); confirm-gated calls inside the continuation are gated again, so there's no approval loophole.
**Dropped consciously:** OpenWorker's interrupted-tool-call hygiene — LocalClaw has no mid-turn abort machinery to clean up after; building abort just to need hygiene is YAGNI. Revisit only if a user-stop feature lands.

### Target-bound standing grants — the missing rung of the autonomy ladder (July 25 2026)
**Harvested from the OpenWorker deep-dive and adapted.** Between propose_confirm (ask every time) and `autoApproveTools` (never ask, tool-wide) there was nothing — so promotion was all-or-nothing. Now: tools may declare `targetArgs` (the params naming their external target; `send_message` → `['channel','channelId']` → grant key `discord:123`). Replying **`always <id>`** to a confirm preview executes it AND mints a standing grant for that exact tool→target pair; future identical-target calls run silently (`act_then_notify`, logged with the grant source). **Structural properties:** tools without targetArgs (exec) are grant-INELIGIBLE by construction; grants mint only from an explicit id'd confirmation, only on successful execution; exact-string match, principal-bound, file-backed, revocable via `!grants revoke <id>`; "always" with a bad id is a near-miss error, never chat fall-through. Plus an **implicit reply-origin approval**: sending to the exact conversation the request came from doesn't ask — permission ceremony to reply to the person who just asked was pure friction. Preview text now offers both: `confirm <id>` / `always <id>`.
**Why this shape:** the July 7 incident proved the reflex-confirm is real — every unnecessary ask trains it. Target-bound grants cut asks precisely where trust is earned (one destination) without widening the blast radius to the whole tool. It's also what `logAutonomousAction`'s track record was FOR: the metrics justify each grant, and the grant is the promotion.

## MCP Client Bridge: The Ecosystem for the Price of One Protocol (July 20 2026)

### Any MCP server's tools become LocalClaw tools — security stack inherited for free
**Origin:** an NVIDIA demo (Agent Toolkit + Blender MCP on a DGX Station) that Peter wanted to reproduce locally. Decision: don't hand-wrap Blender as a one-off tool — build a generic bridge (`src/mcp/`) so `blender-mcp` is merely the first consumer and every other MCP server (filesystem, GitHub, hundreds more) comes along.
**Three interrogated decisions:**
1. **Zero-dep protocol client, not the official SDK.** We use ~10% of MCP (initialize / tools/list / tools/call over newline-delimited stdio JSON-RPC) — the oldest, most stable slice of the spec. ~200 owned lines mean our error factory, our timeouts, one file to debug at 10pm from the live log. Honest counter-case recorded: the SDK absorbs spec drift and server handshake quirks for free — if resources/prompts/sampling/remote servers become wanted, swap it in behind `McpManager` (the interface doesn't change).
2. **readOnlyHint-aware autonomy default.** MCP tools are external processes doing real things. Tools the server annotates read-only run silently; everything else lands `requiresConfirm: true`. Per-server `trust: 'auto'` waives it — owner-authored config as the code gate, same doctrine as cron's category waiver. All-confirm was rejected because 15 confirms per Blender scene trains the reflex-confirm the July 7 incident proved is real; all-silent was rejected by the ladder ("new externally-visible tools start at propose_confirm").
3. **stdio only in v1.** HTTP transport's trigger is a server on another machine (likely: Blender on the Windows GPU box while LocalClaw stays on the Mini).
**Small-model layer (the part that makes it work on 7-30B):** MCP servers write descriptions for frontier models. Translation caps them at 500 chars on a sentence boundary; per-server `toolAllowlist` (don't drown a 14B model in 40 tools), `toolDescriptions` hand-rewrites, `maxResultChars` via a new per-tool `resultLimit`. Tool names are `<server>_<tool>`; specialists opt in with one token — `"mcp:blender"` in a tools list expands to the server's whole set at dispatch (`registry.expandToolNames`), so config doesn't chase runtime tool names.
**Integration wins that cost nothing:** name-based channel security (blockedTools/ownerOnlyTools/autoApproveTools) applies unchanged; MCP write tools flow into the metadata confirm set automatically; image content (Blender screenshots) becomes `[FILE:]` tokens riding the existing media pipeline; `isError` results become model-visible `Error:` strings the error-learning store already knows how to record.
**Resilience:** failing server skipped at boot (plugin-loader doctrine), crashed server lazily respawned on next call (FalkorDB doctrine), children killed on orchestrator stop AND REPL exit.
**Testing:** the fixture is a REAL ~80-line MCP server (`test/mcp/fixtures/fake-server.mjs`) spawned as a real child process — handshake, timeout, crash, noise-on-stdout, image content, RPC errors all integration-tested, not mocked. 33 new tests, suite at 564.
**Post-ship fix (July 25):** tool names are sanitized to `[A-Za-z0-9_-]{1,64}` (prefix-preserving truncation, collision suffixes) — MCP servers may use dots/slashes in tool names, and the vLLM/OpenAI path REJECTS those; the bridge shipped passing them through raw (caught by comparing against OpenWorker's client, which sanitizes). The server still receives the original name; only the model-facing registry name is cleaned.
**Deferred with triggers:** HTTP transport (remote server), tools/list pagination + listChanged (logged if ever seen), LLM description summarization (if hand-curation gets old), SDK swap (if protocol ambitions grow).

## The Three Reminders: Every Seam in the Cron Path at Once (July 20 2026)

### Incident — "set up three reminders" hit four independent defects in nine minutes
**Timeline (production, 10:45–10:50 AM, Discord):** The owner asked for three September reminders in one message. (1) The cron pipeline's extraction enum offered category `task`, but `cron_add` kept its OWN hand-copied category list that predated `task`/`research`/`personal` — the tool rejected what the extractor was told to produce, and the raw error string was delivered as the reply. (2) On retry the pipeline created only ONE of the three jobs — the add branch extracted a single job and silently dropped the rest — and created it as a RECURRING yearly job because the pipeline never extracted the `once` flag built for exactly this. (3) "We did all three or just the one?" routed to `memory` (cron wasn't sticky) and the memory pipeline "answered" from a fact saved at `!reset` minutes earlier — confident confabulation instead of a `cron_list` call. (4) The re-paste of the two missing reminders broke sticky on a false keyword hit — `\bsetting\b` in the config pattern matched "**setting** up a business structure" — then model-routed to `personal`, whose specialist hallucinated `cron_job_create`, was correctly blocked by the registry (the one layer that held), and declared no scheduler exists.
**Fixes (all deterministic):**
1. `CRON_JOB_CATEGORIES` in `src/cron/types.ts` is the single source — cron_add, cron_edit, AND both pipeline extraction enums import it; a test asserts all four are identical. Same bug class as Zod-vs-hand-written types: two hand-maintained copies of one list WILL drift.
2. The extractor now supports array-of-object fields (recursive `items` schema, per-element validation with indexed errors, grammar-constrained) + per-stage `maxTokens` (the 256 default cannot fit three reminder texts). The add branch extracts `jobs[]`, fans out via the existing `parallel_tool` stage (store writes are synchronous → race-free), and the confirm stage DISCLOSES partials: "Only 1 of 3 created" — the silent partial was the most corrosive failure of the four.
3. `once` extracted per job (with a dated-reminder example), passed through, and editable (`cron_edit` + edit branch + `CronJobUpdate.once`). Confirmations now state "one-shot … next run Sep 15, 2026 (runs once, then auto-disables)" vs "recurring" — the yearly-instead-of-once mistake is only catchable if the firing semantics are in the reply.
4. Routing: `cron` added to STICKY_CATEGORIES (post-scheduling follow-ups belong to the cron pipeline, whose list branch answers from `cron_list`, not memory); config keyword tightened to `settings?(?! up)`; router prompt says dated reminders are cron even when the content is personal/business, and `personal` explicitly CANNOT schedule.
**Lessons:** (1) When a pipeline hands a model an enum, the enum and the tool's validation must be the same object — an extraction schema is a PROMISE the tool has to honor. (2) Partial completion without disclosure is worse than failure: the owner had to ask "did we do all three?" and got a confabulated answer — every fan-out stage must compare requested vs created and say so. (3) A question about what the system just did must reach the subsystem that did it — sticky-category is the cheap mechanism for that. (4) Keyword overrides that break sticky need the same precision bar as pre-model overrides ("setting up a business" is not a settings request).
**Also caught in the same sweep:** four prep-context tests had silently rotted on main — the store's retention pruning used wall-clock `Date.now()` while tests inject `now`, so July 8 fixtures aged out of the 7-day window ~July 15. `load()` now takes injected time. Time-frozen fixtures + wall-clock pruning = tests that pass until the calendar breaks them.
**Watch item (not fixed):** the personal specialist's final answer was delivered twice — the model wrote its answer twice in one completion. If it recurs, look at the answer path in engine.ts, not delivery.

## FalkorDB: The Volume That Wasn't (July 14 2026)

### Two months of graph memory lived in a disposable container layer
**Found during a routine image update:** the May container mounted its volume at `/data`, but FalkorDB persists to `/var/lib/falkordb/data` (its `FALKORDB_DATA_PATH`) — the volume was EMPTY and the real `dump.rdb` sat in the container's writable layer. A plain `docker rm` at any point since May would have destroyed all graph memory (1,301 turns, all facts/entities). The update procedure caught it only because step one was "verify where the data actually is before removing anything."
**Fix:** host-side RDB backup first (`data/backups/falkordb-dump-2026-07-14.rdb` — keep forever), old container preserved until verification, new container mounts the volume at the CORRECT path and got `--restart unless-stopped` (was `no` — memory also silently died on every Mac reboot until manually restarted). Counts verified identical post-upgrade; HNSW vector search verified live (version upgrades are where vector indexes silently break).
**2026-08-14 update (4.2.0 → 4.2.3):** same procedure, clean run — backup `falkordb-dump-2026-08-14.rdb`, old container preserved as `falkordb-old-20260814`, counts identical (2,462/1,075), HNSW verified with a live KNN query (index *existing* ≠ index *serving*). Mount path and restart policy from the July fix held.
**Lessons:** (1) A mounted volume proves nothing — verify the process's actual persistence path writes INTO it (`redis-cli CONFIG GET dir` + ls both paths). (2) Infra updates start with "where is the data, really," not with the update. (3) macOS keychain blocks docker pulls over SSH — pull via the tmux lab session (GUI keychain) — same family as the EHOSTUNREACH entry.

## Document Vault: Folders Are the Taxonomy (July 9 2026)

### A domain-organized document store as source of truth — designed by interrogation
**Origin:** Peter asked whether Obsidian would help for documents-as-source-of-truth. Resolution: don't adopt Obsidian, adopt THE VAULT — a plain folder of markdown/PDF that Obsidian happens to edit well. Editor and data decoupled; zero dependency. He then rejected a fancy frontmatter/`applies_to` doctrine-routing design in favor of "folders are the taxonomy: business/, coding/, ..." — and stress-tested every hand-wave until the spec was real (chunking strategy? unstructured docs? no numbered sections? retrieval mechanics?). The design improved at every challenge; adversarial owner review before build is as valuable as the fresh-eyes audit after.
**Shape:** `vault/<domain>/*` → normalization ladder (markdown heading-path chunks → heuristic heading promotion → semantic-valley segmentation via embedding dips — deterministic math, no generative model ever touches document text → paragraph fallback; tier logged per file) → hybrid retrieval (dense ∪ FTS5 lexical fused by reciprocal rank — doctrine is term-anchored, "Gate 4" must hit exactly; floor 0.45 pending corpus measurement; per-file cap; adjacent stitch with combined provenance; budget pack) → `docs_search`/`docs_store` tools; heartbeat reindexes by mtime+hash. Every search logged for tuning.
**Test-caught bugs worth remembering:** (1) contentless FTS5 (`content=''`) does not store UNINDEXED columns — joins silently return nothing; use contentful tables. (2) Query-term regex `{2,}` dropped single digits — "Gate 7" searched as "Gate". (3) Runt-section merging at 120 chars swallowed adjacent rubric gates into one chunk labeled with the WRONG heading — provenance-correct thresholds beat tidy-looking chunks (now 40). Each found by a test asserting on real retrieval shape, not by review.
**Deferred with triggers:** LLM-assisted structuring for hopeless walls of text (when tier-3 list shows retrieval pain), reranker (evidence first), ANN/HNSW migration (>50k chunks — FalkorDB already serves HNSW), auto-injection of doctrine into pipelines (tool-initiated retrieval first; watch usage).
**Status:** Built, 522 tests. Seeded with the code-review rubric. vault/ is gitignored — personal content never enters the open-source repo (the person-literals rule extended to person-documents).

## The First Real Save: Misroute Chain vs the Confirm Gate (July 7 2026)

### Incident — the gate contained what routing broke, including a reflex confirm
**Timeline (production, 4:05-4:14 PM):** The owner answered a briefing prep question in Discord ("David is going on the podcast, I just need to get him a Riverside link"). The router classified the ANSWER as a `message` command; extraction fabricated a WhatsApp target (a Discord-shaped snowflake) with his own words as the text; the confirm gate previewed it. The owner **reflex-confirmed without reading**. The stored action executed — and the WhatsApp adapter refused the invalid target: **nothing was ever delivered**. He then asked "did you actually send a message?" — which ALSO routed to `message`, and the pipeline's anaphoric rewrite rebuilt fresh send params from conversation history (the earlier preview JSON), proposing a SECOND send. He didn't confirm that one. Net harm: zero, minus some trust.
**What worked:** every layer of the July autonomy build held — the gate previewed both times, stored-params execution ran exactly what was shown, the ledger/metrics recorded every step (which is how the incident was reconstructed to the minute), and the invalid fabricated target was unsendable. Without this stack, the 4:05 message sends immediately.
**What broke (all fixed, all deterministic):**
1. Briefing replies now presume answerhood — sticky to chat ('briefing' in STICKY_CATEGORIES with target chat); only imperatives or keyword hits break out. The fuzzy new-topic patterns ("get…a…") are tuned for chat drift and misfire on answers.
2. Meta-questions about the agent's own actions ("did you / have you…") are a pre-model chat override — a question about an action must never BECOME an action. Past/perfective second-person only; polite commands ("can you send…") untouched.
3. The anaphoric history rewrite never runs for the message pipeline — a send must come from the user's explicit words; history had become a parts-bin for fabricating sends.
4. `validate_target` stage: extraction-produced targets must be format-plausible for their channel (jid/chat-id/snowflake/slack patterns) or match the conversation's own channel — otherwise the pipeline ASKS instead of proposing.
5. Preview + confirm honesty: gate previews render as "⏸️ Not sent yet … to `<target>`" (was "Failed to send message: <JSON>"); confirmed actions whose tool returns an error string now reply ❌ and log outcome `failure` (was "✅ Ran send_message: Error…" — a success mark on a failure).
**Lessons:** (1) The reflex confirm is REAL — the owner confirmed without reading within 2 minutes of the feature's first misfire. Previews must put the scary part (who receives it) in plain words, and structural validity checks must run BEFORE anything reaches the human, because the human is not a reliable validator. (2) An agent's conversation history is attacker-shaped input to parameter extraction — never let a rewrite stage synthesize action params from it. (3) Meta-conversation about the system is a routing category of its own; treat it as chat by rule. (4) The metrics ledger paid for itself on day one — the incident was reconstructed entirely from `autonomous_action` events.

## Self-Identity in Prompts: Config, Never Code (July 7 2026)

### Models must recognize the user in content metadata — from config only
**Problem:** the briefing asked "What is the context for the meeting with David regarding Peter Green?" — the model saw "booked by pgreen@devmesh.tech" in calendar metadata and treated the user as a third party. The principal layer taught the SYSTEM who the user is; the MODEL had never been told.
**Constraint (Peter's, and now a standing rule):** this is an open-source app — no person may ever be hardcoded in a prompt. Kin to "no model literals in logic": no PERSON literals in prompts.
**Fix:** `PrincipalSchema` gained `displayName` + `emails`; `selfIdentityLine()` (identity/principal.ts) assembles the prompt line entirely from config ("The user you are assisting is X. These are THEIR OWN addresses…"), returns null when unconfigured. Injected into the briefing prompt and prep prompt. Verified live: the question became "What is the agenda for your meeting with David?"
**Status:** Active. Candidate follow-up: inject the same line into specialist prompts that read email/calendar (personal category).

## The Morning After: Migration Starved the Briefing's Memory (July 7 2026)

### First production 8am briefing — conflict caught, but prep silently absent
**What the owner received at 8:00:** correct schedule, the Val/David overlap flagged with exact interval language (the new deterministic detector), a memory-driven insight (Val↔Domo — unified-memory payoff), and a working `!heartbeat no` round-trip that removed facts from the PRINCIPAL bucket. But NO prep section — no questions, no confirmable proposals.
**Debug path (empiricism, no theorizing):** calendar parser probe on real text → OK. Full harness re-run → reproduced: no `[Prep]` failure warning, so the model call succeeded and returned nothing actionable. Raw-output probe → DeepSeek was answering "none" for almost everything, validly.
**Root cause:** the briefing log's own `memory=18 chars`. The briefing/heartbeat tool contexts still passed the RAW delivery target as senderId — post-migration that bucket is empty; the person's memory lives under `peter`. With zero user context, "prefer none over inventing busywork" produced exactly what it says. Fixed: principal-resolved senderId in both services' toolCtx + the briefing's stale-facts read. Verified: memory 18→236 chars, prep section back (two intake questions; TKD reminder correctly deduped against last night's still-open proposal).
**Lessons:** (1) An identity migration isn't done until EVERY read path is audited — grep for the alias, not just the write sites; the two missed spots were toolCtx constructions, not memory calls. (2) "Model returned none" and "model was starved of context" are indistinguishable from the outside — when a judgment stage goes quiet, check what it was SHOWN before blaming its judgment. (3) The `memory=<n> chars` context log line is what cracked this — keep sizing logs on every model-facing context assembly.
**Recurring cosmetic:** DeepSeek name-slips in prep questions (wrote "Val" in David's question twice across runs). Harmless, watch for pattern.

## First Real Proactive Briefing + the Determinism Rubric (July 7 2026)

### The proof run — real calendar, real conflict, real confirmable proposal
**What happened:** `scripts/briefing-live-check.ts` runs the PRODUCTION briefing path (real Google Calendar OAuth, real unified memory under the principal, real DeepSeek, real pending-action ledger, real session-transcript append) with only the channel send stubbed to stdout. First run against live data: correct schedule, the genuine Val/David 11:00-vs-11:15 overlap flagged, a confirmable one-shot TKD reminder proposed into the live ledger, and intake questions asked for both under-specified meetings — the owner's original vision sentence, on his actual life.
**Blemishes recorded:** DeepSeek name-slipped in one question (wrote "Val" for David's meeting — cosmetic); and the conflict catch came from the MODEL, because the code detector only matched identical start times (fixed below).

### "Does this need to be deterministic if the model catches it?" — the rubric
Peter challenged whether conflict detection needs code at all, since DeepSeek caught the overlap. Resolution — determinism is required when ALL of:
1. **Silent-miss harm** — a missed catch = real-world damage discovered too late (double-booked at 11:15), with nothing signaling the miss;
2. **Objectively computable** — the check is enumerable (interval intersection), not judgment;
3. **Floor-sensitive** — model-layer detection makes the feature's reliability silently track whichever model is in the swappable slot.
Model judgment remains the right layer for everything fuzzy: soft conflicts (back-to-back across town, travel time), topical connections, "you always run over with Val." Code guarantees the floor; the model provides the ceiling.
**The kicker that decided this case:** the system had ALREADY voted for deterministic — a code detector existed and the prompt declared it AUTHORITATIVE — but it compared start times for equality, so it missed the real overlap and DeepSeek freelanced around its own instructions to save the user. Worst possible configuration: prompt declares a wrong layer authoritative. Fixed: `findScheduleConflicts` (temporal/urgency.ts) does interval intersection, tested incl. the live case, back-to-back non-conflicts, and AM/PM handling.
**Status:** Live-proven. Remaining known gap: multi-day events / midnight-spanning intervals not handled (calendar output format doesn't produce them today).

## Prep Proposals: Never Ask a Model to Construct a Timestamp (July 7 2026)

### The whenISO failure — a rail violation caught by live testing
**Symptom:** the prep-proposal live check on real qwen3.5:9b returned an empty section. Raw output showed the model burned its ENTIRE 1024-token budget on prose reasoning about timezones ("If this is UTC, it's very late night in Europe...") and never emitted the JSON array. Unit tests (mocked model) were all green — the failure only exists with a real small model.
**Root cause:** the prompt asked the model to construct `whenISO` (an ISO-8601 timestamp with offset) from calendar text like "Wed, Jul 8 2:00 PM". That's date math + timezone reasoning pushed into the model — a direct violation of "code decides, model executes," written by the same session that documented the rail hours earlier. The builder blind spot is real.
**Fix (the on-principle shape):** CODE parses calendar lines into structured events (`parseCalendarEvents` — the regex already existed in briefing conflict detection) and does ALL time math in the configured timezone (`zonedDate`/`cronForDate`, two-pass Intl offset, DST-tested). The model now returns only `{event: <number>, action, reminder?: {minutesBefore: <integer>, message}}` — an index and an integer. Also fixed en passant: the original `isoToOneShotCron` built cron fields with server-local getters, but croner interprets expressions in the CONFIGURED timezone — worked only because the Mac's zone matches config.
**Result:** live PASS on deepseek-v4-flash first try — asked the intake question for a context-less meeting, proposed a memory-informed prep task, skipped the dentist, and the proposal was confirmed from a different channel alias (principal binding) with stored-params execution.
**Lessons:** (1) A model's output schema should never contain anything code can compute — every such field is a place for a small model to drown. (2) Mocked-model unit tests cannot catch "the model can't actually produce this" — every model-facing prompt needs one live-model run before it ships. (3) num_predict ceilings turn model rumination into silent empty outputs; prefer output shapes too small to ruminate over.

## Confusion Audit of the Autonomy System (July 6 2026)

### Fresh-eyes audit found 4 real bugs the builder couldn't see
**Context:** Peter: "I don't think we've created the best autonomous workflow, it feels confusing — even to me." A 4-agent audit (owner-UX / config-surface / mental-model lenses + synthesis) reviewed the just-built autonomy system with no stake in defending it. Verdict: the safety was sound, the SURFACE had three vocabularies for one concept and several interaction bugs.
**Bugs found and fixed same night:**
1. **"Reply with details" was structurally broken** — briefings were channel-sent but never appended to any session transcript, so a reply to a prep question dispatched into a session that never saw the question. Fixed: the delivered briefing is appended to the owner's session on the delivery channel (`category: 'briefing'` turn).
2. **Stale-proposal misfire** — loose confirm synonyms ("go ahead") matched the LATEST pending action, and briefing proposals live 12h; a casual "go ahead" hours later fired a morning proposal as a non-sequitur. Fixed: bare confirms only match entries `< BARE_CONFIRM_MAX_AGE_MS` (10 min) old on the same channel; long-TTL proposals require `confirm <id>`.
3. **"confirm 2" fell through to chat** — the id regex wants 6-12 hex chars, so a natural short reply matched nothing and routed to the model, which could hallucinate "Done!". Fixed: `CONFIRMATION_NEAR_MISS` catches confirm-verb + short token and replies with an error + the open-proposal list. ("confirm my flight booking" still routes to chat.)
4. **`!heartbeat no 2` renumbering drift** — partial removal rewrote the pending file (positions shift) while the owner's phone showed the old numbers; the next `no N` could delete the wrong fact. Fixed: the reply now prints the renumbered remaining list.
**Simplifications applied:** `ToolAutonomy {tier, reversible, blastRadius}` collapsed to ONE bit — `requiresConfirm?: boolean` — after the audit verified `reversible`/`blastRadius` were never read by enforcement and silent vs act_then_notify were behaviorally identical (tier labels live on in metric events, where they mean something). The dead `DispatchParams.confirmed` bypass flag (zero setters, shaped exactly like the hole the ledger closed) deleted. Config footguns now warn at load: restrictedTools/Categories with no trustedUsers (= applies to EVERYONE), tool in both confirmTools and autoApproveTools (autoApprove ignored).
**Deliberately NOT done (owner's call):** the full one-inbox unification (`ok N` / `no N` replacing hex ids + `!heartbeat yes/no` + free-text) — blueprint preserved in CONTINUATION.md for a future session.
**Lesson:** the builder of a multi-surface UX cannot audit its coherence — every concept feels earned to the person who added it. Fresh-eyes agents found in one pass what two nights of building never noticed, including one structurally-broken headline feature. Audit user-facing surfaces with reviewers who didn't build them, BEFORE shipping to the owner.

## Calendar Prep Proposals — First Proactive Autonomy Rung (July 6 2026)

### The briefing now proposes executable actions, not just insight text
**Decision:** A structured prep stage after the briefing CoT (`src/services/prep-proposals.ts`, config: `briefing.prepProposals`, default on): per upcoming event (48h window) the model chooses from a CLOSED action set — `question` (ask the user for context: "your 2pm with John — what's it about? I can prep notes or a reminder"), `reminder` (one-shot cron), `task` (task_add), or `none`. Code validates against the registry, does ALL date math (ISO→one-shot cron in `isoToOneShotCron` — the model only names a moment), builds the exact tool params, and records proposals in the pending-action ledger with a 12h TTL. The briefing lists them with `confirm <id>` handles. NOTHING executes unconfirmed.
**Why this shape:** Peter's stated flow — "the agent can be like: hey, there isn't enough information, is there anything you want to tell me that I can help preparing?" The question action IS the intake/clarification flow, applied to calendar first. Model fills bounded slots; code owns the envelope — same inversion of control as everything else.
**Supporting changes:** ledger got id-targeted confirmation (`confirm 3fa2c1b9` — briefings propose several), channel binding on bare confirms (generic sender ids like "console-user" could collide across channels), per-entry TTL (10min interactive / 12h briefing), and confirmed actions now write to the session transcript. `!autonomy` command renders the per-action track record + promotion candidates (≥20 decided outcomes at ≥95%) + open proposals.
**Gotcha — one-shot cron didn't exist:** a 5-field expression like `30 8 7 7 *` fires EVERY YEAR. Any "remind me tomorrow" reminder would have haunted the owner annually — a pre-existing bug in every reminder flow, exposed by this feature. Added `once: true` to CronJob: the service disables the job after its first successful run. cron_add accepts it; prep reminders always set it.
**Gotcha — briefing prompt says "NEVER ask questions":** deliberate for the one-way insight; the prep section is a separate structured call so questions live there without softening the main update's rules.
**Deferred to next rungs:** gmail in the briefing context (needs a slice decision), research/agenda-doc prep offers, promotion application from the command (kept manual by design — the bot should not edit its own security config), reply-context threading (v1: the user's answer is a normal message; the briefing text above it carries the context).
**Status:** Built + unit-tested (472 tests). Needs a live briefing run to validate end-to-end.

### Memory floor tuned on real data + a fragmentation finding
**Decision:** Injection floor 0.55 → 0.52. Measured on the real corpus (`scripts/memory-floor-check.ts`): noise clusters ≤0.49, genuine signal starts ~0.546 on qwen3-embedding — 0.55 was clipping the best fact in a relevant query (sim 0.546, imp 4).
**Finding (evidence for the cross-channel sessions roadmap item):** facts are fragmented across channel sender ids — 55 of 64 live under the Telegram id, 5 under Discord, rest scattered. On Discord, memory search sees 8% of the owner's knowledge. Identity mapping is now measurably the biggest memory-quality lever, bigger than any scoring change.
**Status:** Floor active. Fragmentation unaddressed (roadmap: cross-channel sessions).

## Small-Model Hardening + Bounded-Autonomy Gates (July 5-6 2026)

A full-codebase assessment (four parallel research passes: tool-loop, router/pipelines, memory/context, autonomy surface) concluded the architecture was sound and the gaps were implementation-level: tolerant layers with bugs, gates that existed but weren't applied uniformly, budgets computed against the wrong numbers. One session, 9 commits (ab7e21f..159c401), each independently revertable. 451 tests after (was 389).

### One tool-calling convention per model (`toolStyle`)
**Decision:** Specialists get `toolStyle: 'native' | 'text'` (schema.ts, default native). Native passes tools via the API field ONLY — no tool text block, no `Action:` format rules in the prompt. Text is the inverse: prompt-described tools, nothing passed natively. Never both.
**Why:** The prompt previously taught the text `Action: tool[{json}]` convention *while* native tools were also active — two contradictory formats, and small models mixed them mid-loop. It also doubled tool overhead (~5K tokens of tool text on a full set, duplicated by the native template). Measured live: text mode costs ~950 more prompt tokens than native *with one tool*.
**Kept:** ALL fallback parser dialects (DSML, `<invoke>`, `Action:`, JSON5 ladder) stay active in both modes — they're the safety net that keeps arbitrary models usable, not part of the convention choice.
**Status:** Active, default native. Verified live on qwen3.6:35b in both modes (tools called, params well-formed). Watch item: native-mode qwen3.6 sometimes writes its deliberation into the final answer instead of the requested format.

### Grammar-constrained decoding (`format`) with automatic fallback
**Decision:** Structured tasks pass a JSON schema via Ollama `format` / vLLM `guided_json`: param extraction, `llm_branch`, router classification (enum of valid categories), research claim extraction (`CLAIMS_JSON_SCHEMA`). Every call site falls back to prompt-only on backend rejection; the extractor caches the rejection in a module flag so only the first call pays the failed round-trip.
**Why:** Kills the malformed-JSON failure class at the token level instead of repairing after the fact — the single biggest "raise the floor for 7-14B models" lever available.
**Gotcha — the gateway silently swallows it:** the custom FastAPI gateway types `format: str`, so schema objects 422 and even `format: "json"` is accepted-then-discarded (proof: phi4 returned markdown-fenced output, impossible under real JSON mode). Root cause per the gateway team's own review: their internal normalization layer drops any field it doesn't model — same bug family also hardcodes `num_ctx: 32768` (silently clamping our 131K → system prompt truncates first) and discards `keep_alive` (models go cold between calls; observed 0.2s-8s latency swings on phi4 in one sequential run). Fix is theirs: "normalize what you police, pass through what you don't." See GATEWAY-REQUIREMENTS.md for the contract + acceptance tests. Until it lands, constrained decoding is dormant and the fallbacks carry.
**Status:** Active in code, blocked on gateway for effect. Re-run GATEWAY-REQUIREMENTS acceptance tests 1a/1b when their passthrough refactor lands.

### Extraction: degrade-not-abort
**Decision:** `extractParams` parses with JSON5 before burning a repair call (trailing commas/single quotes are free now); validates required/enum/coercion post-parse and feeds specific errors into the repair prompt; prefers best-effort params over throwing; `ExtractStage` gained an optional deterministic `fallback(ctx)` (web_search falls back to the raw message as the query). Cron expressions are validated with croner in `cron_add`/`cron_edit` BEFORE persisting.
**Why:** Extraction failure previously aborted the entire pipeline (`executor.ts` converted any stage error into a full abort). Invalid cron expressions were stored and silently never ran.
**Status:** Active.

### Research correction: code-driven sentence splice (whole-report rewrite removed)
**Decision:** `locateClaimSentence` (token-overlap fuzzy locate; skips Sources/headings/chart placeholders; ≥0.5 threshold — skip rather than splice the wrong sentence) finds each flagged claim's sentence; the model rewrites ONE sentence; code splices it back with sanity bounds. The whole-report `correctionPrompt`, its 0.7-length guard, and the strikethrough-stripping band-aid on the output path are gone.
**Why:** "Edit these sentences, preserve 3000 other words verbatim" was the hardest task in the system for a small model — the strikethrough hack and length guard existed *because* it kept misbehaving. Now the report body is never handed to a model for wholesale rewriting.
**Status:** Active. Needs a live research run for end-to-end confirmation.

### Pending-action ledger — confirmations execute stored params
**Decision:** `src/security/pending-actions.ts`: confirmTools previews record `{id, tool, params, sender, channel, agentId, sessionKey, expiresAt}` to a file-backed ledger. "Confirm" executes the STORED call — sender-bound, single-use, 10-minute expiry. Wired into both dispatch paths' previews, the orchestrator confirm handler, and console `chat.ts`. The old `confirmed: true` re-dispatch arming is removed.
**Why (three real holes):** (1) confirmation previously set a flag for the *entire* re-dispatch and the model *regenerated* params — nothing guaranteed the executed call matched the preview; "go ahead" in any context armed whatever the model decided next. (2) Pipelines built their executor with NO confirm wrapper — the `message` pipeline could send with the gate configured. (3) The console path had no confirm detection at all: on Web the gate was a dead-end that could never release.
**Status:** Active, Tier-3 test coverage (sender binding, single-use, expiry, exact-params). Live channel walkthrough still pending. Known gap: ledger-confirmed actions aren't written to the session transcript.

### Tool autonomy metadata + `autoApproveTools` promotion lever
**Decision:** `LocalClawTool.autonomy?: {tier: silent|act_then_notify|propose_confirm, reversible, blastRadius: self|owner|external}`. Effective confirm set = channel `confirmTools` ∪ metadata `propose_confirm` tools − channel `autoApproveTools` (explicit confirmTools always wins over a promotion). `send_message` starts at propose_confirm/external — the ladder's rule that anything visible to others starts gated. Cron pre-authorization: an owner-scheduled exec/message job waives the metadata gate for its category tool only (the schedule IS the approval; nobody is present to confirm at run time).
**Why:** Tier assignment was per-channel name lists — a new tool defaulted to *ungated*. Now the ladder is structural and per-channel promotion (`autoApproveTools`) is the earned-leash mechanism, backed by `logAutonomousAction` metrics (every heartbeat auto-action, cron run, stale-fact proposal, and ledger confirmation logs action/tier/source/reversible/outcome — the track record promotions cite).
**Also:** cron dispatches only get `exec`/`send_message` when the job's category is exec/message — a web_search cron job whose fetched page contains an injected "run this / message X" has no tool to reach for. Heartbeat stale-fact deletion (model-judged, 40-char prefix match, un-itemized) demoted to propose-and-confirm via the existing `!heartbeat yes/no` review file.
**Status:** Active. ~29 tools still need annotations (pattern in send-message.ts). Promotion tooling (metrics reader) not built yet.

### Memory injection: relevance floor
**Decision:** Vector KNN injection requires raw cosine similarity ≥ 0.55; contextual facts capped at 3; multi-hop traversal only fires when ≥1 result passed the floor but results are sparse.
**Why:** Multi-signal scoring (`sim*0.5 + recency*0.2 + imp*0.3`) only ORDERS results — a fresh imp-5 fact scored 0.5 with zero query relevance, so identity facts injected on every turn regardless of topic (small-model topic-drift trap). Multi-hop previously fired exactly when KNN found *nothing* relevant — adding tangential facts when they'd be most distracting.
**Rejected for now:** reranker/cross-encoder — monitor the floor first (per the standing "no complexity before evidence" stance).
**Status:** Active. Floor value untested against real recall feel — tune in `buildUserPriming` before adding anything smarter.

### Context budget: charge the real prompt
**Decision:** `computeBudget` accepts `extraSections` (serialized tool defs, statePreamble, userPriming); dispatch re-budgets AFTER classification with the actual specialist prompt and trims oldest history turns to fit (`trimHistoryToFit`). `estimateTokens` uses ~3 chars/token for punctuation-dense segments (JSON/URLs).
**Why:** The pre-classification budget used an empty system prompt and ignored tool definitions entirely — historyBudget was overestimated by 3-6K tokens for exactly the tool-using calls that matter, starving 8-16K models. The old 4-chars/token estimate *under*-counted JSON-heavy tool observations, risking silent prompt-head truncation.
**Status:** Active.

### Router: enforced timeout + fallback fixes
**Decision:** `config.router.timeout` is now actually enforced (Promise race → keyword fallback; the abandoned request's result is discarded). Config raised 2000→8000ms. Keyword fixes: bare `workspace` removed from the config pattern (it captured "run ls in the workspace"), ls/pwd/chmod added to exec hints, live-value lookups ("current price of X") fall back to web_search. Blanket URL→website override narrowed to bare-URL-only (short remainder, no other intent verbs) — "research X, start from <url>" no longer hijacked to a page summary.
**Why the config bump:** the 2000ms was FICTION — never enforced, so nobody knew phi4 actually takes 0.2-8s through the gateway (variance from the keep_alive drop above). Enforcing 2s for real would have starved the model path entirely. Lesson: enforcing a previously-advisory limit requires re-measuring reality first.
**Status:** Active. Live: 15/16 on real phi4 (`scripts/router-live-check.ts`; the miss is "turn this analysis into a PDF report" → multi instead of document — judgment call, logged not chased).

### The EHOSTUNREACH saga — two wrong theories, then macOS TCC
**Symptom:** Live checks "flapped": node got connection failures against the gateway mid-run, repeatedly, while curl probes succeeded moments later.
**False starts (both disproven):** (1) "gateway drops connections under sequential load" — reported to the gateway team, later retracted. (2) "big-model cold load crashes the gateway" — disproven when a small warm model failed identically. The kill shot: **simultaneous** curl → 200 and node → `EHOSTUNREACH`, same literal IP, same box; then the matrix (node LAN ✗ / node internet ✓ / python LAN ✓ / curl LAN ✓).
**Actual root cause:** macOS Local Network privacy silently denies LAN access to third-party binaries (homebrew node) spawned from SSH sessions (incl. VS Code Remote) — there's no GUI app to attribute a prompt to, so it's deny-with-no-error, presenting as a routing failure. Apple-signed binaries and already-permitted apps pass, which is why every counter-probe "worked."
**Fix:** tmux server started once from local Terminal.app (which has the permission); everything spawned inside inherits it. `tmux send-keys -t lab '…' Enter` + `capture-pane` gives sessions like this one full live-test access. Recreate after reboot.
**Lessons:** (1) When probes contradict each other, run them *simultaneously from the same context* before theorizing — the same lesson as the BLS 403 entry below, relearned at the network layer. (2) An intermittent failure that only hits one binary is a permissions/attribution problem, not a load problem. (3) Don't ship a bug report to another team until the failing client and a working client have been diffed.

---

## Coding Agent Swap: OpenCode → Pi/picoder (June 26 2026)

### Replaced OpenCode with the Pi coding agent for `code_gen`
**Decision:** The `code_gen` pipeline now drives **Pi** (`@earendil-works/pi-coding-agent`, "picoder") via its headless CLI instead of OpenCode. New `pi_build` tool (`src/tools/pi-build.ts`); `opencode-build.ts`, `@opencode-ai/sdk`, and the `openCode` config block are removed.
**Why:** Pi fits the local-first/model-agnostic thesis better and kills OpenCode's operational pain. OpenCode required a **manually-started server** (`opencode serve`), kept a **global session DB** that carried stale context across restarts, and had a **snapshot/move hack** (old project dirs got swallowed). Pi runs **cwd-scoped** (every write lands in `builds/<slug>/`, which also structurally prevents the package.json-overwrite class of bug — no prompt-based directory constraint needed) and is invoked headless per-build (SDK / `-p` / RPC), so there's **no daemon and no global state**. Model is `provider/id` from `~/.pi/agent/models.json` (currently `vllm/deepseek-v4-flash`).
**Gotcha 1 — stdin hang:** Pi's `-p` print mode reads stdin to merge piped input. Spawned with an inherited/open stdin pipe it blocks forever waiting for EOF. Fix: `spawn(..., { stdio: ['ignore', ...] })` so it gets immediate EOF. (An interactive-shell run worked because stdin was a TTY — the bug only showed when spawned.)
**Gotcha 2 — scoped-executor authorization:** the `code_gen` *specialist's* allowed-tools list still named `opencode_build`, so the scoped executor blocked `pi_build` as unauthorized — invisible to tsc/unit tests, only caught by a live dispatch run. Lesson: a tool swap must update the specialist `tools` allowlist in config, not just the pipeline + registration.
**Gotcha 3 — test-gate false-negative:** `runTests` hard-failed on a non-zero `pip install` exit (the `.venv/bin/pip` script flaked while the venv was actually healthy), so a correct build (102 passing tests) got labeled "tests failing." Fix: use `python -m pip` (not the pip script), and **run the tests even if install exits non-zero — judge the gate on the actual test result, not the install exit code.** The test outcome is the source of truth; a real missing-dep surfaces as a test/import failure anyway.
**Loop shape:** enrich → `pi_build` (cwd-scoped) → verify (tests = the gate) → [fix: re-run Pi in the dir with errors] → re-verify → **commit** (local git autonomous; remote GitHub push opt-in, off by default — the autonomy-ladder split: reversible/internal acts silently, visible/irreversible is gated) → report.
**Status:** Active. Verified end-to-end through live dispatch (built a Roman-numeral package, self-repaired, committed). The "OpenCode integration" entries below are retained as history (superseded).

## Verification False Negative from a Stale Truncation Cap (June 17 2026)

### A research report's real, correctly-cited BLS numbers were stamped UNSUPPORTED (fixed)
**Symptom:** A labor-market report (DeepSeek) presented `172K payrolls / 4.3% / leisure +70K` citing `[2]` BLS, while its own Verification appendix marked the sector figures **UNSUPPORTED**.
**False starts (both disproven by actually reproducing the fetch):** First guess was an over-aggressive entailment judge; a worse second guess (logged here yesterday, now deleted) was that `bls.gov` **403-blocks** the fetcher so the model misattributed secondary numbers to BLS. BOTH WRONG. The 403 came from *Claude's own WebFetch tool* — a different client. Running the pipeline's actual `web_fetch` (User-Agent `LocalClaw/1.0`) returns BLS **200, 6K-char extract**, and it **contains every figure**. The numbers are real, genuinely in BLS, and **correctly cited** — no block, no misattribution, no hallucination.
**Actual root cause (proven from the run's `verification.json` + char offsets):** `entailmentPrompt`/`tier1JudgePrompt` sliced each source to `text.slice(0, 3500)`. The BLS sector table sits at offset ~3976–4327 in the 6K extract. So **every figure before char 3500 verified; every figure after 3500 came back UNSUPPORTED** ("None of the provided sources state…") — the judge literally never saw them. A second small-context artifact compounded it: the research pipeline forced `web_fetch maxChars: '6000'`, overriding the tool's 30K default, so the cache only held 6K of each page.
**Fix (general, no site-specific anything):** Both caps are small-context-era relics — DeepSeek serves 256K, a fetched page is ~1.5K tokens. (1) Pass the FULL cached source to the judge (removed the `slice(0, 3500)` in both prompt builders). (2) Drop the forced `maxChars: '6000'` so research uses the tool's config default (30K) — full pages get cached. No relevance-window cleverness, no block-detection markers — both were rejected as solving a non-problem / hardcoding for one case.
**Lesson (reinforced, hard):** Reproduce the program's *exact* behavior before theorizing — a tool's 403 ≠ the pipeline's fetch. Two wrong theories died the moment the real `web_fetch` was run. Also: when a model gets *bigger context*, audit for old rationing caps (`slice`, `maxChars`, `MAX_*`) that silently throw away data the model could now hold.
**Known separate issue (flagged, not fixed):** the BLS *PDF* `[1]` fetches as raw `%PDF` binary (PDFs aren't parsed) and passes the weak `valid` filter (`!startsWith('Error') && len>120`) → a junk source. Didn't cause this failure, but raising `maxChars` caches more of the garbage. Candidate: a general "is this text" guard (binary/empty), NOT a block-marker list.
**Status:** Fixed (truncation caps removed). Live re-run on restart should flip the sector claims to VERIFIED.

## Foreground Model Swap: MiniMax-M2.7 → DeepSeek-V4-Flash (June 2026)

### Swapped the foreground reasoning tier to DeepSeek-V4-Flash (June 2026)
**Decision:** Foreground reasoning (chat + all foreground specialists + `reason` tool + briefing/heartbeat synthesis) now runs on **DeepSeek-V4-Flash** (vLLM on the Spark, served id `deepseek-v4-flash`, 256K context), replacing MiniMax-M2.7. Vision stays on qwen3.6:27b — DeepSeek is text-only, same as MiniMax.
**Why:** Markedly better output than the prior local-model era. The swap was config + two small code changes — the pipelines, memory graph, and channels were untouched. This is the second foreground swap (qwen → MiniMax → DeepSeek) done purely through the `MultiBackendClient`, and it's the working proof that the foreground model is a *slot*, not a dependency: each model's per-call job stays small enough that a big model raises the ceiling without becoming the floor.
**Gotcha 1 — DSML tool-call dialect:** DeepSeek narrates tool calls as text in its own `<｜DSML｜invoke name="…"><｜DSML｜parameter …>` dialect when no native `tools` are passed. The parser (`src/tool-loop/parser.ts`) strips the `｜DSML｜` (U+FF5C) markers so it normalizes to the existing `<invoke>`/`<parameter>` handling, and tolerates extra param attributes (`string="true"`).
**Gotcha 2 — empty completions on small `max_tokens`:** reasoning tokens count against `max_tokens` on the vLLM path. Verification stages pass `num_predict` 400-700 as the *answer* budget, which DeepSeek's reasoning consumed entirely → truncated before any answer → empty `content`, silently gutting the stage. Fixed by reserving reasoning headroom (`+4096`) on `max_tokens` in `OpenAICompatClient`, plus a warn when a completion returns empty with `finish_reason: length`.
**Status:** Active. The MiniMax entries below are retained as history (superseded by this swap).

## Multi-Backend Inference & MiniMax Swap (June 2026) — superseded by DeepSeek-V4-Flash swap above

### vLLM backend, additive (June 2026)
**Decision:** Add OpenAI-compatible inference (vLLM serving MiniMax-M2.7) alongside Ollama, not replace it.
**How:** `MultiBackendClient extends OllamaClient` routes `chat`/`chatStream` to `OpenAICompatClient` when the model id matches `inference.backends[].models`, else falls through to Ollama. `embed`/`generate`/`listModels` always use Ollama. Drop-in — every `client: OllamaClient` call site is unchanged.
**Translation handled in OpenAICompatClient:** `options.{temperature,top_p,num_predict}`→top-level; tool-call `arguments` string→object (vLLM returns a JSON string, Ollama an object); `tool_call_id` stitched onto tool-result messages (OpenAI requires it, the ReAct engine doesn't emit it); SSE streaming; `usage`→`eval_count`/`prompt_eval_count`.
**Status:** Active.

### Model split: foreground on Spark, utility on A5000 (June 2026)
**Decision:** MiniMax-M2.7 (vLLM, Spark) for all foreground specialists + chat + multi + the `reason` tool. qwen3.6:27b (A5000 gateway) for vision + briefing + heartbeat (background). phi4/phi4-mini/qwen3-embedding stay on the gateway (router/NER/extraction/embedding). qwen2.5:7b stays for the voice fast-path; whisper/flux unchanged.
**Why:** MiniMax reasons far better than qwen3-coder:30b/gemma4:26b; the hardware split keeps the Spark free for foreground while the A5000 handles small/modality models. Vision can't move to MiniMax (text-only) — qwen3.6:27b is multimodal and covers it.
**Gotcha:** the `reason` tool's model lives in its own `reasoning` config block and was missed in the first swap pass — it pointed at a non-existent `nemotron-3-nano:30b` and hung every forced-reasoning pass on a timeout loop. Fixed to MiniMax. Lesson: model strings live in several config blocks (specialists, reasoning, vision, voice, briefing, heartbeat, opencode) — swap them all.
**Deferred:** OpenCode `defaultModel` stays `ollama/qwen3-coder:30b` — its `provider/model` slash-split collides with MiniMax's slashed id (`cyankiwi/MiniMax-...`); needs its own provider wiring.
**Status:** Active.

### Context window raised to 128K (June 2026)
**Decision:** `session.contextSize` 32K→131072; added optional per-specialist `contextSize` override.
**Why:** 32K forced compaction every message. MiniMax serves 192K. The global value drives the compaction budget (safe to raise — router/vision/embedding set their own `num_ctx`; MiniMax ignores `num_ctx` since vLLM fixes context at launch). Per-specialist override is the lever to *lower* context for any future small-context Ollama specialist.
**Status:** Active.

## Memory Integrity (June 2026)

### FactStore importance-aware char bound (June 2026)
**Problem:** Root-caused a real data loss — the user's wife's name (and other imp-4/5 family facts) lived in USER.md + historical raw extractions but were absent from facts.json and the graph. `enforceCharBound` capped facts.json at 3000 chars (~12 facts) and evicted the *lowest-confidence* facts, ignoring importance — so a critical identity fact with moderate confidence got dropped before an ephemeral high-confidence one. Logs showed "trimmed 92 low-confidence facts."
**Fix:** Eviction orders by importance first, confidence as tiebreak; imp≥4 never evicted; `MAX_FACTS_CHARS` 3000→20000.
**Status:** Active. Backfill of historical facts into the graph deliberately NOT automated — the raw set contains time-sensitive/sensitive personal facts (a pregnancy, a hospitalization, a pet's death) and contradictions; re-asserting them as current is a user decision.

### Graph provenance edges wired (June 2026)
**Problem:** `EXTRACTED_FROM` and `SUPERSEDES` were defined in the schema but never created (live graph showed 0 of each). `addFact`'s `sourceSession` was optional and no caller passed it; the contradiction check set `superseded=true` but created no edge.
**Fix:** Session key threaded through all `addFact` callers (heartbeat, !save, memory_save); SUPERSEDES edge created (new→old) after the new Fact node exists.
**Status:** Active.

## Model Evaluations

### Gemma4:26b for chat (May 2026)
**Context:** Chat was on qwen3.5:9b (thinking model). Analysis of conversation transcripts revealed the model self-prompting — asking follow-up questions then answering them in the same turn via `<think>` blocks. The orphaned `</think>` tags were also leaking into continuation context previews.
**Decision:** Switched chat to gemma4:26b (MoE, 3.8B active / 25.2B total). Kept qwen3-coder:30b for tool-calling specialists.
**Why gemma4 for chat:** MoE architecture means only 3.8B active params → faster tok/s than the dense 9B qwen, while being a smarter model overall. DGX Spark hardware gives better throughput. No self-prompting artifacts. Cleaner conversational output.
**Sampling:** Per Gemma 4 best practices: temperature=1.0, top_p=0.95, top_k=64.
**Note:** Gemma 4 docs explicitly say "No Thinking Content in History" for multi-turn conversations. The thinking preservation in transcripts still benefits qwen3 specialists (tool-loop reasoning chains), but gemma4 chat sessions should have thinking stripped from history.
**Status:** Active for chat. qwen3-coder:30b remains for all tool-calling specialists.

### Gemma4:26b as specialist replacement (April 2026)
**Tried:** Swapped qwen3-coder:30b for gemma4:26b as the specialist model. Benchmarks showed 85% on agentic tasks vs qwen3-coder's 65%.
**Result:** Tool calling worked, but tool **sequencing** was worse. Model answered before using tools, wandered to irrelevant sites, didn't complete multi-step chains. Reverted after testing.
**Lesson:** Benchmarks don't tell you about tool sequencing discipline. A model can call tools correctly in isolation but fail at knowing when to stop talking and start calling.
**Status:** Under re-evaluation now that Ollama has updated. gemma4:26b stays available for future testing pipeline-by-pipeline.

### qwen3.6:35b for briefing (May 2026)
**Tried:** Swapped qwen3-coder:30b for qwen3.6:35b on the briefing reasoning pass.
**Result:** Immediate quality improvement. No fabricated events, respects pre-labeled data, cleaner synthesis, less filler.
**Gotcha:** qwen3.6 defaults to thinking mode, which consumed the entire `num_predict` budget leaving content empty — same root cause that killed nemotron earlier (see "Low num_predict starving thinking models"). Fix: bumped `num_predict` from 1024 to 8192.
**Status:** Active. Briefings now run on qwen3.6:35b.

### Nemotron for briefing (April 2026)
**Tried:** Used nemotron-3-nano:30b for briefing CoT reasoning.
**Result:** All output went into `<think>` tags with nothing outside. Empty briefings delivered.
**Root cause (discovered later):** Likely the same `num_predict: 1024` starvation issue — see "Low num_predict starving thinking models" below. Nemotron is a thinking model that uses internal reasoning tokens. At 1024, it spent all tokens thinking and produced no visible output. The model may have worked fine with adequate headroom.
**Status:** Switched to qwen3-coder, then to qwen3.6. Worth re-evaluating with `num_predict: 8192`.

### phi4-mini as smart router (April 2026)
**Tried:** Used phi4-mini for short messages mid-conversation to save latency.
**Result:** Produced "As an AI developed by Microsoft" responses. Also broke mid-conversation routing by classifying follow-up messages as new intents.
**Lesson:** Smart routing based on message length is fragile. Short messages mid-conversation need context, not a cheaper model.
**Status:** Removed entirely. All routing goes through phi4:14b.

### Low num_predict starving thinking models (May 2026)
**Problem:** Multiple models (nemotron, qwen3.6) produced empty or truncated output. We blamed the models and swapped them out.
**Root cause:** `num_predict: 1024` was too low for thinking models. These models use internal reasoning tokens (think tags) before producing visible output. At 1024 tokens, the model spent its entire budget thinking and had nothing left for the actual response.
**Impact:** Nemotron was wrongly dismissed for briefings. qwen3.6 initially appeared broken. Any thinking model evaluated under these constraints was handicapped.
**Fix:** Bumped briefing `num_predict` to 8192. Gateway updated to surface thinking content as fallback when content is empty.
**Lesson:** Before blaming a model's capability, check if you're giving it enough room to work. Thinking models need headroom for internal reasoning on top of the output tokens. Audit `num_predict` values when onboarding any new model.

---

## Architecture Decisions

### Thinking preservation in transcripts (May 2026)
**Problem:** Models that emit `<think>` blocks had their reasoning stripped before storing in session transcripts. On subsequent turns, the model only saw its own terse answers — not the reasoning chain that produced them. Quality degraded over multi-turn conversations as the model lost context about _why_ it said what it said. Session state (known facts, open questions) was a poor substitute for the model's actual internal reasoning.
**Decision:** Store raw model output (with thinking blocks) in the transcript. Strip thinking only at display boundaries: channel delivery, graph memory turns, session state updates, continuation context previews, handoff summarization, and when feeding transcript content to other LLMs (compactor summarizer, semantic extractor, fact extraction).
**Why not strip everywhere:** The model benefits from seeing its own reasoning on subsequent turns — it maintains coherence and builds on prior analysis. But other LLMs that consume transcript content (summarizers, extractors) shouldn't see nested thinking blocks.
**Also fixed:** Orphaned `</think>` regex was unlimited (`[\s\S]*?`) — tightened to `{0,500}` to prevent eating half the response if a stray `</think>` appears deep in the text. Added Gemma 4 thinking format (`<|channel>thought\n...<channel|>`) to all strip functions.
**Also added:** `num_ctx` passthrough from `config.session.contextSize` to Ollama via `buildOllamaOptions()` and bare chat options — ensures Ollama allocates enough context for the larger history.
**Status:** Active.

### Exec pipeline vs ReAct loop (April 2026)
**Tried:** Removed the exec pipeline to let the model reason freely about 6 exec tools in a ReAct loop.
**Result:** Model used 8 steps for `ls data` -- called exec correctly but then tried `find`, `chmod`, `which` before stopping. Massive over-exploration.
**Lesson:** Local models can't self-regulate in open-ended tool loops for simple tasks. Pipeline for simple commands, ReAct for complex multi-tool tasks.
**Status:** Exec pipeline restored.

### Sticky routing evolution (April-May 2026)
**Original problem:** Sticky routing kept follow-up messages on the same specialist across all categories. Fixed: restricted to chat/memory only.
**Second problem (May 2026):** Broad keyword hints ("what is", "who is") broke sticky for casual questions. "What are the privacy implications of NotebookLM?" triggered web_search keyword hint → broke sticky → model classified as research/multi → full report instead of chat.
**Third problem:** Even when sticky held, the model classifier could override it. Conversational messages with technical keywords got classified as research/multi/web_search.
**Fix (keyword hints):** Removed "what is" and "who is" from web_search keyword hint. These are questions, not search actions.
**Fix (dispatch guard):** Added dispatch-level conversational guard: if classified as non-chat but session has prior turns (turnCount > 0) AND message has no explicit task intent (create, search for, generate, etc.), downgrade to chat. Catches ALL pipeline misroutes from conversational context — research, multi, web_search, everything.
**What breaks through:** Explicit task intent always wins — "search for X", "create a report", "generate an image". Pre-model overrides (calendar, email, PDF) still fire. First messages (no session) unaffected. Cron jobs unaffected.
**Status:** Active. Three layers: keyword tightening + task intent check for long messages + dispatch-level guard.

### Session isolation for pipelines (April 2026)
**Decision:** All pipeline dispatches (plan, research, exec) run with fresh context -- no parent session history.
**Why:** Research results were being biased by prior conversation topics. A research task about "AI news" would incorporate topics from a prior chat about healthcare because the session history was shared.
**Status:** Active. Context isolation is enforced for all pipeline dispatches.

### Code-driven temporal intelligence (May 2026)
**Decision:** Task urgency and calendar day labels computed in TypeScript, not by the model.
**Why:** qwen3-coder said "264 days remaining, requiring attention soon." It showed events on wrong days. It couldn't distinguish events from deliverables. Three separate prompt rewrites failed to fix it.
**Lesson:** If a model fails at something deterministic after 3+ prompt attempts, move it to code. The model's job is synthesis, not arithmetic.
**Status:** Active. `src/temporal/urgency.ts` handles all temporal reasoning. Model receives pre-labeled data with authoritative tags.

### Heartbeat: code curates, model reasons (April-May 2026)
**Decision:** Heartbeat uses snapshot-based fact diffing (code) then sends structured diff to LLM for reasoning. Task board uses urgency tiers (code) then sends pre-labeled board to LLM for summary.
**Why:** Original approach let the model search memory randomly -- each run surfaced different facts with different formatting. Plan pipeline heartbeat matched wrong skills (137 inflated success count on one skill). Model-driven task board said everything was urgent.
**Lesson:** Code handles the "what" (which facts changed, which tasks matter). Model handles the "so what" (what does it mean, what's connected).
**Status:** Active. Pattern applied to both memory and task board.

### Hallucination detector: verb-aware (May 2026)
**Decision:** Hallucination detection now checks claimed action verbs against actual tool calls made.
**Why:** Image generation tool took ~60 seconds. After the tool completed, the model summarized "I've generated the image." Detector flagged this as hallucination (model claiming action without tool call), triggered a repair prompt, model generated the image a second time.
**Lesson:** "Claims action without tool call" needs context -- if the model DID call the tool, its summary is legitimate.
**Status:** Active. `TOOL_ACTION_VERBS` map in `src/tool-loop/engine.ts`.

### [FILE:] token flow (March 2026)
**Decision:** File tokens stripped from model observations before model sees them, collected, re-appended after final answer.
**Why:** Model rewrites `[FILE:path]` into fake markdown links like `[Download report](path)`. Once the model touches the token, the path format breaks and media extraction fails.
**Status:** Active. Two strip points: tool-loop engine (observations) and plan pipeline (before summarization LLM).

---

## Failed Approaches

### Phone call integration (April 2026)
**Explored:** macOS Continuity for intercepting phone calls, BlackHole audio routing for system audio capture.
**Why abandoned:** No public API for macOS Continuity calls. BlackHole routing is fragile and requires manual audio config. Twilio Media Streams is the clean path but adds cost.
**Conclusion:** Shelved. Better use case is business appointment scheduling, not personal call handling.

### Skill matching catching everything (April 2026)
**Problem:** The skill "generate-report-from-web" matched 73 consecutive heartbeat dispatches, inflating to 137 success count.
**Root cause:** Skill matcher thresholds too low, no exclusion for system operations.
**Fix:** Threshold raised to 8, 30% keyword ratio required, success bonus capped at +2, heartbeat dispatches skip skill check/save entirely.

### Briefing on heartbeat cron (April 2026)
**Problem:** Briefing was triggered inside the heartbeat cron (even hours). The briefing wanted to run at 8am, 1:15pm, 5pm -- which never aligned with even-hour heartbeat runs.
**Fix:** Separated briefing into its own cron schedules. Heartbeat and briefing are independent systems.

### Memory facts surfacing irrelevant context (April 2026)
**Problem:** User priming injected LLC/career facts during a health conversation. Briefing memory search pulled colonoscopy info into every daily briefing.
**Fix (priming):** Changed header to "Background context (do NOT reference unless directly relevant)."
**Fix (briefing):** Added explicit rule: "Calendar is the ONLY source of truth for events. NEVER invent or recall events from memory."
**Lesson:** Broad memory search queries like "recent activity decisions context" pull everything. The model can't filter relevance -- it tries to use everything it sees.

### Memory system overhaul: flat store to graph database (May 2026)

**Problem:** The JSONL-based FactStore accumulated 14 near-duplicate facts about the same topic. Layered dedup defenses (hash, substring, embedding similarity) were individually weak. Memory facts only surfaced in briefings, never in conversations. No relationship modeling between facts.

**Evolution (Phases 1-4 on flat store):**
1. Embedding dedup on write (cosine > 0.85 rejected via qwen3-embedding)
2. Importance tiers (1-5) driving TTL and retrieval priority
3. Auto-injection: embedding search on every message, contextually relevant facts silently injected into specialist context
4. Extraction awareness: existing facts shown to extraction LLM to prevent re-extraction

**Decision: FalkorDB graph database (Phase 5)**

Replaced the flat JSONL fact store with FalkorDB — a Redis-compatible graph database with native HNSW vector search.

**Why FalkorDB over alternatives:**
- vs Neo4j: Free (MIT-adjacent), ~85MB vs 2.6GB memory, sub-ms lookups, native vector search. Neo4j Community can't cluster.
- vs SQLite (existing EmbeddingStore): No graph traversal, no relationship modeling, brute-force vector search.
- vs Memgraph: Lacked native vector search at time of evaluation (has since added it).

**What the graph enables that flat storage can't:**
- SUPERSEDES edges: fact evolution with history ("ML engineer" → "Senior ML engineer")
- Temporal queries: "what did I know last month?" via createdAt filters + SUPERSEDES chain
- Multi-hop reasoning: traverse shared entities to find connected facts (DevMesh → AI → career fair)
- Community detection: clusters of related facts by entity co-occurrence (work cluster, health cluster, hobby cluster)
- Native vector KNN: O(log n) via HNSW index, not O(n) brute-force

**Infrastructure:** FalkorDB runs in Docker on the Mac Mini alongside LocalClaw. ~85MB for the graph at current scale (~1,067 nodes).

**Status:** Fully integrated. Auto-injection, memory tools, and migration complete.

**Early results (May 10, 2026):**
- Cookie preference test: bot knew "soft chocolate chip cookies with precise measurements" without being asked
- FalkorDB discussion: bot held multi-turn technical conversation, correctly pulled user's ML engineer role and DGX Spark setup from graph memory for context
- Migration dedup: caught 2 paraphrased duplicates during 23-fact migration that flat store had missed
- Narrated tool call detection: added to capability gap detector after chat faked a `[brave_search()]` call
- Personalized conversation: "What would you like to talk about?" → bot built a menu from graph memory (open-source models, DGX Spark, edge AI, Long Island events, System Prompt podcast). Zero prompting from user.
- Unity AI discussion: bot autonomously connected Unity research to user's LocalClaw setup and edge computing interests via auto-injected graph facts
- FalkorDB discussion: multi-turn technical conversation where bot correctly pulled user's ML engineer role and infrastructure context
- `!forget register agent` working with flexible word matching after exact CONTAINS failed on "registered agent" vs "register agent change"

### OpenCode integration — workspace isolation (May 2026) — SUPERSEDED by the Pi swap (June 26 2026, top of file)
**Problem:** OpenCode's headless server treats its startup directory as the project root. When started from the LocalClaw directory, it overwrote `package.json` (replaced all dependencies with Express) and `README.md` (replaced with Express API docs). Prompt instructions to "only write to builds/" were ignored by the model.
**Root cause:** OpenCode is a model-driven agent with full filesystem access within its project directory. Prompt-based directory constraints are not enforceable — the model writes wherever it decides.
**Fix:** Start `opencode serve` from a separate `data/workspaces/main/builds/` directory. OpenCode can only see and modify files within that directory. LocalClaw connects to the existing server via SDK — it doesn't manage the server lifecycle.
**Lesson:** Never give a model-driven coding agent write access to your production codebase. Isolate its workspace at the process level, not the prompt level.
**Status:** Active. User starts `opencode serve` from builds directory manually. LocalClaw tool detects and connects to the running server.

### OpenCode pipeline evolution (May 2026)
**Phase 1 (ReAct):** Specialist called opencode_build in a ReAct loop. Model retried 2-3x despite "call once" instructions.
**Phase 2 (Pipeline):** Deterministic extract → build → report. Extract stage mangled user intent. Replaced with LLM enrichment stage.
**Phase 3 (Verify/Fix):** Added verify (run tests), fix (send errors to same session), re-verify stages. Uses `when` guards for conditional execution. Session reuse via `sessionId` parameter.
**Phase 4 (Iterative builds):** Session persistence (`.opencode-session.json` per project). `list_projects` code stage scans existing projects. Enrich LLM outputs `[MODIFY] <slug>` for modifications vs new project name. `resolveParams` loads saved session data for reuse.
**Key pattern:** Each stage does ONE thing. Code controls the flow. Model executes within constraints. No model decisions about retry/flow.
**Status:** Active. Full pipeline: list_projects → enrich → build → verify → [fix] → [re-verify] → report.

### OpenCode specialist retry behavior (May 2026)
**Problem:** Despite system prompt saying "Call opencode_build ONCE", the specialist calls it 2-3 times:
- First call: build succeeds, returns file listing
- Specialist reviews output, decides tests aren't good enough, starts second build
- Or: first call times out (fetch failed), specialist retries with new session
**Attempted fixes:**
- System prompt: "Do NOT call opencode_build multiple times" — model ignores it
- maxIterations: 3 → still retries. Need to drop to 2 (one build + one answer)
- Content previews truncated at 2000 chars → specialist thought build was incomplete → retried. Fixed: bumped to 8000 char limit
**Lesson:** Local models don't reliably follow "call this tool exactly once" instructions. Constrain via maxIterations, not prompts.
**Status:** maxIterations set to 2 to force single build + answer.

### Tool-specific error recovery (May 2026)
**Problem:** Tool errors returned generic "Try a different approach or tool" regardless of which tool failed or why. The 8 error patterns in `enrichObservation()` had generic suggestions (e.g., "Check file permissions") that didn't help the model recover.
**Fix:** Added `TOOL_RECOVERY_MAP` — a lookup table mapping (toolName, errorType) → actionable recovery instruction. When `web_fetch` gets a 404, model is told "Use web_search to find the correct URL." When `exec` gets EACCES, model is told to try Docker backend.
**Why this matters:** Goose's architecture treats errors as prompts — recovery instructions tailored to the specific failure. LocalClaw already had `enrichObservation()` but it was generic. Now it's tool-aware.
**Status:** Active. `src/learnings/pattern-matcher.ts`.

### Structured sub-dispatch results (May 2026)
**Problem:** Plan pipeline sub-dispatches returned raw text strings. File paths and URLs were regex-extracted post-hoc from the answer, which was fragile and could miss paths in unexpected formats.
**Fix:** Added `SubDispatchResult` typed interface. Dispatch layer now extracts paths/URLs at source (where it has the full answer) and returns structured metadata. Plan pipeline uses typed fields instead of regex.
**Why this matters:** Separates data extraction from orchestration. Foreman handoffs are now based on structured data, not text parsing.
**Status:** Active. `src/pipeline/types.ts`, `src/dispatch.ts`, `src/pipeline/definitions/plan.ts`.

### LLM-based observation summarization (May 2026)
**Decision:** Added optional LLM summarization for old tool observations in the tool-loop context trimmer.
**How it works:** When context budget is tight (>85%), observations >1000 chars are summarized by a fast model (router model by default) before truncation. Observations 300-1000 chars hard-truncate as before. Controlled by `session.summarizeToolObservations` config flag.
**Why:** Hard truncation to 300 chars loses key data (errors, file paths, status codes) buried in middle of output. Smart summarization preserves what matters. Goose uses LLM-based summarization too but for full session compaction — this is more targeted (per-observation).
**Fallback:** If LLM call fails, falls back to hard truncation. Zero risk of breaking existing behavior.
**Status:** Active. Enabled in config.

### Graph memory quality: importance, entity typing, entity dedup (May 2026)
**Problem:** Three data quality issues in the knowledge graph:
1. All facts had importance=2 — extraction LLM (phi4:14b) never returned the `imp` field, fallback defaulted to 2. The 30% importance weight in auto-injection scoring was dead weight.
2. All entities had type="unknown" — NER prompt only asked for names as flat strings, MERGE hardcoded `type = 'unknown'`.
3. Duplicate entities from string variations — "open-source model" vs "open-source models", "Poly Markets" vs "Polymarket" created separate nodes, fragmenting the graph.

**Fix (importance):** Added few-shot examples to extraction prompt showing concrete importance levels (wife+health=5, job=4, preference=3, context=2, ephemeral=1). Added warning log when `imp` is missing.
**Fix (entity typing):** Changed NER prompt from flat `["string"]` to typed `[{name, type}]` with closed taxonomy (person, organization, technology, hardware, software, place, event, concept). MERGE uses extracted type, ON MATCH upgrades `unknown` → real type.
**Fix (bootstrapped NER):** NER prompt now queries existing typed entities from the graph and injects them as reference context: "Known entities: DGX Spark → hardware, DevMesh → organization...". Creates a self-improving loop — correctly typed entities teach the model to classify new ones consistently. Without this, phi4-mini classified blind (DGX Spark → software, Solutions Architect → person). Rollback: remove the `knownEntitiesBlock` query in `graph-store.ts addFact()` and revert to static examples.
**Fix (entity dedup):** Added `normalizeEntityName()` for canonical form computation (lowercase, collapse whitespace, simple plural stripping). MERGE matches on canonical property. Display name preserved separately. Startup migration backfills canonical on existing entities. NER prompt instructs model to use singular/canonical forms.
**Status:** Active.

### Graph memory maintenance: entity quality gate + orphan cleanup (June 2026)
**Problem:** First graph audit (1 month in, 1,067 nodes) revealed three categories of junk: (1) garbage entities — "user", "user's", "230s" created as entity nodes, (2) duplicate entities — same canonical name but different types (DevMesh as both `organization` and `unknown`) creating separate nodes, (3) orphaned entities — fact deletions left entity nodes with no ABOUT edges pointing to them. Also found 30+ entities still typed `unknown` from before bootstrapped NER was added, and misclassifications (SOUL.md → hardware, ERA blocks → software).
**Fix (quality gate):** Added `isGarbageEntity()` filter before graph insertion — rejects generic pronouns ("user", "user's", "they"), pure numbers ("230s"), and single-char strings. Runs after NER extraction, before MERGE.
**Fix (orphan cleanup):** After `removeFact()`, automatically sweeps entities with no remaining ABOUT or MENTIONS edges. Best-effort, non-blocking.
**Not fixed with TTL:** Fact expiry stays human-in-the-loop via heartbeat review candidates — the user knows if "interested in Polymarket" is still relevant, the model doesn't.
**Lesson:** Graph databases need periodic maintenance just like any other data store. Plan for a monthly audit cycle — the bootstrapped NER and quality gates reduce future junk, but won't eliminate it entirely.
**Status:** Active. First cleanup: 73→50 facts, 97→75 entities, 0 unknown types remaining.

### Chrome extension: console API bypasses orchestrator (June 2026)
**Problem:** Chrome extension sends messages to `/console/api/chat`, which calls `dispatchMessage()` directly — not through the orchestrator's `handleMessage()`. Page context override (`[PAGE:]` → force chat category) added to the orchestrator had no effect. Messages with injected page content were routed to `website` or `web_search`, which used `web_fetch`/`browser` to re-fetch pages the user was already looking at.
**Root cause:** Two dispatch paths exist: orchestrator (channels) and console API (web/extension). The override was only in the orchestrator.
**Fix:** Added `[PAGE:]` detection in `src/console/handlers/chat.ts` with `overrideCategory: 'chat'`. When the extension injects page context, the model reads the injected content directly — no tools, no fetching.
**Also fixed:** Extension manifest had `host_permissions: ['http://localhost:*/*']` only — content script injection silently failed on HTTPS pages (all of them). Added `https://*/*`. Changed from programmatic `executeScript` injection to declarative content script with active message listener for reliability.
**Lesson:** When adding routing overrides, check ALL dispatch paths — not just the main orchestrator flow. The console API is a separate entry point.
**Revision (June 2026):** Removed the forced `overrideCategory: 'chat'` for extension messages. Let the router classify naturally — it correctly sends "summarize this page" to chat and "click the search bar" to website. Keyword-based intent detection was tried and abandoned (too fragile, false positives on "search for").
**Status:** Active. Router classifies, no overrides.

### Browser control via Chrome extension — evolution (June 2026)
**Problem:** The extension reads page content but can't interact with it. User wants browser control (click, type, navigate) through the extension on their Windows PC, controlled by LocalClaw on the Mac Mini.

**Approach 1 (rejected): CDP over network.** Playwright on Mac Mini connects to Chrome on Windows via `--remote-debugging-port`. Works but exposes Chrome's debug port across the network — real security concern. Built and removed.

**Approach 2 (rejected): Extension parses LLM action tokens.** LocalClaw responds with `[ACTION: click | ref=3]` tokens, extension parses and executes. Same antipattern as letting models decide tool ordering — fragile, retry-prone.

**Approach 3 (active): Remote browser bridge.** Model calls the browser tool normally. If extension is connected (`remoteBridge.isConnected()` + `channel === 'console'`), the tool forwards the structured command to the extension via a poll/POST queue instead of Playwright. Extension content script executes DOM actions. The extension is a dumb executor — same pattern as Docker for exec.

**Architecture:** `model → browser tool → remote bridge queue → extension polls GET /browser/action → background relays to content script → content script executes → POST result → tool promise resolves → model sees result`

**Bugs hit during implementation:**
1. **Content script dies on navigate.** `window.location.href` kills the content script. Fix: navigate delegated to background via `chrome.tabs.update()`.
2. **Content script not loaded on tab.** After navigation or tab switch, content script doesn't exist. Fix: background pings content script, injects on-demand via `chrome.scripting.executeScript()` if missing.
3. **Navigate timing.** Navigate returns instantly but new page hasn't loaded. Next action (snapshot) fails. Fix: 3-second delay after navigate actions.
4. **"Illegal invocation" on type.** Native setter used wrong prototype for `<textarea>` vs `<input>`. Fix: check element tag, try/catch fallback.
5. **Conversational guard blocking website.** Guard downgraded `website` → `chat` on follow-up messages (no task intent detected for "go to reddit.com"). Fix: skip guard for console channel.
6. **qwen3-coder repeated snapshots.** Model called snapshot 8x in a row without acting on results. Can't self-regulate multi-step browser interactions.
7. **gemma4:26b froze on browser control.** Switched from qwen3-coder hoping better reasoning would help. Instead: (a) thinking tags parsed as final answer — parser didn't strip `<|channel>thought` blocks, ending loop at step 4, (b) temperature clamp to 0.3 killed MoE performance (needs 1.0), (c) even with both fixes, model froze generating massive thinking blocks with 16K token headroom instead of acting. gemma4 reasons too much and acts too slowly for rapid browser interaction.
8. **qwen3.6:35b works.** Better reasoning than qwen3-coder, faster than gemma4. Uses direct URLs (google.com/search?q=...) instead of multi-step UI interaction. Searches across multiple vendors (Google, eBay, Amazon). Only issue: retried 404 URLs instead of skipping them.
9. **web_fetch competing with browser tool.** Model had web_fetch, browser, and web_search available. Defaulted to web_fetch (simpler) instead of using the browser to navigate pages the user can see. Fix: strip web_fetch from tool list in browser control mode — forces the model to use browser for navigation.
10. **Page content bloated compaction.** 10K chars of page content repeated in session history broke compaction. Fix: strip `[PAGE_CONTENT]` from archive after fact extraction but before summary generation.
11. **Drift detector fighting completion.** Model has enough data and tries to synthesize final answer, but drift detector flags "growing text" and re-anchors, forcing more unnecessary actions. Browser control needs different drift thresholds.

**Model evaluation for browser control:**
- qwen3-coder:30b — fast tool calls but can't reason about multi-step sequences. Loops on snapshots.
- gemma4:26b — good reasoning but freezes generating thinking blocks. Too slow for interactive browser actions.
- qwen3.6:35b — best balance. Plans well (direct URLs), acts quickly, recovers from errors. Active choice.

**Lesson:** Browser control is fundamentally different from browser fetching. The website specialist ("fetch and summarize") can't do multi-step automation. Needed: a dedicated prompt (plan before acting, never repeat actions, prefer direct URLs, recovery strategies), a reasoning model (qwen3.6 over qwen3-coder/gemma4), more iterations (25), higher output tokens (16K), and web_fetch stripped from tool list to force browser usage.

### Deterministic pipeline for browser control — FAILED (June 2026)
**Tried:** Replaced the working ReAct browser control with a deterministic pipeline (plan → reflect → execute → synthesize → quality review → revision). Same pattern as analytics/heartbeat/web-search. 280 lines became 601 lines.

**What broke:**
1. **Synthesize stripping cascade** — LLM told to output "synthesize" as final step, `parse_plan` stripped it, `reflect_on_plan` stripped it again from revised plans → plans shrank from 5 steps to 1-2
2. **Plan reflection made plans worse** — saw a 4-step plan, "revised" it to 2 steps. Same model doing action + critique produces rubber stamp effect (confirmed by research)
3. **Per-step reflection JSON parsing failed** — summary field contained page content with unescaped quotes/newlines that broke JSON parsing, even with JSON5. When reflection failed, no summary was captured → synthesis had no data
4. **Reflection injected hallucinated actions** — `sort_results`, `validate_urls`, `check_pagination` despite action validation filter (plan reflection's revised plan bypassed validation initially)
5. **Quality review suggested infrastructure changes** — "use Playwright with waitForSelector" — revision LLM took this literally and wrote a Python tutorial instead of product data
6. **Revision hallucinated data** — with no real data from failed collection, revision invented URLs, prices, and vendor names

**Research findings that explain the failure:**
- Skyvern (45% → 85.8% on WebVoyager) achieved this by adding a **Validator LLM**, not a planner. Upfront planning is a known failure mode.
- Browser-Use uses pure ReAct with code-driven loop detection (action hashing). No separate planner.
- Same model for action + critique produces rubber stamp effect. External signals (DOM mutations, screenshot diffs) are needed for honest validation.
- WebVoyager keeps only 3 most recent observations. Keeping all step results bloats context.

**What worked instead:** Guided ReAct with code guardrails:
- Action dedup via hash comparison (Browser-Use pattern) — blocks identical consecutive tool calls
- Content-aware auto-vision — regex checks for price/product patterns in snapshot, auto-escalates to screenshot+vision when missing
- Skip growing-text drift detection — let model produce long final answers
- 20 iterations max, qwen3.6:35b, web_fetch stripped

**Lesson:** Not everything benefits from a deterministic pipeline. Browser control is inherently reactive — the model needs to see page content before deciding what to do next. Upfront planning commits to a strategy before seeing the data. The pipeline pattern works for categories with predictable workflows (analytics: always load → compute → chart → interpret). Browser control has unpredictable workflows — different sites, different layouts, different failure modes. ReAct with code guardrails (dedup, vision fallback, iteration caps) is the right pattern.

**Status:** Active. Guided ReAct with action dedup, content-aware auto-vision, qwen3.6:35b. 10 steps for multi-vendor comparison with real prices and URLs.

### !save writing to both FactStore and GraphMemory (May 2026)
**Problem:** The `!save` command (user-approved fact storage after `!reset`) only wrote to the flat JSONL FactStore, never to FalkorDB. Facts only reached the graph via heartbeat transcript review — a separate extraction pass that could produce different results.
**Fix:** `!save` now writes each fact to both stores. GraphMemory `addFact()` runs entity extraction, NER with typing, canonical normalization, and vector embedding.
**Status:** Active.

### URL routing: website specialist with fetch→browser fallback (May 2026)
**Problem:** Pasting a URL into chat caused the router to classify it as `web_search`, which searched for related content instead of fetching the actual URL. The `website` category existed but used a broken `website_query` tool (required `tools.website.baseUrl` config that was never set).
**Fix:** Added pre-model override in `classifier.ts`: any message containing a URL routes to `website`. Rebuilt the `website` specialist to use `web_fetch` → `browser` fallback (ReAct loop, no pipeline). Reddit and other JS-heavy sites that block `web_fetch` get rendered by the headless browser automatically.
**Status:** Active.

### Setup wizard overhaul (May 2026)
**Problem:** The setup wizard generated a ~60 line config that silently disabled most features. No graph memory, no heartbeat, no security, no research/image/personal specialists, no pipeline fields. Preflight said "All checks passed!" with a severely incomplete config.
**Fix:** Complete rewrite of `generate.ts` to produce a production-ready config (~200 lines). Added prompts for: ownerId, trusted users, FalkorDB (with auto-install), OpenCode (with auto-install), heartbeat, reasoning model, image generation. Added prerequisites check (Docker) at wizard start. Preflight now warns about missing ownerId, no trusted users, disabled heartbeat, unavailable graph memory.
**Status:** Active.

### Analytics pipeline: code computes, model interprets (May 2026)
**Problem:** When users upload data files (CSV/Excel), the model hallucinated numbers. Tried multiple approaches: letting the model compute from pandas output (invented $1.2M totals), providing "authoritative data" labels (model ignored them), stricter prompts (still fabricated breakdowns). The model cannot reliably copy numbers from structured data.
**Decision:** Complete separation — Python computes ALL numbers (totals, breakdowns, top items, distributions) as a formatted markdown report. The LLM ONLY interprets the pre-built report, adding executive analysis, risk assessment, and recommendations. Same pattern as heartbeat: code handles "what", model handles "so what".
**Pipeline:** extract_file → report (Python/pandas) → generate_charts (matplotlib) → interpret (LLM) → attach_charts. Smart column selection: prefers "Total" over "Unit Cost", groups by "Category" not "Date", labels by "Item Description" not "Vendor". Python runs via /tmp scripts to avoid exec tool cwd path issues.
**Key bugs found:** JS template literals eating Python f-string `{}` braces, exec tool doubling workspace paths, matplotlib crashing on NaN in categorical data, column keyword matching order (column-first vs keyword-first).
**Status:** Active. File type routing in orchestrator: .csv/.xlsx/.json auto-route to analytics, text files prompt user for knowledge base vs read-as-text.

---

## Known Issues

### Double message delivery on Discord (intermittent)
**Problem:** Occasionally the bot sends the same response twice in Discord — the stream preview message AND a separate final message, resulting in duplicate content.
**Frequency:** Rare, observed twice in extended testing sessions.
**Suspected cause:** Race condition between stream message edit and the channelRegistry.send fallback path. May also relate to silent re-route or capability gap detection triggering a second dispatch.
**Impact:** Cosmetic — the response content is correct, just duplicated.
**Status:** Logged for investigation. Not blocking daily use.

### Gateway 429 rate limit under request bursts (June 2026)
**Problem:** The Ollama gateway (10.9.8.20:8001) caps at 100 requests/minute. Everything except MiniMax (router classify, embedding, NER, vision, pipeline quality_review, post-task review, semantic state extraction) hits the gateway. A single web_search message fires several gateway calls; rapid messages + 5 parallel fetches burst past 100/min → `429 rate_limit_exceeded`.
**Observed:** "OLLAMA_INFERENCE_ERROR: Classification failed — 429" + "Post-task review failed — 429".
**Impact:** Degrades gracefully (router falls back to keyword classification, reviews skip) — nothing crashes — but lossy: a 429'd router classification means keyword routing instead of the model, which is exactly when misroutes creep in.
**Potential fixes (NOT yet done):**
1. **Infra:** raise the gateway req/min cap (100 → 300-500) — it's tight for a multi-call pipeline on shared small models.
2. **Client:** add 429 backoff/retry to `OllamaClient.post()` — it currently retries once on *connection* failure but throws immediately on 429. A short exponential backoff (the rate window resets in <60s) would smooth transient limits instead of dropping the call. This is the right resilience fix regardless of the gateway cap.
3. **Reduce burst:** post-task review + quality review add gateway calls per message; consider gating them or batching.
**Status:** Documented, deferred. Fix #2 (client backoff) is the cleanest LocalClaw-side improvement.

### Research / deck pipeline fragile (June 2026)
**Problem:** The research pipeline's deck/PDF rendering path (reveal.js deck + styled PDF branch) is unreliable — "the whole deck thing is kinda broken."
**History:** This path has been fragile since the deck/report branch was added; an earlier deterministic browser-control pipeline in the same family was reverted for similar reasons (see Failed Approaches).
**Impact:** Report/deck generation (`research` category, "make me a report/deck") produces broken or incomplete output. Web_search synthesis (the lighter path) works well.
**Potential fix (NOT yet done):** A focused rebuild of the research pipeline render stages — review the chart-gen → write_file → render_deck flow, the HTML template, and the PDF branch. Worth its own session, not a 1am patch.
**Status:** Documented, deferred to a dedicated session.

### Chat over-promises tool actions (band-aid in place) (June 2026)
**Problem:** The toolless chat specialist sometimes promises actions it can't perform ("Let me search for X", "On it, let me pull together…") and then can't follow through — no tools, no ReAct loop, so hallucination detection (which lives in the tool-loop engine) never runs.
**Current mitigation (band-aid):** The silent re-route (dispatch.ts) now catches future-action promises (search/research verbs) and re-dispatches to a specialist that can actually do it.
**Cleaner fix (NOT yet done):** Strengthen the chat system prompt so it doesn't promise tool actions in the first place — if it needs to search, it should signal a re-route, not narrate intent. Pairs naturally with the research-pipeline work.
**Status:** Band-aid active (catches it post-hoc and does the search); prompt-level fix deferred.

### SearXNG self-hosted search provider (June 2026)
**Problem:** Brave's free tier (~1 req/sec, 2000/month) forced a serialized throttle + 429 backoff and capped the research/verification search budget (bounded Tier-1 cross-checks, sequential facet searches). The rate limit was the recurring bottleneck across the whole research/verification build-out.
**Fix:** Added a `searxng` provider to `src/tools/web-search.ts` (+ `provider` enum and a `baseUrl` field in `WebSearchConfigSchema`). SearXNG is a self-hosted metasearch engine — no API key, no rate limit. Calls `GET {baseUrl}/search?format=json`, maps our `freshness` (day/week/month/year) → SearXNG `time_range` (same vocabulary), slices to `count`. Requires the instance's `settings.yml` to enable the JSON format (`search.formats: [html, json]`) — returns a clear 403 error otherwise. Purely additive; Brave/Tavily/etc. paths unchanged. Runtime config points at the LAN instance (gitignored).
**Status:** Live. With no rate limit, the Brave throttle is effectively bypassed and the Tier-1/facet search budgets can be widened if desired.

### web_search recall depth + freshness effectiveness (June 2026)
**Problem:** Broad multi-vendor survey queries via web_search (single query, now top-5 fetches) can still miss product-specific pages (e.g. missed the DGX Spark article in an Apple/NVIDIA/AMD survey — it ranked below the comparison pieces).
**Mitigations done:** fetch 3→5 pages; freshness forcing on recency-signalling queries.
**Open questions (NOT verified):**
1. Does the search provider (Brave) actually honor the `freshness=month` param? A "recent" query once returned 2019-2023 content even with freshness forced. Needs isolated verification.
2. Broad surveys are really a `research` request (multi-query, 8 fetches, supplementary round), not a `search` one — but "search the web for X" routes to the shallow pipeline. Consider routing multi-entity surveys to research.
**Status:** Documented. Freshness-param verification is the next concrete check.

### Routing latency on the gateway (June 2026)
**Problem:** Router classification (phi4 on the gateway) occasionally takes 4-5s (observed `Routing: 4957ms`). Memory runs in parallel, so it's the classifier itself — almost certainly gateway contention (many models resident on the A5000 node, or phi4 cold-reloading).
**Potential fix (NOT yet done):** `OLLAMA_MAX_LOADED_MODELS` bump or trimming what's resident on the gateway so phi4 stays warm. Infra-side, not code.
**Status:** Documented, watch. Related to the 429 issue — both point at gateway-node pressure.

---

## Future Ideas (Stashed)

### MFLUX + Pillow programmatic diagram generation
**Idea:** Use MFLUX (Apple MLX port of FLUX) to generate cyberpunk/stylized backgrounds locally, then composite text blocks, neon borders, and connection lines with Pillow. Produces architecture diagrams, system maps, status dashboards — all locally, no API.
**Why it fits:** Already have Flux on the infrastructure for image_generate. This extends it from "generate a picture" to "generate a technical visual." Could become a LocalClaw tool or pipeline stage.
**Inspiration:** Seen in another local AI setup that generated cyberpunk architecture diagrams this way.
**Status:** Stashed. Circle back when image pipeline is more mature.

### DevMesh integration into LocalClaw
**Idea:** LocalClaw becomes the control plane for DevMesh outreach platform. Phase 1: status/control tools (manage from Discord). Phase 2: pipeline convergence (shared search, LLM routing, cron, CRM tools).
**Why it fits:** Both systems share Ollama, cron, web search. LocalClaw's memory + calendar awareness can drive smarter outreach decisions.
**Status:** Stashed. Plan light integration first. See `memory/project_devmesh.md`.

---

## Conference-Inspired Improvements (June 2026, AI Dev Summit)

### Memory decay (June 2026)
**Source:** Talk 2 (Lamatic AI) — "memory eviction and decay let the agent forget gracefully."
**Problem:** Facts persist forever in the graph store. Low-importance ephemeral facts accumulate, degrading search quality. Flat store has TTL but graph store had none.
**Fix:** `applyDecay()` in GraphMemoryStore. Confidence decays automatically based on importance tier: imp 1 at 0.05/day, imp 2 at 0.02/day, imp 3 at 0.005/day. Identity facts (4-5) never decay. Facts below 0.3 confidence auto-removed. Facts 0.3-0.5 surfaced as review candidates.
**Status:** Active.

### Contradiction eviction (June 2026)
**Source:** Talk 2 (Lamatic AI) — "deleting 'favorite color is red' when user says they hate red."
**Problem:** "I use Ubuntu" and "I switched to Arch" coexisted in the graph until manual heartbeat review.
**Fix:** On `addFact()`, vector search for similar existing facts (cosine distance 0.15-0.4). For each match, phi4-mini judges YES/NO on contradiction. If YES, old fact marked `superseded: true`.
**Status:** Active.

### Token economics monitoring (June 2026)
**Source:** Talk 1 (stealth founder) — "Uber burning annual token budget in four months."
**Problem:** Ollama returns `eval_count` and `prompt_eval_count` in every response but they were completely discarded. No visibility into token consumption per category.
**Fix:** Token counts captured from Ollama responses (both streaming and non-streaming), accumulated per tool loop iteration, logged per dispatch. `[Dispatch] Tokens: 3200 prompt + 800 completion = 4000 total (web_search)`
**Status:** Active.

### LLM-as-judge quality scoring (June 2026)
**Source:** Talk 3 (Ramana) — "LLM-as-judge graded on accuracy, relevance, citation, tone."
**Problem:** Quality review existed only in web_search and research pipelines. No systematic scoring across categories.
**Fix:** Post-dispatch quality check for pipeline categories (web_search, research, analytics, multi, exec, code_gen). Router model scores 1-5 on accuracy, relevance, completeness. Logged to `data/quality/quality-scores.jsonl` for weekly review. Skipped for chat/cron/task/memory (subjective or deterministic).
**Status:** Active.

### Metadata-filtered memory search (June 2026)
**Source:** Talk 3 (Ramana) — "metadata as the filter layer applied before semantic search."
**Problem:** Vector KNN searched ALL facts for a sender. No pre-filtering by importance, category, or age.
**Fix:** `search()` now accepts optional filters: `minImportance`, `categories`, `maxAgeDays`. Cypher WHERE clauses applied before vector KNN. Dispatch can pass context-aware filters per category.
**Status:** Active (filters available, context-aware dispatch filtering ready to wire).

### Specialist use case specs (June 2026)
**Source:** Talk 3 (Ramana) — "12-point spec per use case."
**Fix:** `SPECIALISTS.md` with 12-point specs for top 5 specialists (chat, web_search, research, multi, exec). Includes in/out scope, acceptance criteria, edge cases, known failures, test cases.
**Status:** Active.

### Session-scoped permissions (June 2026)
**Source:** Talk 5 (Architex) — "block by default, approve once scoped to the conversation."
**Fix:** Added `toolGrants` to SessionState. Foundation for per-session tool access with TTL.
**Status:** Schema added, enforcement logic ready to wire in dispatch.

### Progressive tool disclosure (June 2026)
**Source:** Talk 6 (Juwan Lightfoot) — "MCP servers inject ~7000 tokens of tool definitions."
**Fix:** Added `relevanceHints` field to LocalClawTool interface. Foundation for filtering tool injection based on user message context.
**Status:** Interface extended, filtering logic ready to wire in prompt-builder.

### Media burst handling (June 2026)
**Source:** WhatsApp media burst incident.
**Fix:** Vision queue (one call at a time), media debounce (3-second batching), video path (acknowledge and save), rate limiter adjustment.
**Status:** Active.

---

## Security Hardening (June 2026, External Review)

### Web API authentication warning (June 2026)
**Finding (P0):** Web adapter bound to 0.0.0.0 with no token = anyone on the network can exec commands.
**Fix:** Startup warning when no token + 0.0.0.0. Host stays configurable (user accesses from network). README updated with security configuration section and explicit guidance to set a token.
**Status:** Active. Warning on startup, docs updated.

### Session route path traversal (June 2026)
**Finding (P1):** Console API accepts `agentId` from URL path and passes to `join(baseDir, agentId, ...)` unsanitized. `../` in agentId = file access outside sessions directory.
**Fix:** `sanitizePath()` strips `..` and path separators. SessionStore now sanitizes agentId in all path methods (not just sessionKey).
**Status:** Active.

### File containment prefix matching (June 2026)
**Finding (P1):** `startsWith(resolve(workspace))` allows sibling-prefix escapes (`main2` when workspace is `main`).
**Fix (round 1):** Changed to `startsWith(resolve(workspace) + '/')`.
**Fix (round 2):** Replaced with `path.relative()` + `isAbsolute()` check — cross-platform safe (POSIX + Windows). Applied to read_file, write_file, console file serving, and static console serving.
**Status:** Active.

### Telegram allowFrom (June 2026)
**Finding (P2):** Discord and Slack enforce `allowFrom`, Telegram didn't.
**Fix (round 1):** Added `allowFrom` set to TelegramAdapter.
**Fix (round 2):** Fixed to read `allowFrom.users` (schema-compatible `{users?: string[]}`) instead of treating `allowFrom` as a flat array (which never matched the Zod schema).
**Status:** Active.

### Scoped tool executor (June 2026)
**Finding (P1):** ToolRegistry.createExecutor() directly executed any tool. Pipeline stages bypassed dispatch-time filtering.
**Fix:** Added `createScopedExecutor(allowedTools: Set<string>)` — rejects tools not in the allowlist. Wired in both ReAct and pipeline dispatch paths as the final enforcement gate. Cron tool stripping now enforced even in pipelines.
**Status:** Active.

---

## Latency Optimization (June 2026)

### Parallel memory + router (June 2026)
**Problem:** Graph memory queries (embed → KNN → multi-hop → user model) ran sequentially BEFORE router classification. ~800-1500ms of blocking before routing even started.
**Fix:** Router classification and memory injection run as `Promise.all()`. Router starts immediately, memory runs alongside. Memory results injected when they arrive — if memory finishes during routing, wait time is 0ms.
**Also:** Lazy multi-hop — only runs if KNN returns <3 results (inspired by Hermes Agent pattern).
**Measured:** Routing 0-4ms (sticky) with memory priming 235-2900ms in parallel. Previously sequential (additive).
**Status:** Active.

### Async compaction cache → turn-count gated + prewarm (June 2026)
**Problem:** History compaction ran synchronously every message once history exceeded budget (300-1000ms blocking).
**v1:** Cache compaction per session (5-min TTL), serve cached + refresh async.
**v2 (review fix):** TTL-only cache could serve history MISSING the previous exchange. Gated cache validity on SessionStore `turnCount` — reuse only if no new turns since it was built.
**v3 (review fix):** Turn-count gate made the cache miss after every exchange (each response appends 2 turns). Added a **prewarm**: after appending turns, build+cache compaction in the background keyed to the new turn count, so the next message hits a warm, correct cache.
**v4 (review fix):** Removed the cache-hit async refresh entirely — with turn-count gating a cache entry is exact for its turn count (can't drift) and turn count only increases, so the refresh cached an obsolete count and raced the prewarm for the `pendingCompactions` lock. Deleting it fixed the race by removing the path.
**Reset:** `clearSession` resets metadata `turnCount` to 0; `clearCompactionCache()` clears the entry on `!reset`/`!new` so a fresh session can't reuse old compacted history.
**Status:** Active. (Note: with the 128K context raise, compaction's expensive LLM summary rarely fires at all now.)

### Tool-loop streaming (June 2026)
**Problem:** Tool-loop specialists used non-streaming `client.chat()`. User saw "thinking..." for 2-5 seconds with no feedback.
**Fix:** Three streaming points: (1) plain-text tool status events ("Searching...", "Running command...") before each tool execution, (2) max-iterations synthesis via `chatStream()` with `tools: undefined` (safe — no tool-call risk), (3) normal final answer post-hoc streamed after tool calls complete.
**Rule:** Tool-loop model calls stay non-streaming (prevents leaking JSON/function calls). Only stream user-facing natural language.
**Status:** Active.

### Web-fetch page caching + URL key case (June 2026)
**Problem:** Same pages fetched repeatedly across conversations. No caching.
**Fix:** In-memory cache with 1-hour TTL. SSRF validation runs BEFORE cache check, and returns a tool-style `Error:` (not throw). Cache key includes URL + extractMode + maxChars. Non-HTML responses cached too.
**Review fix:** `normalizeCacheKey` lowercased all keys — fine for search queries, wrong for URLs (`/Foo` vs `/foo` collide). Split into `normalizeCacheKey` (queries, lowercase) vs `normalizeUrlKey` (URLs, trim only); `readCache`/`writeCache` now use keys verbatim and callers normalize.
**Status:** Active.

### Search source buckets — removed (June 2026)
**History:** `src/pipeline/search-buckets.ts` mapped query topics to curated-domain buckets and appended `site:` filters (with an anchor convention guaranteeing high-value domains, a `real_estate` bucket, civic open-data spread, etc.).
**Why removed:** In practice the buckets didn't deliver — `site:` filters over-constrained Brave on longer/question-shaped queries (often returning nothing), and the curated domain lists added maintenance and misroute risk (e.g. "AMD/NVIDIA hardware for local inference" landed in ai_tech, not hardware) without improving result quality. Per the user: "the bucket angle just hasn't produced what I thought it would."
**Fix:** Deleted `search-buckets.ts` + its test. `web_search` and `research` now run plain queries with **recency/freshness filtering only** — `freshness=month` is forced when the query signals recency (research applies the same `wantsFreshness` check per angle and on the topic). URLs are taken in result order (no bucket re-prioritization).
**Status:** Buckets gone; recency filter retained.

### Per-domain source-diversity cap — tried and reverted (June 2026)
**What was tried:** Research capped fetches at ≤2 per domain run-wide (+ distinct domains within a facet, exact-URL dedup), to stop runs leaning on one source. It raised the source count (12→16) and the automated quality score (rel 4→5, comp 3→4).
**Why reverted:** Side-by-side, the *capped* report was visibly **worse** — less well-rounded. Root cause: a single genuinely comprehensive survey source (an "enterprise guide" page) had been the backbone of the good run, legitimately informing many facets (ASIC ecosystem, vendors, market size, DGX Spark). The cap throttled exactly that source, forcing reliance on thinner specialized pages — trading breadth for scattered depth. The original "all from one source" complaint was really **cosmetic log noise** (the same URL re-found across facets, already harmless via the `seen`-style dedup), not a quality problem. The automated judge rewarded source count; the human judged substance and preferred the uncapped run.
**Lesson:** Don't cap how much a comprehensive source can contribute. Diversity-by-fetch-cap is the wrong mechanism; a great survey should be allowed to anchor a report. Recency bias + Brave freshness-code mapping (from the same commit) were kept — only the cap was rolled back.
**Status:** Reverted to plain top-3 URLs per facet in result order.

### Evidence verification layer for research (June 2026)
**Problem:** MiniMax synthesizes a confident report from mostly secondary blogs with no check that each statement is supported by its cited source. Live output stated materially false claims as fact — NVIDIA's Dec-2025 Groq arrangement called an "acquisition" (it was a non-exclusive license + hires), Cerebras IPO dated Feb 2026 (actual debut May 14 2026).
**Approach (MVP):** A cited-source-only verification pass between `parse_final` and `generate_visuals` (`src/pipeline/verification.ts` + stages in research.ts). Principle: **no claim should outrun its evidence.** Extract atomic claims (fast model) → check each against the *cached* page it was built from (research now persists `_sourceText`, so zero new searches) → entailment judge returns a controlled verdict (VERIFIED/PARTIALLY_VERIFIED/UNSUPPORTED/VENDOR_CLAIM/AMBIGUOUS) → MiniMax correction pass edits ONLY failed sentences (attribute "according to X" / qualify / remove) → re-extract + diff to catch claims added during revision → publish with a `## Verification` appendix + auditable `verification.json`. Config-gated (`verification` block, on by default); correction stage `when`-skips if all VERIFIED. Never hard-blocks publication.
**Known limit (by design):** cited-source-only catches *overstatement* and enforces *attribution* — it cannot disprove a source that is itself wrong/stale (the Groq/Cerebras blogs get honestly attributed, not corrected to the truth). Independently disproving those needs a **Tier-1 cross-check** (one targeted official-source fetch for high-impact + weak-sourced claims) — designed, deferred to Phase 2 along with benchmark-schema validation, an adversarial synthesis critic, and hard publication gates.
**Live result — DISABLED by default (June 2026):** First live run degraded the report (quality acc 5→3) and deleted true claims (M3 Ultra 512GB, NVIDIA ~92% share, $255B-by-2030, the Groq deal). Three bugs: (1) `verdictToAction` mapped UNSUPPORTED→**remove** instead of attribute/qualify — deletion is the opposite of the "according to X" goal; (2) **citation→source mismatch** — the synthesis model's `[n]` numbering is unreliable and reports synthesize across sources, so checking a claim against its single (mis-)cited URL yields false UNSUPPORTEDs (claims cited to the right page verified fine; misattributed-but-true claims got removed); (3) the revision **claim-diff appendix is noise** — reworded/merged sentences show as "newly added." Flipped `verification.enabled` default to **false** (code retained, fully gated). Fix plan: never auto-remove (UNSUPPORTED→qualify/attribute); check each claim against the **broader cached corpus** (`_sourceText` for all sources, top-K by token overlap) not one cited URL; drop the diff. Re-enable only after a live run shows it *improves* (not degrades) accuracy.
**Precision fixes — RE-ENABLED (June 2026):** Fixed all three on a branch and merged: (1) **never auto-remove** — UNSUPPORTED/AMBIGUOUS → `qualify` (hedge the certainty), VENDOR_CLAIM → `attribute`; any judge-returned `remove` is coerced to a hedge; (2) **broader-corpus check** — `pickRelevantSources()` ranks all cached pages by token/number overlap and the judge sees the top-K that actually mention the claim (plus the cited URL), reporting which source supports it — kills the false-UNSUPPORTEDs; (3) **dropped the revision diff** + concise-hedging instruction (one qualifier per sentence). Second live run: **0 removes** (was 8), 5/12 claims hedged/attributed, all true claims survived (92% share → "According to Intuition Labs…", M3 Ultra 512GB kept + hedged). The automated quality judge still scored it low (acc 3, comp 2) but a human read confirmed the report is comprehensive and well-rounded — **the judge is not a trustworthy signal here** (it also over-rewarded the disliked diversity-cap run). Re-enabled by default.
**Phase 2 — Tier-1 independent cross-check (June 2026):** Added to catch faithfully-cited wrong facts (the Groq-date class). After cited-source verification, a `tier1_crosscheck` stage escalates a bounded set of **high-impact, falsifiable** claims (`corporate_event`/`financial`/`market_share` with named entities, capped at `maxCrossChecks`=4) to ONE independent `web_search` + fetch each. The query is built from entities + key terms **minus the contested value** (so it finds the authoritative source, not echoes of a wrong number). A judge returns CONFIRMED / CONTRADICTED / SILENT: CONTRADICTED → new `CONTRADICTED` verdict + `correct` action (the correction pass replaces the wrong detail using the independent evidence); CONFIRMED → un-hedges a previously qualified claim; SILENT → leaves the cited-source verdict. Bounded search budget (~≤4 searches, absorbed by the Brave throttle). Config: `verification.crossCheck` (default true), `maxCrossChecks` (4).
**Targeting fix (June 2026):** First Tier-1 live run executed correctly (4 cross-checks, bounded, throttle fine) but caught nothing useful — it escalated volatile **product-price** claims (the extractor tags "priced at $X" as `financial`), whose searches returned junk (a Robinhood NVDA stock page → SILENT), and the draft happened to contain no corporate-event claim at all. Narrowed `ESCALATE_TYPES` to **`corporate_event` + `market_share`** only (acquisitions/IPOs/launches/share — the actual Groq/Cerebras/92% class); dropped `financial`. Under this, that run escalates 0 and spends 0 searches — correct.
**Extraction-coverage fix (June 2026):** A later run still slipped a wrong "NVIDIA acquired Groq" past Tier-1 — because `extract_claims` pulled 9 GPU-price claims and never extracted the corporate event, so it never reached the cross-check. Fixed by instructing the extractor to ALWAYS include corporate events (with date, amount, and exact verb "acquired" vs "licensed") and market-share figures BEFORE routine prices/specs.
**Validated (June 2026):** With both fixes, a live run finally produced the end-to-end catch: Tier-1 independently found NVIDIA's own statement ("We haven't acquired Groq. We've taken a non-exclusive license…") → CONTRADICTED → the correction pass rewrote the report from "acquired" to "licensed," and corrected ~92%→94% market share from Jon Peddie Research. Confirmed in `verification.json` and the rendered PDF.
**Render fix (June 2026):** The correction model marked edits Word-style — wrapping old text in GFM strikethrough (`~~…~~`) and adding the replacement beside it; with `gfm` rendering, the PDF showed lines through the (still-present) wrong text. `stripStrikethrough()` removes struck spans/`<del>`/stray markers at the render chokepoint, plus a prompt instruction to replace cleanly.
**Status:** Live and enabled (cited-source + Tier-1), end-to-end catch validated. 389 tests. Caveat (real-world ambiguity, not a bug): the Groq deal is genuinely reported both ways — groq.com says "non-exclusive license," CNBC frames it as a "$20B acquisition" — which is the strongest argument for the verifier *attributing* disputed claims rather than silently rewriting; a future refinement. Trust the human side-by-side read over the judge score ([[feedback_regressions]]).

### web_search over-trigger (June 2026)
**Problem:** Conversational text containing bare "search"/"latest"/"news" (e.g. "uses brave for search") classified as web_search and ran the full pipeline.
**Fix:** Tightened the keyword hint to require intent ("search for/the web/online", "web search", google, look up, find out about); dropped bare search/latest/news. Router-prompt nudge for the model layer (not unit-testable — model layer has 0 corpus cases; needs live verification). Also: web_search forces `freshness=month` when the query signals recency, and the quality judge gained a recency check (was scoring a 2019-2023 retrospective 5/5/5 on a "recent" query).
**Status:** Active.

### Expanded pre-model overrides (June 2026)
**Problem:** Router LLM inference (phi4:14b) takes 400-800ms even for obvious classifications.
**Fix:** Added pre-model overrides: "add/create task" → task, "show/list tasks" → task, "generate/create image" → image. Conservative start-of-message patterns only. Also added speculative language override: "I wonder", "what if", "do you think" → chat (prevents "I wonder if you could create" → multi).
**Status:** Active.

### Conversational guard simplified (June 2026)
**Problem:** Keyword-based task intent matching caused both false positives (blocked "do some web search") and false negatives (let "I wonder if you could create" through). Every keyword fix broke another case.
**Fix:** Replaced 11-line keyword regex with 8-line length check: short messages (<30 chars) mid-conversation downgrade to chat. Long or explicit messages trust the router. No keyword matching.
**Status:** Active.

### Quality judge calibration (June 2026)
**Problem:** LLM-as-judge scored every response against research-report standards. Web search returning structured data with sources scored 2/5 (POOR).
**Fix:** Calibrated prompt per category with scoring guide: "a structured answer with sources is at least a 4." Category name included in prompt so judge knows the expected output format.
**Status:** Active.

---

## Ollama Version Issues

### Image generation API broken on 0.23.1 (May 2026)
**Problem:** Flux model on second Mac Mini returned empty progress lines (4/4 steps in milliseconds) with no image data via API. Worked fine via `ollama run` locally.
**Fix:** Downgraded to Ollama 0.21.2. Image generation works correctly over API on this version.
**Status:** Pinned at 0.21.2 on image gen Mac Mini. Monitor future Ollama releases for fix.
