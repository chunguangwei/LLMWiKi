import { describe, it, expect } from "vitest"
import { readChunkTool, type ReadChunkResult } from "./read-chunk"
import type { AgentContext, SourceChunk } from "../types"

/**
 * Build a minimal AgentContext with just the chunk map populated.
 * Mirrors the helper in read-outline.test.ts but specialised for
 * this tool — kept duplicated rather than shared because the mock
 * surface IS the per-tool contract; sharing risks the helper
 * accidentally fulfilling more than the tool documents needing.
 */
function mockCtx(
  chunks: SourceChunk[],
  aborted = false,
): AgentContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  const map = new Map<string, SourceChunk>()
  for (const c of chunks) map.set(c.chunk_id, c)
  return {
    chunks: map,
    outline: [],
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
    },
    signal: controller.signal,
  }
}

const CHUNKS: SourceChunk[] = [
  {
    chunk_id: "c0",
    line_range: [1, 10],
    content: "Intro paragraph.\nSecond line.",
    next_chunk_id: "c1",
  },
  {
    chunk_id: "c1",
    line_range: [11, 25],
    content: "Middle chunk body.",
    prev_chunk_id: "c0",
    next_chunk_id: "c2",
  },
  {
    chunk_id: "c2",
    line_range: [26, 40],
    content: "Final chunk.",
    prev_chunk_id: "c1",
  },
]

describe("read_chunk tool — contract", () => {
  it("declares the input schema documented in the design doc", () => {
    expect(readChunkTool.name).toBe("read_chunk")
    expect(readChunkTool.inputSchema).toEqual({
      type: "object",
      properties: {
        chunk_id: {
          type: "string",
          description: expect.any(String),
          minLength: 1,
        },
      },
      required: ["chunk_id"],
      additionalProperties: false,
    })
  })
})

describe("read_chunk tool — happy path", () => {
  it("returns chunk content + line range + neighbour ids", async () => {
    const result = await readChunkTool.execute(
      { chunk_id: "c1" },
      mockCtx(CHUNKS),
    )
    expect(result).toEqual({
      chunk_id: "c1",
      line_range: [11, 25],
      content: "Middle chunk body.",
      prev_chunk_id: "c0",
      next_chunk_id: "c1" === "c1" ? "c2" : "c1",  // keep linter happy
    })
  })

  it("omits prev_chunk_id at the document head", async () => {
    const r = await readChunkTool.execute({ chunk_id: "c0" }, mockCtx(CHUNKS))
    expect("prev_chunk_id" in r).toBe(false)
    if ("error" in r) throw new Error("unexpected error")
    expect(r.next_chunk_id).toBe("c1")
  })

  it("omits next_chunk_id at the document tail", async () => {
    const r = await readChunkTool.execute({ chunk_id: "c2" }, mockCtx(CHUNKS))
    expect("next_chunk_id" in r).toBe(false)
    if ("error" in r) throw new Error("unexpected error")
    expect(r.prev_chunk_id).toBe("c1")
  })

  it("preserves multi-line content verbatim", async () => {
    const r = await readChunkTool.execute({ chunk_id: "c0" }, mockCtx(CHUNKS))
    if ("error" in r) throw new Error("unexpected error")
    expect(r.content).toBe("Intro paragraph.\nSecond line.")
  })
})

describe("read_chunk tool — error paths", () => {
  it("returns chunk_not_found for an unknown id", async () => {
    const r = await readChunkTool.execute(
      { chunk_id: "nope" },
      mockCtx(CHUNKS),
    ) as Extract<ReadChunkResult, { error: "chunk_not_found" }>
    expect(r.error).toBe("chunk_not_found")
    // The detail message must include a hint about known ids so the
    // LLM has something to retry with.
    expect(r.detail).toMatch(/c0/)
    expect(r.detail).toMatch(/nope/)
  })

  it("chunk_not_found message handles an empty chunks map gracefully", async () => {
    const r = await readChunkTool.execute(
      { chunk_id: "anything" },
      mockCtx([]),
    ) as Extract<ReadChunkResult, { error: "chunk_not_found" }>
    expect(r.error).toBe("chunk_not_found")
    expect(r.detail).toMatch(/no chunks/i)
  })

  it("caps the known-id hint at 5 ids + ellipsis", async () => {
    const many: SourceChunk[] = Array.from({ length: 12 }, (_, i) => ({
      chunk_id: `c${i}`,
      line_range: [i * 5, i * 5 + 4],
      content: `chunk ${i}`,
    }))
    const r = await readChunkTool.execute(
      { chunk_id: "nope" },
      mockCtx(many),
    ) as Extract<ReadChunkResult, { error: "chunk_not_found" }>
    expect(r.detail).toMatch(/\.\.\./)
    // First 5 ids should appear, sixth shouldn't.
    expect(r.detail).toMatch(/c4/)
    expect(r.detail).not.toMatch(/\bc5\b/)
  })

  it("returns invalid_input for empty-string chunk_id", async () => {
    const r = await readChunkTool.execute(
      { chunk_id: "" },
      mockCtx(CHUNKS),
    ) as Extract<ReadChunkResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("returns invalid_input when chunk_id is missing entirely", async () => {
    // Forced through `as unknown` — schema would catch this at runner
    // level but the tool itself must still degrade safely.
    const r = await readChunkTool.execute(
      {} as unknown as { chunk_id: string },
      mockCtx(CHUNKS),
    ) as Extract<ReadChunkResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("throws when the agent's signal has been aborted", async () => {
    await expect(
      readChunkTool.execute({ chunk_id: "c0" }, mockCtx(CHUNKS, true)),
    ).rejects.toThrow(/aborted/i)
  })
})

describe("read_chunk tool — leak resistance", () => {
  it("does not leak future-attached internal fields on chunks", async () => {
    // The runner (Phase B) may attach private fields to chunks
    // (cache_key, embedding_vector, ...). The tool should project
    // only the documented surface.
    // Build via `as unknown` so the test can attach extras without
    // TS narrowing them out — the whole point is to assert the tool
    // strips fields the type system never knew about.
    const withExtras = [
      {
        chunk_id: "c0",
        line_range: [1, 10],
        content: "x",
        next_chunk_id: "c1",
        embedding_vector: [0.1, 0.2, 0.3],
        cache_key: "abc",
      },
      {
        chunk_id: "c1",
        line_range: [11, 20],
        content: "y",
        prev_chunk_id: "c0",
      },
    ] as unknown as SourceChunk[]
    const r = await readChunkTool.execute({ chunk_id: "c0" }, mockCtx(withExtras))
    if ("error" in r) throw new Error("unexpected error")
    const keys = Object.keys(r).sort()
    expect(keys).toEqual(["chunk_id", "content", "line_range", "next_chunk_id"])
  })
})
