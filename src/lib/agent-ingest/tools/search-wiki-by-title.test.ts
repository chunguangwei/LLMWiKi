import { describe, it, expect } from "vitest"
import {
  searchWikiByTitleTool,
  type SearchWikiByTitleResult,
} from "./search-wiki-by-title"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess, WikiPageSummary } from "../types"

function mockCtx(opts: { pages: WikiPageSummary[]; aborted?: boolean }) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    listPages: async () => opts.pages,
    readPage: async () => null,
    writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
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

const PAGES: WikiPageSummary[] = [
  { slug: "concepts/transformer", type: "concept", title: "Transformer", description: "" },
  { slug: "concepts/attention", type: "concept", title: "Attention mechanism", description: "" },
  { slug: "entities/openai", type: "entity", title: "OpenAI", description: "" },
  { slug: "concepts/neural-network", type: "concept", title: "Neural network", description: "" },
  { slug: "reports/gpt4-report", type: "report", title: "GPT-4 capabilities report", description: "" },
]

describe("search_wiki_by_title — contract", () => {
  it("declares schema with required query", () => {
    expect(searchWikiByTitleTool.name).toBe("search_wiki_by_title")
    const s = searchWikiByTitleTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["query"])
    expect(s.properties.limit.maximum).toBe(20)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("search_wiki_by_title — ranking", () => {
  it("exact slug match wins with score 1.0 + match_reason exact", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "concepts/transformer" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("concepts/transformer")
    expect(r.matches[0].score).toBe(1)
    expect(r.matches[0].match_reason).toBe("exact")
  })

  it("exact title match also gets 1.0", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "Transformer" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("concepts/transformer")
    expect(r.matches[0].score).toBe(1)
  })

  it("substring match scores 0.85 and ranks above token-overlap", async () => {
    const ctx = mockCtx({ pages: PAGES })
    // "attention" is a substring of "concepts/attention" + title.
    const r = (await searchWikiByTitleTool.execute(
      { query: "attention" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("concepts/attention")
    expect(r.matches[0].score).toBe(0.85)
    expect(r.matches[0].match_reason).toBe("substring")
  })

  it("token overlap surfaces partial matches at lower score", async () => {
    const ctx = mockCtx({ pages: PAGES })
    // "neural net" shares "neural" with concepts/neural-network — and only
    // that page contains "neural" / "network".
    const r = (await searchWikiByTitleTool.execute(
      { query: "neural net" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("concepts/neural-network")
    expect(r.matches[0].match_reason === "substring" || r.matches[0].match_reason === "token_overlap").toBe(true)
  })

  it("returns empty matches when nothing scores above the cutoff", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "xyzwombat" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches).toEqual([])
    expect(r.query).toBe("xyzwombat")
  })

  it("respects the limit parameter", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "concepts", limit: 2 },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches.length).toBeLessThanOrEqual(2)
  })

  it("clamps limit at MAX_LIMIT (20)", async () => {
    const ctx = mockCtx({ pages: PAGES })
    // Should not throw and should still return all matches (≤5 pages).
    const r = (await searchWikiByTitleTool.execute(
      { query: "concepts", limit: 9999 },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches.length).toBeLessThanOrEqual(20)
  })
})

describe("search_wiki_by_title — input validation", () => {
  it("invalid_input on empty query", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "   " },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("returns ok with empty matches for an all-punctuation query (no tokens)", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "!!!" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.matches).toEqual([])
  })

  it("throws on aborted signal", async () => {
    const ctx = mockCtx({ pages: PAGES, aborted: true })
    await expect(
      searchWikiByTitleTool.execute({ query: "x" }, ctx),
    ).rejects.toThrow(/aborted/)
  })
})

describe("search_wiki_by_title — case + normalisation", () => {
  it("is case-insensitive on both query and titles", async () => {
    const ctx = mockCtx({ pages: PAGES })
    const r = (await searchWikiByTitleTool.execute(
      { query: "OPENAI" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("entities/openai")
  })

  it("hyphens / underscores in slug treated like spaces for tokenisation", async () => {
    const ctx = mockCtx({ pages: PAGES })
    // The slug "concepts/neural-network" should be findable by "network" alone.
    const r = (await searchWikiByTitleTool.execute(
      { query: "network" },
      ctx,
    )) as Extract<SearchWikiByTitleResult, { ok: true }>
    expect(r.matches[0].slug).toBe("concepts/neural-network")
  })
})
