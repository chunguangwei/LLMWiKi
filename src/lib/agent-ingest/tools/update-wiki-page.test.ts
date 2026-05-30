import { describe, it, expect } from "vitest"
import { updateWikiPageTool, type UpdateWikiPageResult } from "./update-wiki-page"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"

type UpdateCall = {
  slug: string
  body: string
  related?: string[]
  tags?: string[]
}

function mockCtx(opts: {
  /** Slugs that the fake WikiAccess pretends exist (updatable). */
  existing?: Set<string>
  /** If set, fail updatePage with this validation_failed detail. */
  failWith?: string
  /** added_chars value to return on success. */
  addedChars?: number
  aborted?: boolean
  updateCalls?: UpdateCall[]
}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const tracker = new InMemoryCoverageTracker("test", "h", 1)
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
    readPage: async () => null,
    writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    async updatePage(args) {
      opts.updateCalls?.push({ ...args })
      if (opts.failWith) return { kind: "validation_failed", detail: opts.failWith }
      if (!opts.existing?.has(args.slug)) return { kind: "slug_not_found" }
      return {
        kind: "updated",
        path: `wiki/${args.slug}.md`,
        added_chars: opts.addedChars ?? 0,
      }
    },
    linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
      deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
  }
  const ctx: AgentContext = {
    chunks: new Map(),
    outline: [],
    vectorIndex: { search: async () => [] },
    project: { id: "test", name: "test", path: "/tmp/test" },
    tracker,
    wikiAccess,
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  }
  return { ctx, tracker }
}

const VALID_INPUT: { slug: string; body: string } = {
  slug: "concepts/foo",
  body: "# Foo\n\nNew body content.",
}

describe("update_wiki_page — contract", () => {
  it("declares schema with required slug + body, optional related/tags", () => {
    expect(updateWikiPageTool.name).toBe("update_wiki_page")
    const s = updateWikiPageTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["slug", "body"])
    // type and title are intentionally NOT updatable here
    expect("type" in s.properties).toBe(false)
    expect("title" in s.properties).toBe(false)
    expect(s.properties.slug.maxLength).toBe(200)
    expect(s.properties.related.items).toEqual({ type: "string", minLength: 1 })
    expect(s.properties.tags.items).toEqual({ type: "string", minLength: 1 })
    expect(s.additionalProperties).toBe(false)
  })
})

describe("update_wiki_page — happy path", () => {
  it("updates the page, records in tracker, returns added_chars", async () => {
    const updateCalls: UpdateCall[] = []
    const { ctx, tracker } = mockCtx({
      existing: new Set(["concepts/foo"]),
      addedChars: 42,
      updateCalls,
    })
    const r = (await updateWikiPageTool.execute(
      { ...VALID_INPUT, related: ["concepts/bar"], tags: ["llm"] },
      ctx,
    )) as Extract<UpdateWikiPageResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.path).toBe("wiki/concepts/foo.md")
    expect(r.slug).toBe("concepts/foo")
    expect(r.added_chars).toBe(42)
    expect(updateCalls[0]).toEqual({
      slug: "concepts/foo",
      body: "# Foo\n\nNew body content.",
      related: ["concepts/bar"],
      tags: ["llm"],
    })
    expect(tracker.updatedPages()).toEqual([
      { slug: "concepts/foo", fromChunks: [] },
    ])
  })

  it("preserves body whitespace verbatim (caller's markdown decisions)", async () => {
    const updateCalls: UpdateCall[] = []
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]), updateCalls })
    await updateWikiPageTool.execute(
      { slug: "concepts/foo", body: "\n\n  # leading blanks  \n\n" },
      ctx,
    )
    expect(updateCalls[0].body).toBe("\n\n  # leading blanks  \n\n")
  })

  it("trims slug before forwarding", async () => {
    const updateCalls: UpdateCall[] = []
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]), updateCalls })
    await updateWikiPageTool.execute(
      { slug: "  concepts/foo  ", body: "x" },
      ctx,
    )
    expect(updateCalls[0].slug).toBe("concepts/foo")
  })

  it("omits empty related / tags from the forwarded args", async () => {
    const updateCalls: UpdateCall[] = []
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]), updateCalls })
    await updateWikiPageTool.execute(VALID_INPUT, ctx)
    expect("related" in updateCalls[0]).toBe(false)
    expect("tags" in updateCalls[0]).toBe(false)
  })

  it("silently filters non-string / empty entries from related & tags", async () => {
    const updateCalls: UpdateCall[] = []
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]), updateCalls })
    await updateWikiPageTool.execute(
      {
        ...VALID_INPUT,
        related: ["a", "", null as unknown as string, "b"],
        tags: ["x", "  ", "y"],
      },
      ctx,
    )
    expect(updateCalls[0].related).toEqual(["a", "b"])
    expect(updateCalls[0].tags).toEqual(["x", "y"])
  })

  it("forwards added_chars=0 verbatim (body shrank or same size)", async () => {
    const { ctx } = mockCtx({
      existing: new Set(["concepts/foo"]),
      addedChars: 0,
    })
    const r = (await updateWikiPageTool.execute(
      VALID_INPUT,
      ctx,
    )) as Extract<UpdateWikiPageResult, { ok: true }>
    expect(r.added_chars).toBe(0)
  })
})

describe("update_wiki_page — error paths", () => {
  it("returns slug_not_found when no page exists + hints at write_wiki_page", async () => {
    const { ctx, tracker } = mockCtx({ existing: new Set() })
    const r = (await updateWikiPageTool.execute(
      VALID_INPUT,
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "slug_not_found" }>
    expect(r.error).toBe("slug_not_found")
    expect(r.detail).toMatch(/concepts\/foo/)
    expect(r.detail).toMatch(/write_wiki_page/)
    // Tracker must NOT record the (failed) update.
    expect(tracker.updatedPages()).toEqual([])
  })

  it("forwards WikiAccess validation_failed detail verbatim", async () => {
    const { ctx } = mockCtx({
      existing: new Set(["concepts/foo"]),
      failWith: "body too long (max 100KB)",
    })
    const r = (await updateWikiPageTool.execute(
      VALID_INPUT,
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "validation_failed" }>
    expect(r.error).toBe("validation_failed")
    expect(r.detail).toBe("body too long (max 100KB)")
  })

  it("invalid_input for path traversal in slug", async () => {
    const { ctx, tracker } = mockCtx({ existing: new Set() })
    const r = (await updateWikiPageTool.execute(
      { slug: "../etc/passwd", body: "x" },
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/slug:/)
    expect(tracker.updatedPages()).toEqual([])
  })

  it("invalid_input for slug with .md extension", async () => {
    const { ctx } = mockCtx({ existing: new Set() })
    const r = (await updateWikiPageTool.execute(
      { slug: "concepts/foo.md", body: "x" },
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/\.md/)
  })

  it("invalid_input for empty / whitespace body", async () => {
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]) })
    for (const body of ["", "   ", "\n\t"]) {
      const r = (await updateWikiPageTool.execute(
        { slug: "concepts/foo", body },
        ctx,
      )) as Extract<UpdateWikiPageResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
      expect(r.detail).toMatch(/body/)
    }
  })

  it("invalid_input when related / tags are not arrays", async () => {
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]) })
    const r1 = (await updateWikiPageTool.execute(
      { ...VALID_INPUT, related: "not-array" as unknown as string[] },
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "invalid_input" }>
    expect(r1.error).toBe("invalid_input")
    expect(r1.detail).toMatch(/related must be an array/)

    const r2 = (await updateWikiPageTool.execute(
      { ...VALID_INPUT, tags: 42 as unknown as string[] },
      ctx,
    )) as Extract<UpdateWikiPageResult, { error: "invalid_input" }>
    expect(r2.error).toBe("invalid_input")
    expect(r2.detail).toMatch(/tags must be an array/)
  })

  it("throws when the agent's signal has been aborted", async () => {
    const { ctx } = mockCtx({ existing: new Set(["concepts/foo"]), aborted: true })
    await expect(updateWikiPageTool.execute(VALID_INPUT, ctx)).rejects.toThrow(
      /aborted/i,
    )
  })

  it("no error path mutates the tracker", async () => {
    const { ctx, tracker } = mockCtx({ existing: new Set() })
    await updateWikiPageTool.execute(VALID_INPUT, ctx)
    expect(tracker.updatedPages()).toEqual([])
  })
})
