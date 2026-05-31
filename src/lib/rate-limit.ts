/**
 * Shared rate-limit detection + backoff helpers.
 *
 * Two layers use this:
 *
 *   - **postJson** in agent-ingest/agent-llm.ts retries the HTTP call
 *     before propagating, so chat-agent / autoIngest / agent-lint-fix
 *     are all transparently 429-resilient without changing their
 *     loops. This is the FIRST line of defense.
 *
 *   - **bulk-fix** in components/lint/lint-view.tsx wraps the higher
 *     level runLintFix call, catching errors that postJson missed
 *     (tool-execution-time rate-limits, classifier wrappers, etc).
 *
 * Detection over-matches deliberately: providers vary (Anthropic uses
 * `HTTP 429`, OpenAI sometimes `rate_limit_exceeded`, Chinese
 * resellers like Token Plan / SiliconFlow lean on bilingual phrasing).
 * A false positive costs us a couple seconds of unnecessary sleep; a
 * false negative strands the user mid-batch with a fatal error.
 */

/**
 * True when an error / response body indicates rate limiting.
 * Accepts Error, string, or unknown (defensive — the call site
 * shouldn't have to know what shape it has).
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b429\b/.test(msg) ||
    /rate[\s_-]?limit/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /请求量较高|请稍后重试|超过.*?限制|超.*?额度/.test(msg)
  )
}

/**
 * Geometric backoff: 5s, 15s, 30s. Capped at 30s for further attempts
 * so we don't accidentally burn the user's evening on a permanent
 * rate-limit. Most providers reset the bucket on a 5-second cadence,
 * so 30s is "well past it".
 */
export function rateLimitBackoffMs(attempt: number): number {
  switch (attempt) {
    case 1:
      return 5_000
    case 2:
      return 15_000
    default:
      return 30_000
  }
}

/** Default retry budget used by both call sites. */
export const MAX_RATE_LIMIT_RETRIES = 3

/**
 * Sleep for `ms` milliseconds, respecting an abort signal. Polls every
 * 200ms so a cancelled run doesn't sit through a 30s backoff before
 * noticing the user said stop.
 */
export async function sleepRespectingAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (signal?.aborted) return
    await new Promise((r) => setTimeout(r, Math.min(200, ms - (Date.now() - start))))
  }
}
