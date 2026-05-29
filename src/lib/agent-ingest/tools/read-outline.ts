/**
 * Tool: `read_outline` — return the source's heading tree.
 *
 * Pure read; no side effects. The outline is computed once during
 * pre-process (`runner.ts`, Phase B) and stashed on the agent
 * context — this tool just hands it back to the LLM in the shape
 * documented in `docs/agent-ingest-design.md` §3.1.
 *
 * Why this is the first tool to land:
 *
 *   - Zero state coupling. Reads `ctx.outline` and translates the
 *     shape, no IO, no LLM calls. Good template for the other
 *     read-only tools (read_chunk / list_wiki_pages / read_wiki_page).
 *   - The agent's natural first move is "what does this document
 *     look like?" — without `read_outline` it would have to call
 *     `search_source` blind, which is slower and noisier. Landing
 *     this tool first means the runner E2E test in Phase B has at
 *     least one tool the LLM can call meaningfully.
 *
 * Empty outlines are LEGAL — sources without ATX headings (raw
 * webpage dumps, OCR'd memos) come back as `{ headings: [] }`. The
 * agent loop's system prompt instructs the LLM that an empty
 * outline means "use search_source instead of planning by heading".
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

/** No input. Empty object literal — matches Anthropic / OpenAI
 *  tool-input schema for "takes nothing". Keeping it strict so a
 *  malformed call like `{"query": "..."}` is REJECTED at the JSON-
 *  schema layer instead of silently ignored. */
export interface ReadOutlineInput {
  // Intentionally empty
}

export interface ReadOutlineResult {
  headings: Array<{
    level: number       // 1 = H1, 2 = H2, ..., 6 = H6
    text: string
    line_start: number
    chunk_id: string
  }>
}

export const readOutlineTool: ToolDefinition<ReadOutlineInput, ReadOutlineResult> = {
  name: "read_outline",
  description:
    "Return the heading tree of the source document the agent is processing. " +
    "Each heading carries its ATX level (1-6), text, 1-based starting line, " +
    "and the id of the chunk that contains it. Use this to plan extraction " +
    "order before issuing search_source / read_chunk calls. Headings inside " +
    "code fences and YAML frontmatter are excluded. An empty headings array " +
    "means the source has no structural cues — fall back to search_source.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input: ReadOutlineInput, ctx: AgentContext): Promise<ReadOutlineResult> {
    if (ctx.signal.aborted) {
      throw new Error("read_outline aborted by signal")
    }
    // ctx.outline shape already matches; just project the fields the
    // tool surface promises (drop any private metadata the runner
    // might attach in the future).
    return {
      headings: ctx.outline.map((h) => ({
        level: h.level,
        text: h.text,
        line_start: h.line_start,
        chunk_id: h.chunk_id,
      })),
    }
  },
}
