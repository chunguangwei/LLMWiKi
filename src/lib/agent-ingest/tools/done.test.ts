import { describe, it, expect } from "vitest"
import { doneTool, type DoneResult } from "./done"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext } from "../types"

function mockCtx(opts: { totalChunks?: number; aborted?: boolean } = {}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const tracker = new InMemoryCoverageTracker(
    "test-source",
    "h",
    opts.totalChunks ?? 4,
  )
  const ctx: AgentContext = {
    chunks: new Map(),
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
      deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    },
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  }
  return { ctx, tracker }
}

describe("done — contract", () => {
  it("declares schema with required reason", () => {
    expect(doneTool.name).toBe("done")
    const s = doneTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["reason"])
    expect(s.properties.reason.minLength).toBe(1)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("done — happy path", () => {
  it("marks tracker completed + returns digest of final state", async () => {
    const { ctx, tracker } = mockCtx({ totalChunks: 4 })
    tracker.markCovered("c0", ["concepts/a"])
    tracker.markCovered("c1", ["concepts/b"])
    tracker.markCreated("concepts/a", ["c0"])
    tracker.markCreated("concepts/b", ["c1"])
    tracker.markUpdated("concepts/existing", ["c2"])
    tracker.surfaceGap("Topic X", { reason: "passing mention" })

    const r = (await doneTool.execute(
      { reason: "Source fully extracted" },
      ctx,
    )) as Extract<DoneResult, { ok: true }>

    expect(r.ok).toBe(true)
    expect(r.reason).toBe("Source fully extracted")
    expect(r.coverage_percent).toBe(50)  // 2/4 = 50%
    expect(r.created_pages).toBe(2)
    expect(r.updated_pages).toBe(1)
    expect(r.gaps).toBe(1)
    // Tracker actually marked completed (Phase B loop checks this
    // immediately after the done call).
    expect(tracker.isComplete()).toBe(true)
  })

  it("rounds coverage_percent to 2 decimal places", async () => {
    const { ctx, tracker } = mockCtx({ totalChunks: 7 })
    tracker.markCovered("c0", [])
    tracker.markCovered("c1", [])
    tracker.markCovered("c2", [])
    const r = (await doneTool.execute(
      { reason: "good enough" },
      ctx,
    )) as Extract<DoneResult, { ok: true }>
    // 3/7 = 0.428571... → 42.86
    expect(r.coverage_percent).toBe(42.86)
  })

  it("trims the reason before storing + returning", async () => {
    const { ctx, tracker } = mockCtx()
    const r = (await doneTool.execute(
      { reason: "   covered everything   " },
      ctx,
    )) as Extract<DoneResult, { ok: true }>
    expect(r.reason).toBe("covered everything")
    // Tracker stores the trimmed reason (markCompleted with trimmed)
    expect(tracker.isComplete()).toBe(true)
  })

  it("handles zero coverage / empty tracker without crashing", async () => {
    const { ctx } = mockCtx({ totalChunks: 0 })
    const r = (await doneTool.execute(
      { reason: "nothing to extract" },
      ctx,
    )) as Extract<DoneResult, { ok: true }>
    expect(r.coverage_percent).toBe(0)
    expect(r.created_pages).toBe(0)
    expect(r.gaps).toBe(0)
  })
})

describe("done — error paths", () => {
  it("invalid_input for empty / whitespace reason", async () => {
    const { ctx, tracker } = mockCtx()
    for (const reason of ["", "   ", "\n\t"]) {
      const r = (await doneTool.execute(
        { reason },
        ctx,
      )) as Extract<DoneResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
    }
    // Tracker MUST NOT be marked completed on invalid input.
    expect(tracker.isComplete()).toBe(false)
  })

  it("invalid_input for non-string reason", async () => {
    const { ctx, tracker } = mockCtx()
    const r = (await doneTool.execute(
      { reason: 42 as unknown as string },
      ctx,
    )) as Extract<DoneResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(tracker.isComplete()).toBe(false)
  })

  it("does NOT throw on aborted signal (unlike other tools)", async () => {
    // done is intentionally cheap and abort-tolerant — even an
    // aborted loop should be able to flush its final state.
    const { ctx, tracker } = mockCtx({ aborted: true })
    const r = (await doneTool.execute({ reason: "ok" }, ctx)) as Extract<
      DoneResult,
      { ok: true }
    >
    expect(r.ok).toBe(true)
    expect(tracker.isComplete()).toBe(true)
  })
})
