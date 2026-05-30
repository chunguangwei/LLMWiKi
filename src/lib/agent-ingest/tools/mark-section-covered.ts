/**
 * Tool: `mark_section_covered` — declare a chunk processed.
 *
 * The agent calls this after it has extracted everything it intends
 * to extract from a given chunk. The runner records the (chunk_id,
 * covered_by) tuple in the coverage tracker, which feeds:
 *
 *   - The `coverage_percent` returned to the user at end-of-run
 *     (visual completion indicator only — the loop exits on `done`,
 *     budget, or abort, never on coverage threshold).
 *   - The verify pass: chunks that were NEVER marked covered become
 *     candidate gaps. Verify cross-checks against the source outline
 *     to avoid false positives (chunks that are boilerplate / refs
 *     / TOCs).
 *
 * Validation:
 *
 *   - chunk_id must exist in ctx.chunks — a hallucinated id is a
 *     no-op AND surfaces back to the LLM as chunk_not_found, same
 *     shape read_chunk returns, so the model can self-correct
 *     using the same machinery.
 *   - covered_by is an array of wiki slugs the agent wrote/updated
 *     for this chunk. EMPTY is valid: "I read this chunk and there
 *     was nothing worth extracting" — that still counts toward
 *     coverage. The semantic difference between [] and not calling
 *     mark_section_covered at all is "I deliberately reviewed and
 *     skipped" vs "I haven't gotten to it yet".
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface MarkSectionCoveredInput {
  chunk_id: string
  /** Slugs of wiki pages the agent wrote or updated for this chunk.
   *  Empty array means "deliberately skipped — nothing worth a page". */
  covered_by: string[]
}

export type MarkSectionCoveredResult =
  | {
      ok: true
      chunk_id: string
      page_count: number
      /** Set when one or more covered_by entries weren't valid slug
       *  strings and were dropped. Lets the LLM notice + self-correct
       *  on the next turn (e.g. it emitted `null` in the array). */
      dropped_count?: number
      dropped_warning?: string
    }
  | { error: "chunk_not_found"; detail: string }
  | { error: "invalid_input"; detail: string }

export const markSectionCoveredTool: ToolDefinition<
  MarkSectionCoveredInput,
  MarkSectionCoveredResult
> = {
  name: "mark_section_covered",
  description:
    "Declare a source chunk processed. Pass the chunk_id you've " +
    "finished reading and an array of wiki slugs you wrote or updated " +
    "for it (covered_by). Empty covered_by is valid and means " +
    "'deliberately reviewed, nothing worth extracting'. Without this " +
    "call the verify pass will treat the chunk as a gap. Coverage " +
    "feeds the run's completion indicator and the ≥85% early-exit.",
  inputSchema: {
    type: "object",
    properties: {
      chunk_id: {
        type: "string",
        description: "The chunk_id returned by read_outline or search_source.",
        minLength: 1,
      },
      covered_by: {
        type: "array",
        description:
          "Wiki page slugs that capture this chunk's content. May be " +
          "empty if the chunk was reviewed but didn't warrant a page.",
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["chunk_id", "covered_by"],
    additionalProperties: false,
  },
  async execute(
    input: MarkSectionCoveredInput,
    ctx: AgentContext,
  ): Promise<MarkSectionCoveredResult> {
    if (ctx.signal.aborted) {
      throw new Error("mark_section_covered aborted by signal")
    }
    if (typeof input?.chunk_id !== "string" || input.chunk_id.length === 0) {
      return { error: "invalid_input", detail: "chunk_id must be a non-empty string" }
    }
    if (!Array.isArray(input.covered_by)) {
      return { error: "invalid_input", detail: "covered_by must be an array of strings" }
    }
    // Per-item validation: slug strings only. We DROP non-strings
    // rather than rejecting the whole call, because losing one
    // wiki slug to a sentinel value (LLM emitted `null` in the
    // array) shouldn't block the chunk from being marked covered.
    // BUT we surface the drop count back to the LLM so it can
    // notice and self-correct on the next turn — silently swallowing
    // its mistakes was the old behaviour and made bad slugs
    // invisible.
    const slugs: string[] = []
    let droppedCount = 0
    for (const s of input.covered_by) {
      if (typeof s === "string" && s.length > 0) slugs.push(s)
      else droppedCount += 1
    }
    if (droppedCount > 0) {
      console.warn(
        `[mark_section_covered] dropped ${droppedCount} non-string covered_by entries for chunk ${input.chunk_id}`,
      )
    }

    if (!ctx.chunks.has(input.chunk_id)) {
      const known = Array.from(ctx.chunks.keys()).slice(0, 5).join(", ")
      return {
        error: "chunk_not_found",
        detail:
          `No chunk with id "${input.chunk_id}". ` +
          (known
            ? `Try one of: ${known}${ctx.chunks.size > 5 ? ", ..." : ""}.`
            : "The source has no chunks indexed."),
      }
    }
    ctx.tracker.markCovered(input.chunk_id, slugs)
    return {
      ok: true,
      chunk_id: input.chunk_id,
      page_count: slugs.length,
      ...(droppedCount > 0
        ? {
            dropped_count: droppedCount,
            dropped_warning:
              `${droppedCount} entries in covered_by were not non-empty strings and ` +
              "were dropped. The chunk is still marked covered; re-call with valid " +
              "slugs if those entries were meant to be real wiki pages.",
          }
        : {}),
    }
  },
}
