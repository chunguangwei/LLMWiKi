/**
 * Tool: `surface_gap` — record a topic the agent won't extract.
 *
 * Not every concept mentioned in a source deserves a wiki page.
 * The source might allude to "Q3 inventory" in passing without
 * giving enough detail for a stand-alone page; or reference a
 * regulation that's out of scope for the project's purpose.md.
 * Rather than silently dropping those traces, the agent calls
 * surface_gap to record them — they become Review items the user
 * sees at end-of-run and can act on (or dismiss).
 *
 * The tool is the agent's official escape valve for "I see this
 * but I'm choosing not to extract it." Without it, the LLM has
 * three options:
 *
 *   1. Extract anyway → low-quality stub pages pollute the wiki.
 *   2. Silently skip → the user never knows the source mentioned X.
 *   3. surface_gap → the trace survives, the user decides next.
 *
 * Validation:
 *
 *   - topic: required non-empty string. Short and concrete works
 *     best ("Q3 inventory levels", not "the topic of inventory").
 *   - reason: required non-empty string. Explains WHY the agent
 *     didn't extract — "only mentioned in passing", "out of scope
 *     vs purpose.md", "duplicate of [[other-page]]". Surfaces into
 *     the Review item so the user can judge whether to override.
 *   - related_chunks: optional array of chunk_ids the topic appears
 *     in. Unknown ids are silently dropped (cheap defence against
 *     a hallucinated id; the topic itself is what matters).
 *
 * No error path for "wrong" topics — the agent's judgement IS the
 * tool's output; we don't second-guess it.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface SurfaceGapInput {
  topic: string
  reason: string
  related_chunks?: string[]
}

export type SurfaceGapResult =
  | { ok: true; topic: string; recorded_chunks: number }
  | { error: "invalid_input"; detail: string }

export const surfaceGapTool: ToolDefinition<SurfaceGapInput, SurfaceGapResult> = {
  name: "surface_gap",
  description:
    "Record a topic from the source that you SAW but won't extract " +
    "as a wiki page right now (mentioned in passing, out of scope, " +
    "duplicate of an existing page, etc). Becomes a Review item the " +
    "user can act on. Always preferable to silently skipping — the " +
    "user otherwise has no way to know the source mentioned this. " +
    "Topic should be short and concrete; reason should explain why " +
    "you're declining to extract. related_chunks lets you anchor the " +
    "trace; unknown ids are dropped silently.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Short, concrete name for the topic. 'Q3 inventory levels' " +
          "not 'the topic of inventory'.",
        minLength: 1,
      },
      reason: {
        type: "string",
        description:
          "Why you're declining to extract. 'Only mentioned in passing', " +
          "'out of scope vs purpose.md', 'duplicate of [[other-page]]'.",
        minLength: 1,
      },
      related_chunks: {
        type: "array",
        description:
          "chunk_ids where the topic appears. Helps the user find the " +
          "trace if they want to follow up.",
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["topic", "reason"],
    additionalProperties: false,
  },
  async execute(input: SurfaceGapInput, ctx: AgentContext): Promise<SurfaceGapResult> {
    if (ctx.signal.aborted) {
      throw new Error("surface_gap aborted by signal")
    }
    if (typeof input?.topic !== "string" || input.topic.trim().length === 0) {
      return { error: "invalid_input", detail: "topic must be a non-empty string" }
    }
    if (typeof input?.reason !== "string" || input.reason.trim().length === 0) {
      return { error: "invalid_input", detail: "reason must be a non-empty string" }
    }

    // Validate related_chunks lazily — drop unknown ids and
    // non-strings. The topic + reason are the load-bearing fields;
    // chunk anchors are best-effort.
    const validChunks = Array.isArray(input.related_chunks)
      ? input.related_chunks.filter(
          (id): id is string =>
            typeof id === "string" && id.length > 0 && ctx.chunks.has(id),
        )
      : []

    ctx.tracker.surfaceGap(input.topic.trim(), {
      reason: input.reason.trim(),
      ...(validChunks.length > 0 ? { chunks: validChunks } : {}),
    })
    return {
      ok: true,
      topic: input.topic.trim(),
      recorded_chunks: validChunks.length,
    }
  },
}
