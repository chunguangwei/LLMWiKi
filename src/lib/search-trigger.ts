/**
 * Detect when a chat input is actually a search command.
 *
 * Three trigger shapes are supported so users with different muscle
 * memory all land in the same place:
 *
 *   1. `/search <query>`         — keyboard-first, command-palette style
 *   2. English NL: `search ...`   — natural-language fallback
 *   3. Chinese NL: `搜索 ...`     — natural-language fallback (CJK)
 *
 * The 🔍 button bypasses detection entirely (the panel calls
 * `runSearch(query)` directly), so we only need to parse free-text
 * messages here.
 *
 * Returned shape: `{ kind: "search", query }` when a search is
 * detected, or `null` when the message should be sent to the model
 * as-is. Keeping detection pure (no side effects, no store reads)
 * makes the chat-panel wiring trivially testable.
 */

const SLASH_PREFIX = /^\/search\s+(.+)$/i
const EN_PREFIX = /^(?:search|find|google)[\s:：](.+)$/i
// Chinese: 搜索 / 搜 / 查询 / 查 / 查找 — all common ways a CJK user
// would phrase "search for X". Trailing colons / spaces are normalized
// to the same single-character boundary.
const ZH_PREFIX = /^(?:搜索|搜|查询|查找|查)[\s:：](.+)$/

export interface SearchTrigger {
  kind: "search"
  query: string
}

/**
 * Returns `{kind: "search", query}` if the message is a recognized
 * search trigger, otherwise null.
 *
 * The query is trimmed but not otherwise sanitized — the caller may
 * want to log / display the original phrasing alongside the search
 * results.
 */
export function detectSearchTrigger(message: string): SearchTrigger | null {
  const trimmed = message.trim()
  if (!trimmed) return null

  for (const re of [SLASH_PREFIX, EN_PREFIX, ZH_PREFIX]) {
    const m = trimmed.match(re)
    if (m) {
      const query = m[1].trim()
      if (query.length === 0) return null
      return { kind: "search", query }
    }
  }

  return null
}

/**
 * True if the text *looks like* it might be a search command — even
 * if the query is empty (e.g. user typed `/search ` and is mid-edit).
 * Used to gate UI hints, not to actually run a search.
 */
export function looksLikeSearchTrigger(message: string): boolean {
  const trimmed = message.trim()
  return (
    /^\/search(?:\s|$)/i.test(trimmed) ||
    /^(?:search|find|google)(?:[\s:：]|$)/i.test(trimmed) ||
    /^(?:搜索|搜|查询|查找|查)(?:[\s:：]|$)/.test(trimmed)
  )
}
