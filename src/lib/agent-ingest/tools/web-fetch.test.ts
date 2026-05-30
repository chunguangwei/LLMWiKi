import { describe, it, expect, vi, beforeEach } from "vitest"
import { webFetchTool, type WebFetchResult } from "./web-fetch"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"

// Mock fetchAndExtract — the tool layer's job is validation +
// envelope shape, not re-testing the real fetcher (which has its own
// suite at web-fetch.test.ts).
vi.mock("@/lib/web-fetch", () => ({
  fetchAndExtract: vi.fn(),
}))
import { fetchAndExtract } from "@/lib/web-fetch"

function mockCtx(opts: { aborted?: boolean } = {}) {
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
    signal: controller.signal,
  } satisfies AgentContext
}

beforeEach(() => {
  vi.mocked(fetchAndExtract).mockReset()
})

describe("web_fetch — contract", () => {
  it("declares schema with required url", () => {
    expect(webFetchTool.name).toBe("web_fetch")
    const s = webFetchTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["url"])
    expect(s.properties.url.maxLength).toBe(2048)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("web_fetch — happy path", () => {
  it("forwards to fetchAndExtract, trims overlong markdown, marks truncated", async () => {
    const bigMarkdown = "x".repeat(50_000)
    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "https://example.com",
      finalUrl: "https://example.com/article",
      title: "Example Article",
      markdown: bigMarkdown,
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "https://example.com" },
      ctx,
    )) as Extract<WebFetchResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.title).toBe("Example Article")
    expect(r.truncated).toBe(true)
    expect(r.markdown.length).toBeLessThan(bigMarkdown.length)
    expect(r.markdown).toMatch(/truncated/i)
  })

  it("does not truncate when content fits under the cap", async () => {
    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "Short",
      markdown: "Just a brief article.",
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "https://example.com" },
      ctx,
    )) as Extract<WebFetchResult, { ok: true }>
    expect(r.truncated).toBe(false)
    expect(r.markdown).toBe("Just a brief article.")
  })

  it("full:true uses the bigger cap", async () => {
    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "Big",
      markdown: "x".repeat(50_000),
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "https://example.com", full: true },
      ctx,
    )) as Extract<WebFetchResult, { ok: true }>
    // 50k < 80k cap → not truncated
    expect(r.truncated).toBe(false)
  })
})

describe("web_fetch — input validation", () => {
  it("rejects file:// scheme", async () => {
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "file:///etc/passwd" },
      ctx,
    )) as Extract<WebFetchResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/scheme/)
  })

  it("rejects javascript: scheme", async () => {
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "javascript:alert(1)" },
      ctx,
    )) as Extract<WebFetchResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("rejects unparseable URL", async () => {
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "not a url" },
      ctx,
    )) as Extract<WebFetchResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("rejects empty URL", async () => {
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "" },
      ctx,
    )) as Extract<WebFetchResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })
})

describe("web_fetch — blocked targets", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://localhost/foo",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",  // AWS metadata
    "http://172.16.0.1/",
    "http://my-host.internal/",
    "http://something.local/",
  ])("blocks %s", async (url) => {
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url },
      ctx,
    )) as Extract<WebFetchResult, { error: "blocked_target" }>
    expect(r.error).toBe("blocked_target")
    expect(vi.mocked(fetchAndExtract)).not.toHaveBeenCalled()
  })

  it("allows public hosts", async () => {
    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "ok",
      markdown: "body",
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "https://example.com" },
      ctx,
    )) as Extract<WebFetchResult, { ok: true }>
    expect(r.ok).toBe(true)
  })

  it("blocks 172.31.x but allows 172.32.x (range boundary)", async () => {
    const ctx = mockCtx()
    const blocked = (await webFetchTool.execute(
      { url: "http://172.31.255.255/" },
      ctx,
    )) as { error: string }
    expect(blocked.error).toBe("blocked_target")

    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "http://172.32.0.1",
      finalUrl: "http://172.32.0.1",
      title: "ok",
      markdown: "body",
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })
    const allowed = (await webFetchTool.execute(
      { url: "http://172.32.0.1/" },
      ctx,
    )) as Extract<WebFetchResult, { ok: true }>
    expect(allowed.ok).toBe(true)
  })
})

describe("web_fetch — error envelope", () => {
  it("fetch_failed when fetchAndExtract throws", async () => {
    vi.mocked(fetchAndExtract).mockRejectedValueOnce(new Error("HTTP 503"))
    const ctx = mockCtx()
    const r = (await webFetchTool.execute(
      { url: "https://example.com" },
      ctx,
    )) as Extract<WebFetchResult, { error: "fetch_failed" }>
    expect(r.error).toBe("fetch_failed")
    expect(r.detail).toMatch(/503/)
  })

  it("throws on aborted signal", async () => {
    const ctx = mockCtx({ aborted: true })
    await expect(
      webFetchTool.execute({ url: "https://example.com" }, ctx),
    ).rejects.toThrow(/aborted/)
  })
})
