# SearXNG with Invarail — read before you run it

SearXNG is a self-hosted **metasearch proxy**: it has no index of its own. Every query
Invarail sends it is forwarded to Google, Bing, DuckDuckGo, Brave and the rest, **from
your IP address**, and the results are merged. That is why it needs no API key. It is
also why it can get you flagged.

## The reputation model, plainly

Search engines classify callers by behavior. A human types a query every minute or
two. An agent researching a topic sends a burst: five discovery queries, one per facet,
a retry per empty facet, then cross-checks. From the engine's side that burst comes
from one residential IP with no browser fingerprint, which is exactly what a scraper
looks like. The engine's response is a CAPTCHA page (which SearXNG cannot solve, so
that engine returns nothing), a temporary block, or an entry on a shared bad-IP list
that outlives the incident.

The bill lands on the **host's IP**, not on SearXNG and not on Invarail. SearXNG's own
protections point inward: its limiter blocks bots hitting *your instance*, and its
engine suspensions stop it from re-hitting an engine that has already flagged you.
Neither one paces outbound traffic. Invarail owns that.

This is not hypothetical. Two days of evaluation and research traffic through a
SearXNG box earned this project a DuckDuckGo CAPTCHA flag and Brave and Wikidata
suspensions (DECISIONS.md, "Zero Evidence In, Confident Report Out", August 2026).

## What Invarail does about it

- **Rate:** one outbound query per 1.5 seconds per provider, serialized. Concurrent
  research facets queue instead of bursting. (`src/tools/web-search.ts`)
- **Volume:** `tools.web.search.dailyQueryCeiling` — a hard daily cap, refused with an
  honest message once reached, reset at local midnight. The wizard writes 250. A config
  without the key is unlimited, so set it. `npm run doctor` shows the pace, the
  worst-case queries one research run can spend, and the ceiling.
- **Cache:** identical queries within 15 minutes never leave the box.
- **Local first:** the personal web index (`localIndex`) is tried before any search
  engine; healthy facets never hit a SERP at all.

## What you should do

1. **Use the suggested profile.** `searxng/settings.yml` is mounted by
   `docker compose up -d searxng`. It turns the JSON API on (Invarail needs it), keeps
   a modest engine set (Google is left out on purpose: it flags fastest), disables
   autocomplete, and keeps SearXNG's engine-suspension defaults. It is a suggestion,
   grounded in the documented settings, not a tuned production profile.
2. **Set a real secret.** Replace `secret_key: "REPLACE-ME"` (`openssl rand -hex 32`).
   The wizard does this when it starts the container.
3. **Keep it private.** Bind it to this machine. Do not point browsers, other agents,
   or friends at it. If you expose it, enable `server.limiter` with a Valkey database.
4. **Set the ceiling.** 250/day is generous for one person. Lower it if the box's IP is
   shared with people who need those engines to keep working.
5. **Watch for flags.** Symptoms: a research run reporting "search is down", facets
   coming back empty, an engine that used to answer going silent. Check the instance's
   stats page (`/stats`) for engine error counts, and `docker compose logs searxng` for
   suspension messages. If flagged: stop, wait a day, do not retry in a loop.

## If you would rather not spend your IP

- **A hosted provider** (`provider: brave | perplexity | grok | tavily`) spends *their*
  reputation and rate-limits you honestly with a 429. Brave's free tier is enough for
  ad-hoc use; the same throttle applies.
- **The personal web index** never touches a search engine: curate 50 to 200 sources
  you actually read, and research gathers from those first.
- **A separate IP** for the SearXNG container (a cheap VPS, or a VPN egress) moves the
  reputation cost off your home connection.

Nothing here is specific to Invarail. Any agent pointed at a metasearch proxy has the
same problem; most just have not noticed yet.
