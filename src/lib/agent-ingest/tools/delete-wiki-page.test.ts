import { describe, it, expect } from "vitest"
import { deleteWikiPageTool, type DeleteWikiPageResult } from "./delete-wiki-page"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"

type DeleteCall = { slug: string; reason: string }

function mockCtx(opts: {
  existing?: Set<string>
  structuralReject?: Set<string>
  aborted?: boolean
  deleteCalls?: DeleteCall[]
}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
    readPage: async () => null,
    writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
    async deletePage(args) {
      opts.deleteCalls?.push({ ...args })
      if (opts.structuralReject?.has(args.slug)) {
        return { kind: "validation_failed", detail: "structural page reject" }
      }
      if (opts.existing && !opts.existing.has(args.slug)) {
        return { kind: "slug_not_found" }
      }
      return { kind: "deleted", path: `/wiki/${args.slug}.md` }
    },
  }
  return {
    chunks: new Map(),
    outline: [],
    vectorIndex: { search: async () => [] },
    project: { id: "test", name: "test", path: "/tmp/test" },
    tracker: new InMemoryCoverageTracker("test", "h", 0),
    wikiAccess,
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  } satisfies AgentContext
}

describe("delete_wiki_page — contract", () => {
  it("declares schema with required slug + reason", () => {
    expect(deleteWikiPageTool.name).toBe("delete_wiki_page")
    const s = deleteWikiPageTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["slug", "reason"])
    expect(s.properties.slug.maxLength).toBe(200)
    expect(s.properties.reason.minLength).toBe(1)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("delete_wiki_page — happy path", () => {
  it("deletes and returns ok with path + reason", async () => {
    const calls: DeleteCall[] = []
    const ctx = mockCtx({ existing: new Set(["concepts/stale"]), deleteCalls: calls })
    const r = (await deleteWikiPageTool.execute(
      { slug: "concepts/stale", reason: "topic merged into concepts/active" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.slug).toBe("concepts/stale")
    expect(r.path).toBe("/wiki/concepts/stale.md")
    expect(r.reason).toBe("topic merged into concepts/active")
    expect(calls).toEqual([
      { slug: "concepts/stale", reason: "topic merged into concepts/active" },
    ])
  })

  it("trims reason whitespace before forwarding", async () => {
    const calls: DeleteCall[] = []
    const ctx = mockCtx({ existing: new Set(["foo"]), deleteCalls: calls })
    await deleteWikiPageTool.execute(
      { slug: "foo", reason: "   stale   " },
      ctx,
    )
    expect(calls[0].reason).toBe("stale")
  })
})

describe("delete_wiki_page — error paths", () => {
  it("invalid_input on path traversal in slug", async () => {
    const ctx = mockCtx({ existing: new Set() })
    const r = (await deleteWikiPageTool.execute(
      { slug: "../../etc/passwd", reason: "rogue" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/slug:/)
  })

  it("invalid_input on .md extension in slug", async () => {
    const ctx = mockCtx({ existing: new Set() })
    const r = (await deleteWikiPageTool.execute(
      { slug: "concepts/foo.md", reason: "stale" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("invalid_input on empty reason", async () => {
    const ctx = mockCtx({ existing: new Set(["foo"]) })
    const r = (await deleteWikiPageTool.execute(
      { slug: "foo", reason: "   " },
      ctx,
    )) as Extract<DeleteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/reason/)
  })

  it("slug_not_found when WikiAccess reports missing", async () => {
    const ctx = mockCtx({ existing: new Set(["other"]) })
    const r = (await deleteWikiPageTool.execute(
      { slug: "concepts/ghost", reason: "doesn't exist" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { error: "slug_not_found" }>
    expect(r.error).toBe("slug_not_found")
    expect(r.detail).toMatch(/concepts\/ghost/)
  })

  it("validation_failed propagates the structural-page reject", async () => {
    const ctx = mockCtx({
      existing: new Set(["index"]),
      structuralReject: new Set(["index"]),
    })
    const r = (await deleteWikiPageTool.execute(
      { slug: "index", reason: "trying to delete the toc" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { error: "validation_failed" }>
    expect(r.error).toBe("validation_failed")
    expect(r.detail).toMatch(/structural/)
  })

  it("throws when signal is already aborted (matches other mutation tools)", async () => {
    const ctx = mockCtx({ existing: new Set(["foo"]), aborted: true })
    await expect(
      deleteWikiPageTool.execute({ slug: "foo", reason: "stale" }, ctx),
    ).rejects.toThrow(/aborted/)
  })
})

describe("delete_wiki_page — tracker hook", () => {
  it("calls markDeleted when the tracker exposes it", async () => {
    let recorded: { slug: string; reason: string } | null = null
    const ctx = mockCtx({ existing: new Set(["foo"]) })
    // Augment the tracker with markDeleted dynamically — the lint-fix
    // tracker does this for real; the in-memory ingest tracker doesn't.
    ;(ctx.tracker as unknown as {
      markDeleted: (slug: string, reason: string) => void
    }).markDeleted = (slug, reason) => {
      recorded = { slug, reason }
    }
    await deleteWikiPageTool.execute({ slug: "foo", reason: "stale" }, ctx)
    expect(recorded).toEqual({ slug: "foo", reason: "stale" })
  })

  it("silently no-ops when tracker has no markDeleted (agent-ingest case)", async () => {
    const ctx = mockCtx({ existing: new Set(["foo"]) })
    const r = (await deleteWikiPageTool.execute(
      { slug: "foo", reason: "stale" },
      ctx,
    )) as Extract<DeleteWikiPageResult, { ok: true }>
    expect(r.ok).toBe(true)
    // No assertion needed beyond "doesn't throw"; the optional-chain
    // pattern in the tool is the contract here.
  })
})
