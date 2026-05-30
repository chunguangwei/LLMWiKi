import { describe, it, expect } from "vitest"
import { writeWikiPageTool, type WriteWikiPageResult } from "./write-wiki-page"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"

type WriteCall = {
  slug: string
  type: string
  title: string
  body: string
  related?: string[]
  tags?: string[]
}

function mockCtx(opts: {
  /** Slugs that the fake WikiAccess pretends already exist. */
  taken?: Set<string>
  /** If set, fail writePage with this validation_failed detail. */
  failWith?: string
  aborted?: boolean
  /** Capture every writePage call's args for assertions. */
  writeCalls?: WriteCall[]
}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const tracker = new InMemoryCoverageTracker("test-source", "hash", 1)
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
    readPage: async () => null,
    async writePage(args) {
      opts.writeCalls?.push({ ...args })
      if (opts.failWith) {
        return { kind: "validation_failed", detail: opts.failWith }
      }
      if (opts.taken?.has(args.slug)) {
        return { kind: "slug_taken" }
      }
      return { kind: "created", path: `wiki/${args.slug}.md` }
    },
    async updatePage() {
      return { kind: "validation_failed", detail: "mock" }
    },
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

const VALID_INPUT = {
  slug: "concepts/foo",
  type: "concept",
  title: "Foo",
  body: "# Foo\n\nbody text",
}

describe("write_wiki_page — contract", () => {
  it("declares schema with required fields + array constraints", () => {
    expect(writeWikiPageTool.name).toBe("write_wiki_page")
    const s = writeWikiPageTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["slug", "type", "title", "body"])
    expect(s.properties.slug.minLength).toBe(1)
    expect(s.properties.slug.maxLength).toBe(200)
    expect(s.properties.related.items).toEqual({ type: "string", minLength: 1 })
    expect(s.properties.tags.items).toEqual({ type: "string", minLength: 1 })
    expect(s.additionalProperties).toBe(false)
  })
})

describe("write_wiki_page — happy path", () => {
  it("creates the page, records in tracker, forwards args to WikiAccess", async () => {
    const writeCalls: WriteCall[] = []
    const { ctx, tracker } = mockCtx({ writeCalls })
    const r = (await writeWikiPageTool.execute(
      {
        ...VALID_INPUT,
        related: ["concepts/bar"],
        tags: ["llm", "wiki"],
      },
      ctx,
    )) as Extract<WriteWikiPageResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.path).toBe("wiki/concepts/foo.md")
    expect(r.slug).toBe("concepts/foo")
    expect(writeCalls[0]).toEqual({
      slug: "concepts/foo",
      type: "concept",
      title: "Foo",
      body: "# Foo\n\nbody text",
      related: ["concepts/bar"],
      tags: ["llm", "wiki"],
    })
    // Tracker records the create with empty fromChunks (separate
    // mark_section_covered attributes chunks).
    expect(tracker.createdPages()).toEqual([
      { slug: "concepts/foo", fromChunks: [] },
    ])
  })

  it("trims slug/type/title before forwarding (body whitespace preserved)", async () => {
    const writeCalls: WriteCall[] = []
    const { ctx } = mockCtx({ writeCalls })
    await writeWikiPageTool.execute(
      {
        slug: "  concepts/foo  ",
        type: "  concept  ",
        title: "  Foo  ",
        body: "\n# Foo\n",
      },
      ctx,
    )
    expect(writeCalls[0].slug).toBe("concepts/foo")
    expect(writeCalls[0].type).toBe("concept")
    expect(writeCalls[0].title).toBe("Foo")
    expect(writeCalls[0].body).toBe("\n# Foo\n")  // preserved
  })

  it("omits empty related / tags from the forwarded args", async () => {
    const writeCalls: WriteCall[] = []
    const { ctx } = mockCtx({ writeCalls })
    await writeWikiPageTool.execute(VALID_INPUT, ctx)
    expect("related" in writeCalls[0]).toBe(false)
    expect("tags" in writeCalls[0]).toBe(false)
  })

  it("silently filters non-string / empty entries from related & tags", async () => {
    const writeCalls: WriteCall[] = []
    const { ctx } = mockCtx({ writeCalls })
    await writeWikiPageTool.execute(
      {
        ...VALID_INPUT,
        related: ["a", "", null as unknown as string, "b"],
        tags: ["x", "  ", "y"],
      },
      ctx,
    )
    expect(writeCalls[0].related).toEqual(["a", "b"])
    expect(writeCalls[0].tags).toEqual(["x", "y"])
  })
})

describe("write_wiki_page — error paths", () => {
  it("returns slug_taken when WikiAccess says so + hints at update_wiki_page", async () => {
    const { ctx, tracker } = mockCtx({ taken: new Set(["concepts/foo"]) })
    const r = (await writeWikiPageTool.execute(
      VALID_INPUT,
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "slug_taken" }>
    expect(r.error).toBe("slug_taken")
    expect(r.detail).toMatch(/concepts\/foo/)
    expect(r.detail).toMatch(/update_wiki_page/)
    // Tracker must NOT record the (failed) create.
    expect(tracker.createdPages()).toEqual([])
  })

  it("forwards WikiAccess validation_failed detail verbatim", async () => {
    const { ctx } = mockCtx({ failWith: "type 'gibberish' is not in schema" })
    const r = (await writeWikiPageTool.execute(
      { ...VALID_INPUT, type: "gibberish" },
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "validation_failed" }>
    expect(r.error).toBe("validation_failed")
    expect(r.detail).toBe("type 'gibberish' is not in schema")
  })

  it("invalid_input for path traversal in slug", async () => {
    const { ctx, tracker } = mockCtx({})
    const r = (await writeWikiPageTool.execute(
      { ...VALID_INPUT, slug: "../etc/passwd" },
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/slug:/)
    expect(tracker.createdPages()).toEqual([])
  })

  it("invalid_input for slug with .md extension", async () => {
    const { ctx } = mockCtx({})
    const r = (await writeWikiPageTool.execute(
      { ...VALID_INPUT, slug: "concepts/foo.md" },
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/\.md/)
  })

  it("invalid_input for empty type / title / body", async () => {
    const { ctx } = mockCtx({})
    for (const [field, override] of [
      ["type", { type: "" }],
      ["type", { type: "   " }],
      ["title", { title: "" }],
      ["body", { body: "  \n  " }],
    ] as const) {
      const r = (await writeWikiPageTool.execute(
        { ...VALID_INPUT, ...override },
        ctx,
      )) as Extract<WriteWikiPageResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
      expect(r.detail).toMatch(new RegExp(field))
    }
  })

  it("invalid_input when related is not an array", async () => {
    const { ctx } = mockCtx({})
    const r = (await writeWikiPageTool.execute(
      { ...VALID_INPUT, related: "not-an-array" as unknown as string[] },
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/related must be an array/)
  })

  it("invalid_input when tags is not an array", async () => {
    const { ctx } = mockCtx({})
    const r = (await writeWikiPageTool.execute(
      { ...VALID_INPUT, tags: { 0: "x" } as unknown as string[] },
      ctx,
    )) as Extract<WriteWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/tags must be an array/)
  })

  it("throws when the agent's signal has been aborted", async () => {
    const { ctx } = mockCtx({ aborted: true })
    await expect(writeWikiPageTool.execute(VALID_INPUT, ctx)).rejects.toThrow(
      /aborted/i,
    )
  })

  it("no error path leaves the tracker mutated", async () => {
    const { ctx, tracker } = mockCtx({ failWith: "schema mismatch" })
    await writeWikiPageTool.execute(VALID_INPUT, ctx)
    expect(tracker.createdPages()).toEqual([])
  })
})
