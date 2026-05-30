import { describe, it, expect } from "vitest"
import { surfaceGapTool, type SurfaceGapResult } from "./surface-gap"
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
]

describe("surface_gap — contract", () => {
  it("declares input schema with required topic + reason", () => {
    expect(surfaceGapTool.name).toBe("surface_gap")
    const s = surfaceGapTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["topic", "reason"])
    expect(s.properties.topic.minLength).toBe(1)
    expect(s.properties.reason.minLength).toBe(1)
    expect(s.properties.related_chunks.type).toBe("array")
    expect(s.additionalProperties).toBe(false)
  })
})

describe("surface_gap — happy path", () => {
  it("records topic + reason on the tracker", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await surfaceGapTool.execute(
      {
        topic: "Q3 inventory levels",
        reason: "Only mentioned in passing — no quantitative detail",
      },
      ctx,
    )) as Extract<SurfaceGapResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.topic).toBe("Q3 inventory levels")
    expect(r.recorded_chunks).toBe(0)
    expect(tracker.gaps()).toEqual([
      {
        topic: "Q3 inventory levels",
        reason: "Only mentioned in passing — no quantitative detail",
      },
    ])
  })

  it("records valid related_chunks and reports the count", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await surfaceGapTool.execute(
      {
        topic: "GDPR compliance",
        reason: "Out of scope vs purpose.md (regulatory)",
        related_chunks: ["c0", "c1"],
      },
      ctx,
    )) as Extract<SurfaceGapResult, { ok: true }>
    expect(r.recorded_chunks).toBe(2)
    expect(tracker.gaps()[0].chunks).toEqual(["c0", "c1"])
  })

  it("silently drops unknown chunk_ids from related_chunks", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    const r = (await surfaceGapTool.execute(
      {
        topic: "X",
        reason: "Y",
        related_chunks: ["c0", "ghost", "c1", "phantom"],
      },
      ctx,
    )) as Extract<SurfaceGapResult, { ok: true }>
    expect(r.recorded_chunks).toBe(2)
    expect(tracker.gaps()[0].chunks).toEqual(["c0", "c1"])
  })

  it("silently drops non-string / empty entries in related_chunks", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS })
    const r = (await surfaceGapTool.execute(
      {
        topic: "X",
        reason: "Y",
        related_chunks: ["c0", "", null as unknown as string, "c1"],
      },
      ctx,
    )) as Extract<SurfaceGapResult, { ok: true }>
    expect(r.recorded_chunks).toBe(2)
  })

  it("trims topic + reason before recording", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    await surfaceGapTool.execute(
      { topic: "  X  ", reason: "  Y  " },
      ctx,
    )
    expect(tracker.gaps()[0]).toEqual({ topic: "X", reason: "Y" })
  })

  it("omits chunks field from the tracker entry when none are valid", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    await surfaceGapTool.execute(
      {
        topic: "T",
        reason: "R",
        related_chunks: ["ghost-only"],
      },
      ctx,
    )
    const g = tracker.gaps()[0]
    expect("chunks" in g).toBe(false)
  })

  it("each call records a separate gap (not deduplicated)", async () => {
    // Dedup is a Phase B / verify-pass concern; the tool records
    // every call so the user sees the agent's full reasoning trace.
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    await surfaceGapTool.execute({ topic: "A", reason: "r1" }, ctx)
    await surfaceGapTool.execute({ topic: "A", reason: "r1" }, ctx)
    expect(tracker.gaps()).toHaveLength(2)
  })
})

describe("surface_gap — error paths", () => {
  it("returns invalid_input for empty / whitespace topic", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    for (const topic of ["", "  ", "\n\t"]) {
      const r = (await surfaceGapTool.execute(
        { topic, reason: "y" },
        ctx,
      )) as Extract<SurfaceGapResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
    }
    expect(tracker.gaps()).toHaveLength(0)
  })

  it("returns invalid_input for empty / whitespace reason", async () => {
    const { ctx, tracker } = mockCtx({ chunks: CHUNKS })
    for (const reason of ["", "  ", "\n\t"]) {
      const r = (await surfaceGapTool.execute(
        { topic: "x", reason },
        ctx,
      )) as Extract<SurfaceGapResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
    }
    expect(tracker.gaps()).toHaveLength(0)
  })

  it("returns invalid_input for non-string topic", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS })
    const r = (await surfaceGapTool.execute(
      { topic: 42 as unknown as string, reason: "y" },
      ctx,
    )) as Extract<SurfaceGapResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("throws when the agent's signal has been aborted", async () => {
    const { ctx } = mockCtx({ chunks: CHUNKS, aborted: true })
    await expect(
      surfaceGapTool.execute({ topic: "t", reason: "r" }, ctx),
    ).rejects.toThrow(/aborted/i)
  })
})
