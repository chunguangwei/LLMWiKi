import { describe, it, expect } from "vitest"
import { readWikiPageTool, type ReadWikiPageResult } from "./read-wiki-page"
import type { AgentContext, WikiPageFull, WikiAccess } from "../types"

function mockCtx(opts: {
  pages: Map<string, WikiPageFull>
  aborted?: boolean
  readCalls?: string[]
}): AgentContext {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    async listPages() {
      return []
    },
    async readPage(slug) {
      opts.readCalls?.push(slug)
      return opts.pages.get(slug) ?? null
    },
  }
  return {
    chunks: new Map(),
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
    wikiAccess,
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  }
}

const PAGE: WikiPageFull = {
  slug: "concepts/karpathy-llm-wiki",
  type: "concept",
  title: "Karpathy LLM Wiki",
  frontmatter: {
    type: "concept",
    title: "Karpathy LLM Wiki",
    related: ["concepts/agent-ingest"],
    sources: ["raw/sources/karpathy-talk.md"],
    tags: ["llm", "knowledge-management"],
  },
  body: "# Karpathy LLM Wiki\n\nLLM is the processor, wiki is the memory.\n",
}

describe("read_wiki_page — contract", () => {
  it("declares input schema with required slug", () => {
    expect(readWikiPageTool.name).toBe("read_wiki_page")
    const s = readWikiPageTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["slug"])
    expect(s.properties.slug.minLength).toBe(1)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("read_wiki_page — happy path", () => {
  it("returns the page's slug + type + title + frontmatter + body", async () => {
    const ctx = mockCtx({ pages: new Map([[PAGE.slug, PAGE]]) })
    const r = (await readWikiPageTool.execute(
      { slug: "concepts/karpathy-llm-wiki" },
      ctx,
    )) as WikiPageFull
    expect(r.slug).toBe("concepts/karpathy-llm-wiki")
    expect(r.type).toBe("concept")
    expect(r.title).toBe("Karpathy LLM Wiki")
    expect(r.frontmatter.related).toEqual(["concepts/agent-ingest"])
    expect(r.body).toContain("LLM is the processor")
  })

  it("trims the slug before lookup", async () => {
    const readCalls: string[] = []
    const ctx = mockCtx({
      pages: new Map([[PAGE.slug, PAGE]]),
      readCalls,
    })
    await readWikiPageTool.execute({ slug: "  concepts/karpathy-llm-wiki  " }, ctx)
    expect(readCalls[0]).toBe("concepts/karpathy-llm-wiki")
  })

  it("preserves arbitrary frontmatter keys (user/LLM-authored)", async () => {
    const customPage: WikiPageFull = {
      slug: "x",
      type: "note",
      title: "x",
      frontmatter: {
        type: "note",
        title: "x",
        custom_field_for_user_tooling: "value",
        nested: { a: 1, b: [2, 3] },
      },
      body: "body",
    }
    const ctx = mockCtx({ pages: new Map([["x", customPage]]) })
    const r = (await readWikiPageTool.execute({ slug: "x" }, ctx)) as WikiPageFull
    expect(r.frontmatter.custom_field_for_user_tooling).toBe("value")
    expect(r.frontmatter.nested).toEqual({ a: 1, b: [2, 3] })
  })
})

describe("read_wiki_page — error paths", () => {
  it("returns slug_not_found for an unknown slug", async () => {
    const ctx = mockCtx({ pages: new Map() })
    const r = (await readWikiPageTool.execute(
      { slug: "ghost" },
      ctx,
    )) as Extract<ReadWikiPageResult, { error: "slug_not_found" }>
    expect(r.error).toBe("slug_not_found")
    expect(r.detail).toMatch(/ghost/)
    expect(r.detail).toMatch(/list_wiki_pages/i)
  })

  it("returns invalid_input for empty / whitespace slug", async () => {
    const ctx = mockCtx({ pages: new Map() })
    for (const slug of ["", "   ", "\n"]) {
      const r = (await readWikiPageTool.execute(
        { slug },
        ctx,
      )) as Extract<ReadWikiPageResult, { error: "invalid_input" }>
      expect(r.error).toBe("invalid_input")
    }
  })

  it("returns invalid_input for non-string slug", async () => {
    const ctx = mockCtx({ pages: new Map() })
    const r = (await readWikiPageTool.execute(
      { slug: 42 as unknown as string },
      ctx,
    )) as Extract<ReadWikiPageResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("throws when the agent's signal has been aborted", async () => {
    const ctx = mockCtx({ pages: new Map([[PAGE.slug, PAGE]]), aborted: true })
    await expect(
      readWikiPageTool.execute({ slug: PAGE.slug }, ctx),
    ).rejects.toThrow(/aborted/i)
  })
})
