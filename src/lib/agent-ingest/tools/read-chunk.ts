/**
 * Tool: `read_chunk` — return one source chunk's full text.
 *
 * The agent calls this after `read_outline` (or `search_source`)
 * gives it a chunk_id worth reading in full. Pure read; no IO
 * beyond the in-memory chunk Map; no LLM calls.
 *
 * Why the prev/next_chunk_id surface:
 *
 *   Source chunks tile the document by line range, but the
 *   smart-splitter cuts at semantic boundaries — paragraph ends,
 *   heading transitions — which means a referenced concept can
 *   span a chunk boundary. The agent's natural follow-up to "this
 *   chunk mentions Q3 revenue" is often "what's in the chunk
 *   immediately after". Exposing prev/next as part of the read
 *   result lets the LLM walk neighbours without first asking
 *   read_outline again for the full chunk graph.
 *
 *   The fields are OPTIONAL because chunks at the document
 *   boundaries have no prev/next respectively.
 *
 * Error contract:
 *
 *   An unknown chunk_id returns `{ error: "chunk_not_found", ... }`
 *   rather than throwing. The runner forwards the error verbatim
 *   to the LLM as the tool result. The LLM almost always responds
 *   by calling read_outline / search_source again to get a valid
 *   id — Claude Code's same self-correction pattern. Throwing
 *   would crash the loop on every typo.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface ReadChunkInput {
  chunk_id: string
}

export type ReadChunkResult =
  | {
      chunk_id: string
      line_range: [number, number]
      content: string
      prev_chunk_id?: string
      next_chunk_id?: string
    }
  | {
      error: "chunk_not_found"
      detail: string
    }
  | {
      error: "invalid_input"
      detail: string
    }

export const readChunkTool: ToolDefinition<ReadChunkInput, ReadChunkResult> = {
  name: "read_chunk",
  description:
    "Read the full text of one source chunk by its chunk_id (obtained " +
    "from read_outline or search_source). Returns the chunk content, its " +
    "1-based line range in the source, and the ids of the immediately " +
    "preceding and following chunks (omitted at document boundaries) so " +
    "you can walk neighbours without re-querying. If the chunk_id is " +
    "unknown the result is { error: 'chunk_not_found', detail }; call " +
    "read_outline or search_source to recover a valid id.",
  inputSchema: {
    type: "object",
    properties: {
      chunk_id: {
        type: "string",
        description:
          "Identifier returned by read_outline or search_source. Must be a non-empty string.",
        minLength: 1,
      },
    },
    required: ["chunk_id"],
    additionalProperties: false,
  },
  async execute(input: ReadChunkInput, ctx: AgentContext): Promise<ReadChunkResult> {
    if (ctx.signal.aborted) {
      throw new Error("read_chunk aborted by signal")
    }
    // Defensive: JSON-schema validation lives at the runner layer
    // (Phase B) and may not be present in unit tests / mock runners.
    // Mirror the schema's minLength:1 check here so the tool is
    // safe to call without the runner's schema validator.
    if (typeof input?.chunk_id !== "string" || input.chunk_id.length === 0) {
      return {
        error: "invalid_input",
        detail: "chunk_id must be a non-empty string",
      }
    }
    const chunk = ctx.chunks.get(input.chunk_id)
    if (!chunk) {
      const knownSample = Array.from(ctx.chunks.keys()).slice(0, 5).join(", ")
      return {
        error: "chunk_not_found",
        detail:
          `No chunk with id "${input.chunk_id}". ` +
          (knownSample
            ? `Try one of: ${knownSample}${ctx.chunks.size > 5 ? ", ..." : ""}.`
            : "The source has no chunks indexed."),
      }
    }
    // Project only the documented fields — same defence as read_outline
    // against future runner-attached metadata leaking to the LLM.
    return {
      chunk_id: chunk.chunk_id,
      line_range: chunk.line_range,
      content: chunk.content,
      ...(chunk.prev_chunk_id !== undefined ? { prev_chunk_id: chunk.prev_chunk_id } : {}),
      ...(chunk.next_chunk_id !== undefined ? { next_chunk_id: chunk.next_chunk_id } : {}),
    }
  },
}
