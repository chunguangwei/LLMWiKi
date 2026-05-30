import { describe, it, expect } from "vitest"
import { linkPagesTool, type LinkPagesResult } from "./link-pages"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"

type LinkCall = {
  from: string
  to: string
  bidirectional?: boolean
}

function mockCtx(opts: {
  existing?: Set<string>
  /** Existing forward links — pairs already in `from`'s related. */
  forwardLinks?: Set<string>  // "from→to"
  reverseLinks?: Set<string>  // "to→from"
  failWith?: string
  aborted?: boolean
  linkCalls?: LinkCall[]
}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
    readPage: async () => null,
    writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    async linkPages(args) {
      opts.linkCalls?.push({ ...args })
      if (opts.failWith) return { kind: "validation_failed", detail: opts.failWith }
      if (opts.existing && !opts.existing.has(args.from)) {
        return { kind: "slug_not_found", missing: "from" }
      }
      if (opts.existing && !opts.existing.has(args.to)) {
        return { kind: "slug_not_found", missing: "to" }
      }
      const fromKey = `${args.from}→${args.to}`
      const from_was_new = !opts.forwardLinks?.has(fromKey)
      if (args.bidirectional) {
        const toKey = `${args.to}→${args.from}`
        const to_was_new = !opts.reverseLinks?.has(toKey)
        return { kind: "linked", from_was_new, to_was_new }
      }
      return { kind: "linked", from_was_new }
    },
    deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
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

const EXISTING = new Set(["concepts/foo", "concepts/bar"])

describe("link_pages — contract", () => {
  it("declares schema with required from_slug + to_slug", () => {
    expect(linkPagesTool.name).toBe("link_pages")
    const s = linkPagesTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["from_slug", "to_slug"])
    expect(s.properties.bidirectional.type).toBe("boolean")
    expect(s.additionalProperties).toBe(false)
  })
})

describe("link_pages — happy path", () => {
  it("adds the link, defaults bidirectional=false, omits to_was_new", async () => {
    const linkCalls: LinkCall[] = []
    const ctx = mockCtx({ existing: EXISTING, linkCalls })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar" },
      ctx,
    )) as Extract<LinkPagesResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.from_was_new).toBe(true)
    expect("to_was_new" in r).toBe(false)
    expect(linkCalls[0]).toEqual({
      from: "concepts/foo",
      to: "concepts/bar",
      bidirectional: false,
    })
  })

  it("bidirectional=true forwards the flag AND reports to_was_new", async () => {
    const linkCalls: LinkCall[] = []
    const ctx = mockCtx({ existing: EXISTING, linkCalls })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar", bidirectional: true },
      ctx,
    )) as Extract<LinkPagesResult, { ok: true }>
    expect(r.from_was_new).toBe(true)
    expect(r.to_was_new).toBe(true)
    expect(linkCalls[0].bidirectional).toBe(true)
  })

  it("reports from_was_new=false when the forward link already exists", async () => {
    const ctx = mockCtx({
      existing: EXISTING,
      forwardLinks: new Set(["concepts/foo→concepts/bar"]),
    })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar" },
      ctx,
    )) as Extract<LinkPagesResult, { ok: true }>
    expect(r.from_was_new).toBe(false)
  })

  it("bidirectional + one direction already linked reports correctly", async () => {
    const ctx = mockCtx({
      existing: EXISTING,
      forwardLinks: new Set(["concepts/foo→concepts/bar"]),
      // reverse not pre-existing
    })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar", bidirectional: true },
      ctx,
    )) as Extract<LinkPagesResult, { ok: true }>
    expect(r.from_was_new).toBe(false)
    expect(r.to_was_new).toBe(true)
  })

  it("trims both slugs before forwarding", async () => {
    const linkCalls: LinkCall[] = []
    const ctx = mockCtx({ existing: EXISTING, linkCalls })
    await linkPagesTool.execute(
      { from_slug: "  concepts/foo  ", to_slug: "\nconcepts/bar\n" },
      ctx,
    )
    expect(linkCalls[0].from).toBe("concepts/foo")
    expect(linkCalls[0].to).toBe("concepts/bar")
  })
})

describe("link_pages — error paths", () => {
  it("rejects self-links as invalid_input", async () => {
    const ctx = mockCtx({ existing: EXISTING })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/foo" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/self-link/i)
  })

  it("rejects self-links AFTER trimming (whitespace doesn't help)", async () => {
    const ctx = mockCtx({ existing: EXISTING })
    const r = (await linkPagesTool.execute(
      { from_slug: "  concepts/foo  ", to_slug: "concepts/foo" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("invalid_input identifies which slug failed (from_slug vs to_slug)", async () => {
    const ctx = mockCtx({ existing: EXISTING })
    const r1 = (await linkPagesTool.execute(
      { from_slug: "../etc/passwd", to_slug: "concepts/bar" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "invalid_input" }>
    expect(r1.detail).toMatch(/^from_slug:/)
    const r2 = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar.md" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "invalid_input" }>
    expect(r2.detail).toMatch(/^to_slug:/)
  })

  it("slug_not_found surfaces which side was missing", async () => {
    const ctx = mockCtx({ existing: new Set(["concepts/bar"]) })  // only bar exists
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/ghost", to_slug: "concepts/bar" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "slug_not_found" }>
    expect(r.error).toBe("slug_not_found")
    expect(r.missing).toBe("from")
    expect(r.detail).toMatch(/concepts\/ghost/)
    expect(r.detail).toMatch(/list_wiki_pages|write_wiki_page/)
  })

  it("slug_not_found for the to side", async () => {
    const ctx = mockCtx({ existing: new Set(["concepts/foo"]) })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/ghost" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "slug_not_found" }>
    expect(r.missing).toBe("to")
    expect(r.detail).toMatch(/concepts\/ghost/)
  })

  it("forwards validation_failed detail verbatim", async () => {
    const ctx = mockCtx({
      existing: EXISTING,
      failWith: "cycle would be created",
    })
    const r = (await linkPagesTool.execute(
      { from_slug: "concepts/foo", to_slug: "concepts/bar" },
      ctx,
    )) as Extract<LinkPagesResult, { error: "validation_failed" }>
    expect(r.error).toBe("validation_failed")
    expect(r.detail).toBe("cycle would be created")
  })

  it("throws when the agent's signal has been aborted", async () => {
    const ctx = mockCtx({ existing: EXISTING, aborted: true })
    await expect(
      linkPagesTool.execute(
        { from_slug: "concepts/foo", to_slug: "concepts/bar" },
        ctx,
      ),
    ).rejects.toThrow(/aborted/i)
  })
})
