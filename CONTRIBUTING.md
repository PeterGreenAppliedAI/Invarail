# Contributing to Invarail

Thanks for your interest in contributing! Invarail is a local-model-first AI agent framework, and contributions of all kinds are welcome — bug fixes, new tools, new channel adapters, documentation, and tests.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.ai/) running locally or on your network
- Required models:
  - **Foreground:** any Ollama-native or OpenAI-compatible served model, configured via the single root `defaultModel` line (fills all specialist/briefing/heartbeat/vision slots — current production model: qwen3.8:27B, Ollama-native on a 24GB GPU; on one small box the measured recommendation is `qwen3.5:9b` with thinking off, `qwen2.5:7b` on an 8GB machine — see [INSTALL.md](INSTALL.md))
  - **Utility tier** (Ollama):
    ```bash
    ollama pull phi4               # Router / fact extraction
    ollama pull phi4-mini          # NER / utility model
    ollama pull qwen3-embedding:8b # Embeddings (optional: memory.embeddingModel "none" runs without one)
    ```
  - A one-model install works too: the Starter preset uses the foreground model for every slot.

### Setup

```bash
git clone https://github.com/PeterGreenAppliedAI/Invarail.git
cd Invarail
npm install
npm run setup       # detect-first wizard: writes invarail.config.json5 (+ .env)
npm run doctor      # checks every dependency your config enables
# or by hand:
# cp .env.example .env && cp invarail.config.starter.json5 invarail.config.json5
```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the bot (tsx, auto-imports TypeScript) |
| `npm start` | Quiet doctor pass, build the console once, boot |
| `npm run setup` · `npm run doctor` | Setup wizard · dependency check against your config |
| `npm run cli` | Terminal client |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`, then `tsc -p tsconfig.scripts.json` for the e2e harness) |
| `npm run build` | Build for production (tsdown) |
| `npm run supervise` | Node supervisor (health check, crash loop, exit-42 deploys with rollback) |
| `npx tsx scripts/e2e-eval.ts --selftest` | Front-door e2e harness against a scripted performer — no model needed |

### Verify Your Setup

```bash
npm run typecheck   # Should pass with zero errors
npm test            # 1205 tests across 140 files should pass
npx tsx scripts/e2e-eval.ts --selftest   # front-door harness, no model
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── orchestrator.ts       # Lifecycle, rate limiting, voice model override
├── dispatch.ts           # Router → Specialist pipeline
├── config/               # JSON5 config + Zod validation
├── router/               # Intent classification (overrides → model → keywords → default) + shadow router
├── tool-loop/            # ReAct tool-calling loop engine
├── ollama/               # Ollama + OpenAI-compat clients; multi-backend routing by model id
├── channels/             # Pluggable adapters (Discord, Telegram, Gmail, Web)
├── services/             # Heartbeat, briefing, email steward, memory capture, TTS/STT
├── tools/                # Tool implementations
├── agents/               # Workspace files + agent routing
├── context/              # Token budget, history compaction
├── sessions/             # Transcript persistence
├── cron/                 # Scheduling service
├── memory/               # FalkorDB graph store + flat fallback + SQLite embeddings
├── tasks/                # Task board (JSON + Markdown)
├── browser/              # Chrome-extension remote bridge (the browser tool lives in tools/)
├── pipeline/             # Deterministic stage engine (research + heartbeat only)
├── security/             # Pending-action ledger, standing grants, web identity
├── coding/               # Pi SDK adapter + self-modification rail
├── mcp/                  # MCP client bridge
├── commands/             # `!…` commands
├── setup/                # Setup wizard, environment detection, doctor
└── exec/                 # Shell execution with sandbox
```

## Branching Model

The `main` branch is **protected** — all changes must go through pull requests.

- **No direct pushes to `main`** — CI status checks must pass before merge: typecheck, tests, the e2e harness selftest, build and console build on `ubuntu-latest`, plus a blocking `windows-latest` job (typecheck, tests, selftest, headless wizard smokes, console build)
- **Branches must be up-to-date** with `main` before merging
- **Branch naming conventions:**
  - `feature/` — new functionality (e.g. `feature/matrix-adapter`)
  - `fix/` — bug fixes (e.g. `fix/router-timeout`)
  - `docs/` — documentation changes (e.g. `docs/tool-api`)
- **`dev` branch** — persistent working branch for maintainers; feature branches can branch from `dev` or `main`
- **Contributor PRs target `main`**

## How to Contribute

### 1. Add a New Tool

This is the most common contribution. Each tool is a self-contained module.

1. Create `src/tools/my-tool.ts` implementing the `InvarailTool` interface
2. Register it in `src/tools/register-all.ts`
3. Add the tool name to a specialist's `tools` array in `invarail.config.json5`
4. Add tests in `test/tools/my-tool.test.ts`

### 2. Add a New Channel Adapter

1. Create `src/channels/myplatform/index.ts` (or `adapter.ts`) implementing the `ChannelAdapter` interface (5 methods: `connect`, `disconnect`, `onMessage`, `send`, `status`)
2. Add the dynamic import in `src/index.ts`
3. Add config section in `invarail.config.json5`
4. Zero core code changes required

### 3. Add a New Specialist Category

1. Add the category to `router.categories` in `invarail.config.json5`
2. Add specialist config to `specialists` in the same file
3. Write the category description to say what the specialist *cannot* do as well as what it does — the router picks from these, and the specialist reroute catches answers that claim a tool the specialist lacks (`src/router/reroute.ts`)
4. *(Optional)* Add keyword patterns (`KEYWORD_HINTS`) in `src/router/classifier.ts`
5. New specialists default to the arena (open ReAct loop); a deterministic pipeline is only for stages that verify (research, heartbeat)

### 4. Bug Fixes and Improvements

- Check the [issues](https://github.com/PeterGreenAppliedAI/Invarail/issues) for open bugs or feature requests
- If you find a bug, open an issue first so we can discuss the approach

## Code Style

- **TypeScript** with `strict: true` — no `any` unless absolutely necessary
- **ESM modules** — use `.js` extensions in imports (required by Node16 module resolution)
- **No linter configured yet** — just keep consistent with the existing code style:
  - 2-space indentation
  - Single quotes for strings
  - Semicolons
  - Descriptive variable names
- **Avoid over-engineering** — prefer simple, focused changes over abstractions
- **Comments** — only where the logic isn't self-evident

## Testing

We use [Vitest](https://vitest.dev/). Tests live in `test/` mirroring the `src/` structure.

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run test/router/classifier.test.ts

# Watch mode
npm run test:watch
```

**Guidelines:**
- Add tests for new tools, adapters, and any non-trivial logic
- Use `vi.fn()` for mocking
- Use `describe`/`it` blocks with clear descriptions
- Test edge cases, not just the happy path

## Pull Request Process

1. **Fork** the repo and create a branch from `main` using the naming convention above (`feature/`, `fix/`, `docs/`)
2. **Make your changes** — keep PRs focused on a single concern
3. **Run checks** before submitting:
   ```bash
   npm run typecheck   # Zero type errors (app + e2e harness)
   npm test            # All tests pass
   npx tsx scripts/e2e-eval.ts --selftest
   npm run build       # Build compiles
   ```
4. **Open a PR** targeting `main` with:
   - A clear title describing the change
   - A summary of what and why
   - Any testing you did
5. A maintainer will review and provide feedback

### PR Tips

- Small, focused PRs are reviewed faster than large ones
- If your change affects config, include example config in the PR description
- If adding a new tool or adapter, include a brief usage example
- Don't bundle unrelated changes — one PR per concern

## Configuration

Invarail uses `invarail.config.json5` for all configuration. When adding features:

- Add Zod schemas in `src/config/schema.ts` for validation
- Export types from `src/config/types.ts` as `z.infer<typeof XxxSchema>` — never hand-written interfaces
- Use environment variable interpolation (`"${ENV_VAR}"`) for secrets
- Document new config options in your PR
- Note: `config.principals` provides identity mapping — channel-specific user IDs map to a single principal


## Safety

Invarail takes security seriously. When contributing, keep in mind:

- **Exec allowlist or Docker sandbox** — shell commands must be explicitly approved; when the Docker sandbox is requested but missing, exec and code sessions are not registered (never a silent host fallback)
- **SSRF protection** — validate URLs with scheme whitelist and DNS pre-flight
- **Path traversal** — file writes must stay within the workspace
- **No secrets in code** — use `.env` for API keys and tokens
- **Input validation** — validate at system boundaries (user input, external APIs)

## Questions?

Open an issue or start a discussion. We're happy to help you get started.
