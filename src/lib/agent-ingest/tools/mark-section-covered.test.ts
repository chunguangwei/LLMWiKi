import { describe, it, expect } from "vitest"
import { markSectionCoveredTool, type MarkSectionCoveredResult } from "./mark-section-covered"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, SourceChunk } from "../types"

function mockCtx(opts: { chunks: SourceChunk[]; aborted?: boolean }) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const chunkMap = new Map<string, SourceChunk>()
  for (const c of opts.chunks) chunkMap.set(c.chunk_id, c)
  const tracker = new InMemoryCoverageTracker(
    "test-source",
    "hash-test",
    opts.chunks.length,
  )
  const ctx: AgentContext = {
    chunks: chunkMap,
    outline: [],
    vectorIndex: { search: async () => [] },
    project: { id: "test", name: "test", path: "/tmp/test" },
    tracker,
    wikiAccess: {
      listPages: async () => [],
      readPage: async () => null,
      writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
    },
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  }
  return { ctx, tracker }
}

const CHUNKS: SourceChunk[] = [
  { chunk_id: "c0", line_range: [1, 10], content: "a" },
  { chunk_id: "c1", line_range: [11, 25], content: "b" },
  { chunk_id: "c2", line_range: [26, 40], content: "c" },
]

describe("mark_section_covered — contract", () => {
  it("declares input schema with required chunk_id + covered_by", () => {
    expect(markSectionCoveredTool.name).toBe("mark_section_covered")
    const s = markSectionCoveredTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["chunk_id", "covered_by"])
    expect(s.properties.chunk_id.minLength).toBe(1)
    expect(s.properties.covered_by.type).toBe("array")
    expect(s.properties.covered_by.items).toEqual({ type: "string", minLength: 1 })
    expect(s.additionalProperties).toBe(false)
  })
})

describe("mark_section_covered — happy path", () => {
  it("records the chunk in the tracker", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await markSectionCoveredTool.execute(
      { chunk_id: "c1", covered_by: ["concepts/foo"] },
      ctx,
    )) as Extract<MarkSectionCoveredResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.page_count).toBe(1)
    expect(tracker.coveragePercent()).toBeCloseTo(1 / 3)
  })

  it("accepts empty covered_by (deliberate skip)", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await markSectionCoveredTool.execute(
      { chunk_id: "c0", covered_by: [] },
      ctx,
    )) as Extract<MarkSectionCoveredResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.page_count).toBe(0)
    expect(tracker.coveragePercent()).toBeCloseTo(1 / 3)
  })

  it("filters non-string / empty entries from covered_by silently", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS })
    const r = (await markSectionCoveredTool.execute(
      {
        chunk_id: "c0",
        covered_by: ["concepts/foo", "", null as unknown as string, "concepts/bar"],
      },
      ctx,
    )) as Extract<MarkSectionCoveredResult, { ok: true }>
    expect(r.page_count).toBe(2)
  })

  it("marking the same chunk twice is idempotent (still 1 covered chunk)", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    await markSectionCoveredTool.execute(
      { chunk_id: "c0", covered_by: ["a"] },
      ctx,
    )
    await markSectionCoveredTool.execute(
      { chunk_id: "c0", covered_by: ["a", "b"] },
      ctx,
    )
    expect(tracker.coveragePercent()).toBeCloseTo(1 / 3)
  })
})

describe("mark_section_covered — error paths", () => {
  it("returns chunk_not_found for unknown id (with known-id hint)", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await markSectionCoveredTool.execute(
      { chunk_id: "ghost", covered_by: ["foo"] },
      ctx,
    )) as Extract<MarkSectionCoveredResult, { error: "chunk_not_found" }>
    expect(r.error).toBe("chunk_not_found")
    expect(r.detail).toMatch(/ghost/)
    expect(r.detail).toMatch(/c0/)
    // Failed call must NOT mutate the tracker.
    expect(tracker.coveragePercent()).toBe(0)
  })

  it("returns invalid_input for non-array covered_by", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS })
    const r = (await markSectionCoveredTool.execute(
      { chunk_id: "c0", covered_by: "not an array" as unknown as string[] },
      ctx,
    )) as Extract<MarkSectionCoveredResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("returns invalid_input for empty / non-string chunk_id", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS })
    for (const id of ["", 42 as unknown as string]) {
      const r = (await markSectionCoveredTool.execute(
        { chunk_id: id, covered_by: [] },
        ctx,
      )) as Extract<MarkSectionCoveredResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
    }
  })

  it("throws when the agent's signal has been aborted", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS, aborted: true })
    await expect(
      markSectionCoveredTool.execute({ chunk_id: "c0", covered_by: [] }, ctx),
    ).rejects.toThrow(/aborted/i)
  })
})
