import { describe, it, expect } from "vitest"
import { listWikiPagesTool } from "./list-wiki-pages"
import type { AgentContext, WikiPageSummary, WikiAccess } from "../types"

function mockCtx(opts: {
  pages: WikiPageSummary[]
  aborted?: boolean
  /** Capture every listPages call's filter, so tests can assert what the tool forwarded. */
  listCalls?: Array<{ type: string | undefined }>
}): AgentContext {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    async listPages(filter) {
      opts.listCalls?.push({ type: filter?.type })
      if (filter?.type) {
        return opts.pages.filter((p) => p.type === filter.type)
      }
      return opts.pages
    },
    async readPage() {
      return null
    },
    async writePage() {
      return { kind: "validation_failed", detail: "mock" }
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

const PAGES: WikiPageSummary[] = [
  {
    slug: "concepts/karpathy-llm-wiki",
    type: "concept",
    title: "Karpathy LLM Wiki",
    description: "LLM is the processor, wiki is the memory.",
    related: ["concepts/agent-ingest"],
  },
  {
    slug: "reports/2026-q1-okr",
    type: "report",
    title: "Q1 OKR Review",
    description: "Quarterly review of IT team OKR progress.",
  },
  {
    slug: "concepts/agent-ingest",
    type: "concept",
    title: "Agent Ingest",
    description: "Agentic pipeline for long sources.",
    related: ["concepts/karpathy-llm-wiki"],
  },
]

describe("list_wiki_pages — contract", () => {
  it("declares input schema with optional type filter", () => {
    expect(listWikiPagesTool.name).toBe("list_wiki_pages")
    const s = listWikiPagesTool.inputSchema as Record<string, any>
    expect(s.required).toEqual([])
    expect(s.properties.type.minLength).toBe(1)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("list_wiki_pages — happy path", () => {
  it("returns all pages when no filter", async () => {
    const r = await listWikiPagesTool.execute({}, mockCtx({ pages: PAGES }))
    expect(r.pages).toHaveLength(3)
    expect(r.pages.map((p) => p.slug)).toContain("concepts/karpathy-llm-wiki")
  })

  it("filters by type when provided", async () => {
    const listCalls: Array<{ type: string | undefined }> = []
    const r = await listWikiPagesTool.execute(
      { type: "concept" },
      mockCtx({ pages: PAGES, listCalls }),
    )
    expect(r.pages.map((p) => p.slug)).toEqual([
      "concepts/karpathy-llm-wiki",
      "concepts/agent-ingest",
    ])
    expect(listCalls[0]).toEqual({ type: "concept" })
  })

  it("trims the type filter before forwarding", async () => {
    const listCalls: Array<{ type: string | undefined }> = []
    await listWikiPagesTool.execute(
      { type: "  report  " },
      mockCtx({ pages: PAGES, listCalls }),
    )
    expect(listCalls[0]).toEqual({ type: "report" })
  })

  it("treats empty / whitespace-only type as 'no filter'", async () => {
    const listCalls: Array<{ type: string | undefined }> = []
    await listWikiPagesTool.execute({ type: "  " }, mockCtx({ pages: PAGES, listCalls }))
    expect(listCalls[0]).toEqual({ type: undefined })
  })

  it("omits empty related arrays from the output", async () => {
    const r = await listWikiPagesTool.execute({}, mockCtx({ pages: PAGES }))
    const reportPage = r.pages.find((p) => p.slug === "reports/2026-q1-okr")!
    expect("related" in reportPage).toBe(false)
  })

  it("returns empty pages array when wiki is empty", async () => {
    const r = await listWikiPagesTool.execute({}, mockCtx({ pages: [] }))
    expect(r.pages).toEqual([])
  })
})

describe("list_wiki_pages — leak resistance", () => {
  it("does not leak runner-attached extras on page summaries", async () => {
    const withExtras = [
      {
        slug: "concepts/x",
        type: "concept",
        title: "X",
        description: "test",
        related: [],
        cache_key: "abc",
        last_modified: 1234,
      },
    ] as unknown as WikiPageSummary[]
    const r = await listWikiPagesTool.execute({}, mockCtx({ pages: withExtras }))
    const p = r.pages[0] as unknown as Record<string, unknown>
    expect(p.cache_key).toBeUndefined()
    expect(p.last_modified).toBeUndefined()
    // Empty related[] should be omitted entirely.
    expect("related" in p).toBe(false)
    expect(Object.keys(p).sort()).toEqual(["description", "slug", "title", "type"])
  })
})

describe("list_wiki_pages — defence", () => {
  it("throws when the agent's signal has been aborted", async () => {
    await expect(
      listWikiPagesTool.execute({}, mockCtx({ pages: PAGES, aborted: true })),
    ).rejects.toThrow(/aborted/i)
  })
})
