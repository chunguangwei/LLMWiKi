/**
 * Tool: `search_wiki_by_title` — find wiki pages by slug / title fuzzy match.
 *
 * Companion to `list_wiki_pages` (which dumps everything) and
 * `search_source` (which BM25-searches the SOURCE chunks). Lint-fix
 * needs a different shape: given a broken `[[wikilink]]` like
 * `[[neural-net]]`, propose the closest existing page (perhaps
 * `[[neural-network]]` or `[[transformer]]`). Whole-page content
 * search is too noisy for this; the right signal is the slug + title
 * string similarity.
 *
 * Scoring (best to worst, all case-insensitive after normalisation):
 *
 *   1. Exact slug or title match              → score 1.0
 *   2. Substring match (query ⊂ slug | title) → score 0.85
 *   3. Reverse substring (slug | title ⊂ q)   → score 0.7
 *   4. Token overlap (shared word count /
 *      max-word-count of the two strings)     → 0.0–0.6
 *
 * Returns top-N matches with a minimum score cutoff so a query that
 * shares no meaningful tokens doesn't trigger a "yes, this matches"
 * false positive — the LLM is then free to call write_wiki_page
 * instead of forcing a bogus update.
 */
import type { AgentContext, WikiPageSummary } from "../types"
import type { ToolDefinition } from "./index"

export interface SearchWikiByTitleInput {
  query: string
  /** Default 5, max 20. */
  limit?: number
}

export type SearchWikiByTitleResult =
  | {
      ok: true
      query: string
      matches: Array<{
        slug: string
        title: string
        type: string
        score: number
        match_reason: "exact" | "substring" | "reverse_substring" | "token_overlap"
      }>
    }
  | { error: "invalid_input"; detail: string }

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const MIN_SCORE = 0.15

export const searchWikiByTitleTool: ToolDefinition<
  SearchWikiByTitleInput,
  SearchWikiByTitleResult
> = {
  name: "search_wiki_by_title",
  description:
    "Find existing wiki pages whose slug or title resembles `query`. Use " +
    "this when fixing a broken [[wikilink]] to surface candidate replacement " +
    "pages, or to check whether a page on a topic already exists before " +
    "writing a new one. Returns ranked matches with a brief `match_reason` " +
    "explaining the score. Empty matches array means no page is even " +
    "remotely close — that's a real signal, not an error.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The slug or title fragment to search for. Case-insensitive; " +
          "punctuation is ignored.",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: `Max matches to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(
    input: SearchWikiByTitleInput,
    ctx: AgentContext,
  ): Promise<SearchWikiByTitleResult> {
    if (ctx.signal.aborted) {
      throw new Error("search_wiki_by_title aborted by signal")
    }
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return { error: "invalid_input", detail: "query must be a non-empty string" }
    }
    const limit = clampLimit(input.limit)
    const query = input.query.trim()
    const qNorm = normalise(query)
    const qTokens = tokens(qNorm)
    if (qTokens.length === 0) {
      // Pathological input — e.g. all punctuation. Caller's bug to
      // surface, not ours to fix; return no matches without erroring
      // so the LLM can decide what to do next.
      return { ok: true, query, matches: [] }
    }

    const pages = await ctx.wikiAccess.listPages()
    const scored = pages.map((p) => scorePage(qNorm, qTokens, p)).filter(
      (m): m is NonNullable<typeof m> => m !== null && m.score >= MIN_SCORE,
    )
    scored.sort((a, b) => b.score - a.score)

    const matches = scored.slice(0, limit).map((m) => ({
      slug: m.slug,
      title: m.title,
      type: m.type,
      score: round(m.score),
      match_reason: m.match_reason,
    }))
    return { ok: true, query, matches }
  },
}

/* ────────────────────────────────────────────────
 * Scoring
 * ────────────────────────────────────────────────*/

function scorePage(
  qNorm: string,
  qTokens: string[],
  page: WikiPageSummary,
): {
  slug: string
  title: string
  type: string
  score: number
  match_reason: "exact" | "substring" | "reverse_substring" | "token_overlap"
} | null {
  const slugN = normalise(page.slug)
  const titleN = normalise(page.title)

  if (slugN === qNorm || titleN === qNorm) {
    return { slug: page.slug, title: page.title, type: page.type, score: 1.0, match_reason: "exact" }
  }
  if (slugN.includes(qNorm) || titleN.includes(qNorm)) {
    return { slug: page.slug, title: page.title, type: page.type, score: 0.85, match_reason: "substring" }
  }
  if (qNorm.includes(slugN) || qNorm.includes(titleN)) {
    return { slug: page.slug, title: page.title, type: page.type, score: 0.7, match_reason: "reverse_substring" }
  }

  // Token overlap on the better of {slug, title}.
  const slugScore = tokenOverlap(qTokens, tokens(slugN))
  const titleScore = tokenOverlap(qTokens, tokens(titleN))
  const overlap = Math.max(slugScore, titleScore)
  if (overlap <= 0) return null
  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    // Cap the token-overlap branch at 0.6 so a single shared word
    // never out-ranks an honest substring match.
    score: Math.min(0.6, overlap * 0.6),
    match_reason: "token_overlap",
  }
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const set = new Set(b)
  let shared = 0
  for (const tok of a) {
    if (set.has(tok)) shared += 1
  }
  return shared / Math.max(a.length, b.length)
}

/* ────────────────────────────────────────────────
 * Normalisation helpers
 * ────────────────────────────────────────────────*/

/** Lowercase, collapse whitespace, drop most punctuation. CJK left intact. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_/\-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim()
}

function tokens(normalised: string): string[] {
  if (!normalised) return []
  return normalised.split(/\s+/).filter((t) => t.length > 0)
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT
  if (raw < 1) return 1
  if (raw > MAX_LIMIT) return MAX_LIMIT
  return Math.floor(raw)
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
