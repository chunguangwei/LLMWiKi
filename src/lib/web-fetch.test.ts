// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"

const fetchMock = vi.fn()

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}))

import { extractUrls, fetchAndExtract, isLikelyUrl, slugFromTitle } from "./web-fetch"

beforeEach(() => {
  fetchMock.mockReset()
})

function htmlResponse(html: string, url = "https://example.com/article", status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => html,
  } as unknown as Response
}

function textResponse(body: string, url = "https://example.com/data.json", contentType = "application/json") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  } as unknown as Response
}

describe("extractUrls", () => {
  it("pulls https URLs out of plain text", () => {
    const urls = extractUrls("see https://example.com/foo and http://x.test/bar?q=1 thanks")
    expect(urls).toEqual(["https://example.com/foo", "http://x.test/bar?q=1"])
  })
  it("strips trailing punctuation that's almost certainly not part of the URL", () => {
    expect(extractUrls("read https://a.test/p.")).toEqual(["https://a.test/p"])
    expect(extractUrls("see (https://b.test/q)")).toEqual(["https://b.test/q"])
  })
  it("dedupes repeated URLs", () => {
    expect(extractUrls("https://x.test https://x.test")).toEqual(["https://x.test"])
  })
  it("returns empty for non-URL text", () => {
    expect(extractUrls("nothing to see here")).toEqual([])
  })
})

describe("isLikelyUrl", () => {
  it("accepts well-formed http(s) URLs", () => {
    expect(isLikelyUrl("https://example.com")).toBe(true)
    expect(isLikelyUrl("  http://x.test/y  ")).toBe(true)
  })
  it("rejects strings with whitespace or no scheme", () => {
    expect(isLikelyUrl("example.com")).toBe(false)
    expect(isLikelyUrl("https://a b.test")).toBe(false)
    expect(isLikelyUrl("just text")).toBe(false)
  })
})

describe("slugFromTitle", () => {
  it("kebab-cases ASCII titles and caps length", () => {
    expect(slugFromTitle("Retrieval-Augmented Generation: A Survey", "fallback")).toMatch(
      /^retrieval-augmented-generation-a-survey/,
    )
  })
  it("preserves CJK characters", () => {
    expect(slugFromTitle("检索增强生成 综述", "fallback")).toBe("检索增强生成-综述")
  })
  it("falls back when title is unusable", () => {
    expect(slugFromTitle("", "page")).toBe("page")
    expect(slugFromTitle("!!!", "fallback")).toBe("fallback")
  })
})

describe("fetchAndExtract", () => {
  it("extracts a Readability-friendly article into markdown", async () => {
    const html = `<!doctype html>
<html><head><title>Site Title</title></head><body>
<header><nav><a href="/">home</a></nav></header>
<article>
  <h1>RAG Overview</h1>
  <p>Retrieval augmented generation combines a retriever with a generator. ${"This is a fairly substantial paragraph that gives Readability enough content to consider this an article. ".repeat(8)}</p>
  <h2>Why it matters</h2>
  <p>${"Grounded answers tend to hallucinate less when a relevant snippet is in context. ".repeat(6)}</p>
</article>
<footer><p>footer junk</p></footer>
</body></html>`
    fetchMock.mockResolvedValueOnce(htmlResponse(html))
    const result = await fetchAndExtract("https://example.com/article")
    expect(result.url).toBe("https://example.com/article")
    expect(result.title).toMatch(/RAG Overview|Site Title/)
    expect(result.markdown).toContain("Retrieval augmented generation")
    expect(result.markdown).not.toContain("footer junk")
    expect(result.contentType).toContain("text/html")
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("falls back to body-to-markdown when Readability can't find an article", async () => {
    // Tiny page Readability will reject (too short / no <article> / no useful content)
    fetchMock.mockResolvedValueOnce(
      htmlResponse(`<html><head><title>Tiny</title></head><body><div>hi</div></body></html>`),
    )
    const result = await fetchAndExtract("https://x.test/tiny")
    expect(result.title).toBe("Tiny")
    expect(result.markdown).toContain("hi")
  })

  it("returns the raw body when content-type is not html", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(`{"k":"v"}`, "https://api.test/x.json"))
    const result = await fetchAndExtract("https://api.test/x.json")
    expect(result.contentType).toContain("json")
    expect(result.markdown).toBe(`{"k":"v"}`)
  })

  it("throws on non-2xx responses with status + url in the message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      url: "https://x.test/missing",
      headers: new Headers(),
      text: async () => "",
    } as unknown as Response)
    await expect(fetchAndExtract("https://x.test/missing")).rejects.toThrow(/404/)
  })

  it("sends a UA + Accept header so naive sites don't 403 the request", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(`<html><body></body></html>`))
    await fetchAndExtract("https://x.test/page")
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.headers?.["User-Agent"]).toMatch(/LLMWiki/)
    expect(init?.headers?.Accept).toContain("text/html")
  })
})
