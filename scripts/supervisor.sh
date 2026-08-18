#!/usr/bin/env bash
# Invarail supervisor — deliberately DUMB. No model anywhere near this file.
# Run this in tmux instead of `npx tsx src/index.ts`. It: runs the app, and on
# exit 42 (deploy restart requested by a confirmed self-mod merge) validates the
# deploy marker, re-runs the gates in the merged tree, restarts, health-checks,
# and auto-rolls-back to the pre-merge SHA on failure. Exit 0 = intentional stop.
# Protected path (Tier 3): changes to this file always require owner confirm and
# only take effect on the next manual supervisor start (we exec a tmp copy).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Re-exec from a tmp copy: bash reads scripts incrementally, so a merge that
# rewrites this file mid-flight would corrupt the running interpreter state.
if [ -z "${SUPERVISOR_COPY:-}" ]; then
  TMP="$(mktemp "${TMPDIR:-/tmp}/invarail-supervisor.XXXXXX")"
  cp "$REPO/scripts/supervisor.sh" "$TMP" && chmod +x "$TMP"
  SUPERVISOR_COPY=1 SUPERVISOR_REPO="$REPO" exec "$TMP"
fi
REPO="${SUPERVISOR_REPO:-$REPO}"
cd "$REPO" || exit 1

PORT="${INVARAIL_PORT:-3100}"
MARKER="$REPO/data/self-mod/deploy.json"
FAILED="$REPO/data/self-mod/FAILED"
CHILD=""

log() { echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S')] $*"; }
marker_field() { node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('$MARKER','utf8')).$1||''))}catch(e){}"; }
rollback() { log "ROLLBACK: git reset --hard ${1:0:8}"; git reset --hard "$1"; }
gates_ok() { log "gates: tsc + vitest"; npx tsc --noEmit && npx vitest run; }

health_ok() {
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && return 0
    kill -0 "$CHILD" 2>/dev/null || return 1   # child died — definitely unhealthy
    sleep 2
  done
  # No HTTP after 60s but the child is alive: web channel may be disabled —
  # process-alive is the (weak) fallback signal.
  kill -0 "$CHILD" 2>/dev/null && { log "no /health but child alive — treating as healthy"; return 0; }
  return 1
}

trap '[ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null; exit 0' INT TERM

ROLLBACK_SHA=""   # non-empty = current boot is a deploy attempt; health failure rolls back
CRASHES=0
WINDOW_START=$(date +%s)

while true; do
  npx tsx src/index.ts & CHILD=$!
  if ! health_ok; then
    log "health check FAILED"
    kill "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null
    if [ -n "$ROLLBACK_SHA" ]; then
      rollback "$ROLLBACK_SHA"; ROLLBACK_SHA=""
      continue                                  # boot the rolled-back tree once
    fi
    date > "$FAILED"; log "unhealthy with no rollback available — stopping LOUD ($FAILED)"; exit 1
  fi
  ROLLBACK_SHA=""                               # healthy boot ends deploy mode
  wait "$CHILD"; CODE=$?

  case "$CODE" in
    0)
      log "clean exit — stopping"; exit 0 ;;
    42)
      log "deploy restart requested"
      PREV="$(marker_field prevSha)"; MERGE="$(marker_field mergeSha)"; HEAD="$(git rev-parse HEAD)"
      rm -f "$MARKER"
      if [ -z "$PREV" ] || [ "$MERGE" != "$HEAD" ]; then
        log "marker missing/stale (merge=$MERGE head=$HEAD) — plain restart"; continue
      fi
      if ! git diff --quiet "$PREV" HEAD -- package-lock.json 2>/dev/null; then
        log "lockfile changed — npm ci"
        npm ci --no-audit --no-fund || { rollback "$PREV"; continue; }
      fi
      gates_ok || { rollback "$PREV"; continue; }
      ROLLBACK_SHA="$PREV"                      # next boot health-checks with rollback armed
      ;;
    *)
      NOW=$(date +%s)
      if [ $((NOW - WINDOW_START)) -gt 300 ]; then CRASHES=0; WINDOW_START=$NOW; fi
      CRASHES=$((CRASHES + 1))
      if [ "$CRASHES" -ge 3 ]; then
        date > "$FAILED"; log "crash loop (3 in 5min) — stopping LOUD ($FAILED)"; exit 1
      fi
      log "crash (exit $CODE) — restarting in $((CRASHES * 5))s"; sleep $((CRASHES * 5))
      ;;
  esac
done
