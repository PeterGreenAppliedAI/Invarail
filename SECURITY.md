# Security Policy

Invarail is a local-first agent with a code-enforced authority plane. Its security
boundaries — the six dispatch filters, the confirmation ledger, target-bound grants,
SSRF guards, canonical path containment — are code, not prompts, and they are what
we most want to hear about when they fail.

## Reporting a vulnerability

Email **petegree718@gmail.com** with "Invarail security" in the subject, or open a
[private security advisory](https://github.com/PeterGreenAppliedAI/Invarail/security/advisories/new)
on GitHub. Please do not file public issues for exploitable defects.

Include what you can of: the commit you tested, the config shape (which channels,
which tools, Docker or allowlist exec), the entry point (channel message, console
API, extension, cron, MCP server), and a reproduction — an isolated test with dummy
fixtures is ideal. Three outside reviews have used exactly that shape and every
finding was verified against running code, ranked for the deployment, and either
fixed with a regression test or closed with a recorded reason in `DECISIONS.md`.

You can expect an acknowledgement within a few days. This is a solo project; there
is no bounty, but findings are credited in DECISIONS.md unless you ask otherwise.

## Scope notes

- **Code sessions and the sandbox.** With `tools.exec.security: "docker"`, `exec` AND
  `code_session` run inside the sandbox container (no network, workspace read-only by
  default); a session that cannot be sandboxed is refused rather than run on the host.
  Pi builds (`pi_build`, `!improve`) run on the host inside git worktrees — that is the
  boundary there, not a container.
- **Who a web/console request is.** With `channels.web.token` set, the bearer is the
  owner's credential and the request runs as `ownerId`; a `senderId` in the body or query
  only partitions the session (one transcript per device) and cannot make a caller someone
  else. Without a token — loopback, or `insecureOpen` chosen on purpose — the caller's claim
  stands, which is why the doctor warns on `insecureOpen`.

- The web console is safe to expose only with `channels.web.token` set; the adapter
  refuses to bind a non-loopback address without one.
- `exec` runs in Docker when configured; `code_session` and Pi builds run on the
  host today (tracked as an open finding — a sandbox, not a patch).
- Personal data (email/calendar sender lists, tokens) lives only in gitignored
  config and `.env`; the email path is read-only by construction (no send tool exists).
