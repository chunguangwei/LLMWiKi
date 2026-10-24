/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }))

import { webSearch } from "./web-search"
import { fetchAndExtract } from "./web-fetch"
import { collectResearchSources } from "./deep-research"

beforeEach(() => {
  invokeMock.mockReset()
  fetchMock.mockReset()
})

describe("DeepSeek Search & Fetch", () => {
  it("resolves the stored provider key and delegates search to Rust", async () => {
    invokeMock.mockResolvedValueOnce([])
    await webSearch("知识管理", {
      provider: "deepseek",
      apiKey: "",
      providerConfigs: { deepseek: { apiKey: "deepseek-key" } },
    }, 8)

    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "知识管理",
      maxResults: 8,
      config: expect.objectContaining({ provider: "deepseek", apiKey: "deepseek-key" }),
    })
    await expect(webSearch("x", { provider: "deepseek", apiKey: "" })).rejects.toThrow("Add an API key")
  })

  it("returns native Markdown through the DeepSeek Fetch command", async () => {
    invokeMock.mockResolvedValueOnce({ title: "Article", markdown: "# Article\n\nNative Markdown" })
    const result = await fetchAndExtract("https://example.com/article", {
      searchConfig: { provider: "deepseek", apiKey: "deepseek-key" },
    })

    expect(invokeMock).toHaveBeenCalledWith("deepseek_fetch", {
      url: "https://example.com/article",
      config: expect.objectContaining({ provider: "deepseek", apiKey: "deepseek-key" }),
    })
    expect(result.markdown).toContain("Native Markdown")
    expect(result.contentType).toBe("text/markdown")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("adds fetched page content to Deep Research with a bounded budget", async () => {
    const search = vi.fn().mockResolvedValue([
      { title: "Source", url: "https://example.com/source", snippet: "summary", source: "example.com" },
    ])
    const fetchPage = vi.fn().mockResolvedValue({ markdown: "# Full page\n\nActual research content" })
    const collection = await collectResearchSources(
      ["research topic"],
      { provider: "deepseek", apiKey: "deepseek-key", deepResearchSource: "web" },
      "/project",
      { webSearch: search, anyTxtSearch: vi.fn(), fetchPage },
      { relevanceFilter: async (_queries, results) => results },
    )

    expect(fetchPage).toHaveBeenCalledWith("https://example.com/source", {
      searchConfig: expect.objectContaining({ provider: "deepseek", apiKey: "deepseek-key" }),
    })
    expect(collection.results[0].snippet).toContain("Actual research content")
  })

  it("keeps the search summary when an individual Fetch fails", async () => {
    const collection = await collectResearchSources(
      ["research topic"],
      { provider: "deepseek", apiKey: "deepseek-key", deepResearchSource: "web" },
      "/project",
      {
        webSearch: vi.fn().mockResolvedValue([
          { title: "Source", url: "https://example.com/source", snippet: "usable summary", source: "example.com" },
        ]),
        anyTxtSearch: vi.fn(),
        fetchPage: vi.fn().mockRejectedValue(new Error("404")),
      },
      { relevanceFilter: async (_queries, results) => results },
    )

    expect(collection.results[0].snippet).toBe("usable summary")
    expect(collection.errors).toEqual([])
  })
})
