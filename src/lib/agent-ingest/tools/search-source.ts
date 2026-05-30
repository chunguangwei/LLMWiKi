/**
 * Tool: `search_source` — find source chunks relevant to a query.
 *
 * Thin wrapper around `ctx.vectorIndex.search(query, top_k)`. The
 * underlying index is built once during pre-process (Phase B) using
 * the existing embedding / LanceDB infrastructure; this tool just
 * shapes the result for the LLM:
 *
 *   - For each (chunk_id, score) hit, look up the chunk to attach
 *     its line_range and a content preview (first 200 chars), so
 *     the agent can decide whether to read_chunk in full without
 *     a second round trip.
 *   - Silently drops hits whose chunk_id isn't in ctx.chunks — that
 *     shouldn't happen if pre-process is correct, but defending
 *     against a stale-index race is cheap.
 *   - Caps top_k at 20 (LLM context budget consideration). The
 *     default of 5 matches the design doc.
 *
 * Mixing in keyword / BM25 alongside vector search is an
 * implementation detail of vectorIndex.search() — Phase B decides
 * the actual hybrid strategy. This tool is provider-agnostic.
 *
 * Error contract:
 *
 *   - invalid_input when query is empty or non-string. The LLM
 *     occasionally produces tool_use blocks with `query: ""`
 *     while it's "thinking out loud"; we'd rather flag that than
 *     run an empty search.
 *   - Per-hit failures (chunk not found, preview generation errors)
 *     are absorbed silently so a partial result still flows back.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface SearchSourceInput {
  query: string
  /** Number of results to return. Defaults to 5, capped at 20. */
  top_k?: number
}

export interface SearchSourceHit {
  chunk_id: string
  /** Provider-dependent — higher means more relevant. The agent
   *  should treat this as ordinal, not absolute (don't compare
   *  across queries). */
  score: number
  line_range: [number, number]
  /** First 200 chars of the chunk's content, single-spaced, no
   *  leading/trailing whitespace. Truncation is byte-naive — the
   *  agent can call read_chunk for the full text. */
  preview: string
}

export type SearchSourceResult =
  | { chunks: SearchSourceHit[] }
  | { error: "invalid_input"; detail: string }

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 20
const PREVIEW_CHARS = 200

export const searchSourceTool: ToolDefinition<SearchSourceInput, SearchSourceResult> = {
  name: "search_source",
  description:
    "Hybrid text + vector search over the source document's chunks. " +
    "Returns up to top_k (default 5, max 20) chunks ranked by combined " +
    "relevance score, each with its chunk_id, line range, and a 200-char " +
    "preview. Use this to find sections relevant to a concept or entity " +
    "you're working on, then read_chunk for the full text. Search is " +
    "issued against the pre-indexed source — the index doesn't update " +
    "during the agent loop, so the same query returns the same results " +
    "each turn (use that for self-correction loops).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text query. Specific concept names / entity references " +
          "/ section topics work best. Don't include surrounding prose.",
        minLength: 1,
      },
      top_k: {
        type: "integer",
        description: `How many hits to return (1-${MAX_TOP_K}, default ${DEFAULT_TOP_K}).`,
        minimum: 1,
        maximum: MAX_TOP_K,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input: SearchSourceInput, ctx: AgentContext): Promise<SearchSourceResult> {
    if (ctx.signal.aborted) {
      throw new Error("search_source aborted by signal")
    }
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return {
        error: "invalid_input",
        detail: "query must be a non-empty string",
      }
    }
    // Clamp top_k. Tolerate non-integer / out-of-range silently
    // (the schema validator catches it upstream; defending here so
    // the tool is safe to call without a validator).
    let topK = typeof input.top_k === "number" && Number.isFinite(input.top_k)
      ? Math.floor(input.top_k)
      : DEFAULT_TOP_K
    if (topK < 1) topK = DEFAULT_TOP_K
    if (topK > MAX_TOP_K) topK = MAX_TOP_K

    const hits = await ctx.vectorIndex.search(input.query.trim(), topK)

    const out: SearchSourceHit[] = []
    for (const hit of hits) {
      const chunk = ctx.chunks.get(hit.chunk_id)
      if (!chunk) continue  // stale index defence
      out.push({
        chunk_id: hit.chunk_id,
        score: hit.score,
        line_range: chunk.line_range,
        preview: makePreview(chunk.content),
      })
    }
    return { chunks: out }
  },
}

function makePreview(content: string): string {
  // Collapse runs of whitespace (including newlines) into single
  // spaces so the preview reads as a continuous excerpt — the LLM
  // doesn't need the original formatting at this resolution.
  const normalised = content.replace(/\s+/g, " ").trim()
  if (normalised.length <= PREVIEW_CHARS) return normalised
  return normalised.slice(0, PREVIEW_CHARS).trimEnd() + "…"
}
