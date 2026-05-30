import { describe, it, expect, vi, beforeEach } from "vitest"
import { webSearchTool, type WebSearchResult } from "./web-search"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"
import type { SearchApiConfig } from "@/stores/wiki-store"

vi.mock("@/lib/web-search", () => ({
  webSearch: vi.fn(),
  hasConfiguredSearchProvider: vi.fn(),
}))
import { webSearch, hasConfiguredSearchProvider } from "@/lib/web-search"

function mockCtx(opts: {
  searchApiConfig?: SearchApiConfig
  aborted?: boolean
} = {}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
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
    project: { id: "p", name: "p", path: "/p" },
    tracker: new InMemoryCoverageTracker("test", "h", 0),
    wikiAccess,
    llmConfig: {} as AgentContext["llmConfig"],
    searchApiConfig: opts.searchApiConfig,
    signal: controller.signal,
  } satisfies AgentContext
}

const CONFIGURED: SearchApiConfig = {
  provider: "tavily",
  apiKey: "tvly-test",
  ollamaUrl: "",
  searXngUrl: "",
  searXngCategories: ["general"],
  serpApiEngine: "google",
}

beforeEach(() => {
  vi.mocked(webSearch).mockReset()
  vi.mocked(hasConfiguredSearchProvider).mockReset()
})

describe("web_search — contract", () => {
  it("declares schema with required query", () => {
    expect(webSearchTool.name).toBe("web_search")
    const s = webSearchTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["query"])
    expect(s.properties.limit.maximum).toBe(20)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("web_search — happy path", () => {
  it("dispatches through webSearch and returns mapped results", async () => {
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    vi.mocked(webSearch).mockResolvedValueOnce([
      { title: "Result A", url: "https://a.example", snippet: "snippet a", source: "tavily" },
      { title: "Result B", url: "https://b.example", snippet: "snippet b", source: "tavily" },
    ])
    const ctx = mockCtx({ searchApiConfig: CONFIGURED })
    const r = (await webSearchTool.execute(
      { query: "what is X" },
      ctx,
    )) as Extract<WebSearchResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.results).toHaveLength(2)
    expect(r.results[0].title).toBe("Result A")
    expect(vi.mocked(webSearch)).toHaveBeenCalledWith("what is X", CONFIGURED, 5)
  })

  it("respects limit and forwards it to webSearch", async () => {
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    vi.mocked(webSearch).mockResolvedValueOnce([])
    const ctx = mockCtx({ searchApiConfig: CONFIGURED })
    await webSearchTool.execute({ query: "X", limit: 12 }, ctx)
    expect(vi.mocked(webSearch)).toHaveBeenCalledWith("X", CONFIGURED, 12)
  })

  it("clamps limit at MAX_LIMIT", async () => {
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    vi.mocked(webSearch).mockResolvedValueOnce([])
    const ctx = mockCtx({ searchApiConfig: CONFIGURED })
    await webSearchTool.execute({ query: "X", limit: 9999 }, ctx)
    expect(vi.mocked(webSearch)).toHaveBeenCalledWith("X", CONFIGURED, 20)
  })
})

describe("web_search — no provider", () => {
  it("no_provider_configured when ctx.searchApiConfig is missing", async () => {
    const ctx = mockCtx({})
    const r = (await webSearchTool.execute(
      { query: "X" },
      ctx,
    )) as Extract<WebSearchResult, { error: "no_provider_configured" }>
    expect(r.error).toBe("no_provider_configured")
    expect(r.hint).toMatch(/web_fetch/)
  })

  it("no_provider_configured when hasConfiguredSearchProvider is false", async () => {
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(false)
    const ctx = mockCtx({
      searchApiConfig: { ...CONFIGURED, provider: "none" } as SearchApiConfig,
    })
    const r = (await webSearchTool.execute(
      { query: "X" },
      ctx,
    )) as Extract<WebSearchResult, { error: "no_provider_configured" }>
    expect(r.error).toBe("no_provider_configured")
  })
})

describe("web_search — error envelope", () => {
  it("search_failed when webSearch throws", async () => {
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    vi.mocked(webSearch).mockRejectedValueOnce(new Error("rate limited"))
    const ctx = mockCtx({ searchApiConfig: CONFIGURED })
    const r = (await webSearchTool.execute(
      { query: "X" },
      ctx,
    )) as Extract<WebSearchResult, { error: "search_failed" }>
    expect(r.error).toBe("search_failed")
    expect(r.detail).toMatch(/rate limited/)
  })

  it("invalid_input on empty query", async () => {
    const ctx = mockCtx({ searchApiConfig: CONFIGURED })
    const r = (await webSearchTool.execute(
      { query: "   " },
      ctx,
    )) as Extract<WebSearchResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("throws on aborted signal", async () => {
    const ctx = mockCtx({ aborted: true })
    await expect(
      webSearchTool.execute({ query: "X" }, ctx),
    ).rejects.toThrow(/aborted/)
  })
})
