/**
 * Process-wide inference abort. When Invarail shuts down, every in-flight
 * request to every inference backend must be torn down — a killed process that
 * leaves generations/embeds running server-side orphans queue slots and wedges
 * the upstream for the NEXT boot (2026-08-16: orphaned embeds held the
 * gateway's embed route; every fresh dispatch queued behind ghosts).
 *
 * Both clients merge this signal into every fetch. SIGINT/SIGTERM trigger it;
 * kill -9 cannot (nothing can run), so prefer graceful stops.
 */

let controller = new AbortController();

/** The current process-wide inference signal — merge into every request. */
export function inferenceAbortSignal(): AbortSignal {
  return controller.signal;
}

/** Abort every in-flight inference request. Idempotent. */
export function abortAllInference(reason = 'shutdown'): void {
  if (!controller.signal.aborted) {
    controller.abort(new Error(`inference aborted: ${reason}`));
    console.log(`[Inference] Abort signal sent to all in-flight requests (${reason})`);
  }
}

/** Re-arm after an abort (tests / hot-restart scenarios). */
export function resetInferenceAbort(): void {
  if (controller.signal.aborted) controller = new AbortController();
}
