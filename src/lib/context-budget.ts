/**
 * Pure budget allocator for chat context assembly.
 *
 * Given an LLM's `maxContextSize` (in TOKENS — it holds each model's real
 * context window, e.g. 200000 for Claude, 64000 for DeepSeek; the LLM
 * presets' `suggestedContextSize` values ARE token windows), compute the
 * per-section TOKEN budgets used by chat-panel when packing the prompt.
 * Callers measure text with `estimateTokens` / trim with
 * `trimToTokenBudget` (see token-estimate.ts) rather than raw `.length`.
 *
 * Why this is its own module:
 *   - The math has corner cases that deserve their own tests
 *     (tiny configs, huge configs, the legacy 30K cap removal).
 *   - Inlining it in chat-panel.tsx made it untestable in isolation.
 *
 * The shape of the budget:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              maxCtx (100%)                          │
 *   ├──────┬───────────────┬──────────────────┬───────────┤
 *   │ idx  │   pages       │  history + sys   │  resp     │
 *   │  5%  │    50%        │    ~30%          │   15%     │
 *   └──────┴───────────────┴──────────────────┴───────────┘
 *
 * `historyAndSystem` isn't returned because it's not enforced as a
 * single budget — system prompt is roughly fixed-size, and history
 * is gated by `maxHistoryMessages` (count, not bytes). The leftover
 * just provides headroom.
 *
 * The response reserve is a "passive" reservation: we don't pass
 * `max_tokens: responseReserve / 3` to the LLM (yet — that's a
 * follow-up). We just refuse to fill above (maxCtx - responseReserve)
 * so the LLM has room to actually answer.
 */

/** Result of `computeContextBudget`. All values are TOKEN counts. */
export interface ContextBudget {
  /** The model's full context window in tokens (always populated; falls
   *  back to a sensible default when caller passes 0/undefined). */
  maxCtx: number
  /** Tokens NOT to be filled with prompt content — left empty so the LLM
   *  has room to write its response. */
  responseReserve: number
  /** Wiki index summary budget. ~5% — enough to list every page's
   *  title without occupying serious budget. */
  indexBudget: number
  /** Total tokens available for retrieved wiki page content. */
  pageBudget: number
  /** Per-page truncation cap in tokens. A single page won't be embedded
   *  longer than this even if `pageBudget` would allow it. Scales with
   *  pageBudget. */
  maxPageSize: number
}

const DEFAULT_MAX_CTX = 204_800
const RESPONSE_RESERVE_FRAC = 0.15
const INDEX_BUDGET_FRAC = 0.05
const PAGE_BUDGET_FRAC = 0.5
const PER_PAGE_FRAC = 0.3
// Per-page floor in TOKENS (was 5,000 chars). ~1,500 tokens ≈ a short page
// of either script, so a tiny-context config still fits one page.
const PER_PAGE_FLOOR = 1_500

/**
 * Compute TOKEN budgets from the LLM's max context window (also tokens).
 *
 * Falsy `maxContextSize` (0 / NaN / undefined) falls back to a 200K-token
 * default so existing configs don't break.
 */
export function computeContextBudget(
  maxContextSize: number | undefined,
): ContextBudget {
  const maxCtx =
    typeof maxContextSize === "number" && maxContextSize > 0
      ? maxContextSize
      : DEFAULT_MAX_CTX

  const responseReserve = Math.floor(maxCtx * RESPONSE_RESERVE_FRAC)
  const indexBudget = Math.floor(maxCtx * INDEX_BUDGET_FRAC)
  const pageBudget = Math.floor(maxCtx * PAGE_BUDGET_FRAC)

  // Per-page cap rules:
  //   - At minimum, allow PER_PAGE_FLOOR (1.5K tokens) so a small config
  //     still fits one short page.
  //   - At maximum, never exceed pageBudget itself — for tiny configs
  //     where pageBudget < the floor, the floor would otherwise allow a
  //     single page bigger than the entire page budget, which then
  //     gets entirely rejected by tryAddPage in chat-panel.
  //   - Otherwise scale linearly with pageBudget at PER_PAGE_FRAC (30%).
  const maxPageSize = Math.min(
    pageBudget,
    Math.max(PER_PAGE_FLOOR, Math.floor(pageBudget * PER_PAGE_FRAC)),
  )

  return {
    maxCtx,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
  }
}
