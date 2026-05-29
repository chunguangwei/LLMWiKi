import { describe, it, expect } from "vitest"
import { searchSourceTool, type SearchSourceResult } from "./search-source"
import type { AgentContext, SourceChunk, VectorIndex } from "../types"

function mockCtx(opts: {
  chunks: SourceChunk[]
  indexHits: Array<{ chunk_id: string; score: number }>
  aborted?: boolean
  /** If set, capture the args every call to vectorIndex.search() was made with. */
  searchCalls?: Array<{ query: string; topK: number }>
}): AgentContext {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const map = new Map<string, SourceChunk>()
  for (const c of opts.chunks) map.set(c.chunk_id, c)
  const vectorIndex: VectorIndex = {
    async search(query, topK) {
      opts.searchCalls?.push({ query, topK })
      return opts.indexHits.slice(0, topK)
    },
  }
  return {
    chunks: map,
    outline: [],
    vectorIndex,
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
    },
    signal: controller.signal,
  }
}

const CHUNKS: SourceChunk[] = [
  {
    chunk_id: "c0",
    line_range: [1, 10],
    content:
      "Q3 revenue 2024.\nThe report covers all business units, with detailed line items per region.",
  },
  {
    chunk_id: "c1",
    line_range: [11, 25],
    content: "A".repeat(500),  // long chunk to test preview truncation
  },
  {
    chunk_id: "c2",
    line_range: [26, 40],
    content: "Short body.",
  },
]

describe("search_source — contract", () => {
  it("declares the input schema documented in the design doc", () => {
    expect(searchSourceTool.name).toBe("search_source")
    const s = searchSourceTool.inputSchema as Record<string, any>
    expect(s.type).toBe("object")
    expect(s.required).toEqual(["query"])
    expect(s.properties.query.minLength).toBe(1)
    expect(s.properties.top_k.minimum).toBe(1)
    expect(s.properties.top_k.maximum).toBe(20)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("search_source — happy path", () => {
  it("returns top-k hits with chunk metadata + preview", async () => {
    const ctx = mockCtx({
      chunks: CHUNKS,
      indexHits: [
        { chunk_id: "c0", score: 0.92 },
        { chunk_id: "c2", score: 0.41 },
      ],
    })
    const r = (await searchSourceTool.execute({ query: "Q3 revenue" }, ctx)) as Extract<
      SearchSourceResult,
      { chunks: unknown }
    >
    expect(r.chunks).toHaveLength(2)
    expect(r.chunks[0]).toEqual({
      chunk_id: "c0",
      score: 0.92,
      line_range: [1, 10],
      // newlines collapsed to single space in the preview
      preview:
        "Q3 revenue 2024. The report covers all business units, with detailed line items per region.",
    })
  })

  it("forwards default top_k=5 when caller omits it", async () => {
    const searchCalls: Array<{ query: string; topK: number }> = []
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [], searchCalls })
    await searchSourceTool.execute({ query: "anything" }, ctx)
    expect(searchCalls[0]).toEqual({ query: "anything", topK: 5 })
  })

  it("respects an explicit top_k value", async () => {
    const searchCalls: Array<{ query: string; topK: number }> = []
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [], searchCalls })
    await searchSourceTool.execute({ query: "anything", top_k: 3 }, ctx)
    expect(searchCalls[0].topK).toBe(3)
  })

  it("caps top_k at the max (20)", async () => {
    const searchCalls: Array<{ query: string; topK: number }> = []
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [], searchCalls })
    await searchSourceTool.execute({ query: "x", top_k: 999 }, ctx)
    expect(searchCalls[0].topK).toBe(20)
  })

  it("trims the query before searching", async () => {
    const searchCalls: Array<{ query: string; topK: number }> = []
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [], searchCalls })
    await searchSourceTool.execute({ query: "  Q3 revenue  " }, ctx)
    expect(searchCalls[0].query).toBe("Q3 revenue")
  })

  it("truncates long previews to 200 chars + ellipsis", async () => {
    const ctx = mockCtx({
      chunks: CHUNKS,
      indexHits: [{ chunk_id: "c1", score: 0.5 }],
    })
    const r = (await searchSourceTool.execute({ query: "x" }, ctx)) as Extract<
      SearchSourceResult,
      { chunks: unknown }
    >
    const preview = r.chunks[0].preview
    // 200 chars of content + ellipsis = 201 chars
    expect(preview.length).toBe(201)
    expect(preview.endsWith("…")).toBe(true)
  })

  it("does NOT truncate when the content is shorter than the cap", async () => {
    const ctx = mockCtx({
      chunks: CHUNKS,
      indexHits: [{ chunk_id: "c2", score: 0.3 }],
    })
    const r = (await searchSourceTool.execute({ query: "x" }, ctx)) as Extract<
      SearchSourceResult,
      { chunks: unknown }
    >
    expect(r.chunks[0].preview).toBe("Short body.")
    expect(r.chunks[0].preview).not.toMatch(/…/)
  })

  it("returns empty chunks array when the index returns nothing", async () => {
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [] })
    const r = (await searchSourceTool.execute({ query: "no match" }, ctx)) as Extract<
      SearchSourceResult,
      { chunks: unknown }
    >
    expect(r.chunks).toEqual([])
  })
})

describe("search_source — defence", () => {
  it("silently drops hits whose chunk_id isn't in ctx.chunks (stale index)", async () => {
    const ctx = mockCtx({
      chunks: CHUNKS,
      indexHits: [
        { chunk_id: "c0", score: 0.9 },
        { chunk_id: "ghost", score: 0.8 },  // index has it; chunks don't
        { chunk_id: "c2", score: 0.5 },
      ],
    })
    const r = (await searchSourceTool.execute({ query: "x" }, ctx)) as Extract<
      SearchSourceResult,
      { chunks: unknown }
    >
    expect(r.chunks.map((c: any) => c.chunk_id)).toEqual(["c0", "c2"])
  })

  it("returns invalid_input for empty / whitespace-only query", async () => {
    for (const q of ["", "   ", "\n\t"]) {
      const ctx = mockCtx({ chunks: CHUNKS, indexHits: [] })
      const r = (await searchSourceTool.execute({ query: q }, ctx)) as Extract<
        SearchSourceResult,
        { error: "invalid_input" }
      >
      expect(r.error).toBe("invalid_input")
    }
  })

  it("returns invalid_input for non-string query (LLM hallucinated shape)", async () => {
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [] })
    const r = (await searchSourceTool.execute(
      { query: 123 as unknown as string },
      ctx,
    )) as Extract<SearchSourceResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("falls back to default top_k for NaN / negative / fractional input", async () => {
    const searchCalls: Array<{ query: string; topK: number }> = []
    const ctx = mockCtx({ chunks: CHUNKS, indexHits: [], searchCalls })
    await searchSourceTool.execute({ query: "x", top_k: NaN }, ctx)
    expect(searchCalls[0].topK).toBe(5)
    await searchSourceTool.execute({ query: "x", top_k: -3 }, ctx)
    expect(searchCalls[1].topK).toBe(5)
    await searchSourceTool.execute({ query: "x", top_k: 7.8 }, ctx)
    expect(searchCalls[2].topK).toBe(7)  // floor
  })

  it("throws when the agent's signal has been aborted", async () => {
    await expect(
      searchSourceTool.execute(
        { query: "x" },
        mockCtx({ chunks: CHUNKS, indexHits: [], aborted: true }),
      ),
    ).rejects.toThrow(/aborted/i)
  })
})
