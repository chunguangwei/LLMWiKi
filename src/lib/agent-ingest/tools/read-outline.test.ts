import { describe, it, expect } from "vitest"
import { readOutlineTool } from "./read-outline"
import type { AgentContext, SourceChunk, OutlineHeading } from "../types"

/**
 * Build a minimal AgentContext with only the fields read_outline
 * touches — keeps the test independent of unrelated context wiring.
 * Phase B's real runner builds a fully-populated AgentContext; tools
 * should never assume more than they document.
 */
function mockCtx(outline: OutlineHeading[], aborted = false): AgentContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    chunks: new Map<string, SourceChunk>(),
    outline,
    vectorIndex: { search: async () => [] },
    project: { id: "test", name: "test", path: "/tmp/test" },
    tracker: {
      markCovered() {},
      markCreated() {},
      markUpdated() {},
      surfaceGap() {},
      markCompleted() {},
      markBudgetExhausted() {},
      coveragePercent: () => 0,
      isComplete: () => false,
      createdPages: () => [],
      updatedPages: () => [],
      gaps: () => [],
      snapshot: () => ({
        sourcePath: "",
        sourceHash: "",
        totalChunks: 0,
        coveredChunks: [],
        pagesCreated: [],
        pagesUpdated: [],
        gaps: [],
        turnsUsed: 0,
        tokensSpent: 0,
        completed: false,
        budgetExhausted: false,
      }),
    },
    llmConfig: {} as AgentContext["llmConfig"],
    wikiAccess: {
      listPages: async () => [],
      readPage: async () => null,
      writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
      deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    },
    signal: controller.signal,
  }
}

describe("read_outline tool", () => {
  it("declares the contract documented in the design doc", () => {
    expect(readOutlineTool.name).toBe("read_outline")
    expect(readOutlineTool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })

  it("returns the outline from context as { headings: [...] }", async () => {
    const outline: OutlineHeading[] = [
      { level: 1, text: "Intro", line_start: 1, chunk_id: "c0" },
      { level: 2, text: "Background", line_start: 5, chunk_id: "c0" },
      { level: 1, text: "Conclusion", line_start: 30, chunk_id: "c2" },
    ]
    const result = await readOutlineTool.execute({}, mockCtx(outline))
    expect(result.headings).toHaveLength(3)
    expect(result.headings[0]).toEqual({
      level: 1,
      text: "Intro",
      line_start: 1,
      chunk_id: "c0",
    })
  })

  it("returns { headings: [] } for an empty outline (no-headings source)", async () => {
    const result = await readOutlineTool.execute({}, mockCtx([]))
    expect(result.headings).toEqual([])
  })

  it("does NOT leak internal fields the runner might attach", async () => {
    // A future runner might extend OutlineHeading with private fields
    // (cache_key, embedding, ...). The tool must project only the
    // documented surface so the LLM doesn't see implementation noise.
    const outline = [
      // Cast through unknown — we're intentionally faking an over-
      // populated heading to verify the tool drops the extra fields.
      {
        level: 1,
        text: "x",
        line_start: 1,
        chunk_id: "c0",
        internal_cache_key: "secret",
      } as unknown as OutlineHeading,
    ]
    const result = await readOutlineTool.execute({}, mockCtx(outline))
    const heading = result.headings[0] as Record<string, unknown>
    expect(heading.internal_cache_key).toBeUndefined()
    expect(Object.keys(heading).sort()).toEqual(
      ["chunk_id", "level", "line_start", "text"],
    )
  })

  it("throws when the agent's signal has been aborted", async () => {
    await expect(
      readOutlineTool.execute({}, mockCtx([], true)),
    ).rejects.toThrow(/aborted/i)
  })
})
