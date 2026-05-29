import { describe, it, expect } from "vitest"
import { detectSearchTrigger, looksLikeSearchTrigger } from "./search-trigger"

describe("detectSearchTrigger", () => {
  it("recognizes /search slash command", () => {
    expect(detectSearchTrigger("/search Karpathy LLM OS")).toEqual({
      kind: "search",
      query: "Karpathy LLM OS",
    })
  })

  it("/search is case-insensitive", () => {
    expect(detectSearchTrigger("/Search foo")).toEqual({ kind: "search", query: "foo" })
    expect(detectSearchTrigger("/SEARCH bar")).toEqual({ kind: "search", query: "bar" })
  })

  it("recognizes English natural-language prefix", () => {
    expect(detectSearchTrigger("search transformer architecture")).toEqual({
      kind: "search",
      query: "transformer architecture",
    })
    expect(detectSearchTrigger("find latest GPT paper")).toEqual({
      kind: "search",
      query: "latest GPT paper",
    })
    expect(detectSearchTrigger("google Karpathy zero to hero")).toEqual({
      kind: "search",
      query: "Karpathy zero to hero",
    })
  })

  it("recognizes Chinese natural-language prefix", () => {
    expect(detectSearchTrigger("搜索 Transformer 论文")).toEqual({
      kind: "search",
      query: "Transformer 论文",
    })
    expect(detectSearchTrigger("搜 LLM OS")).toEqual({ kind: "search", query: "LLM OS" })
    expect(detectSearchTrigger("查找 ChatGPT 原理")).toEqual({
      kind: "search",
      query: "ChatGPT 原理",
    })
    expect(detectSearchTrigger("查询 注意力机制")).toEqual({
      kind: "search",
      query: "注意力机制",
    })
  })

  it("accepts Chinese full-width colon", () => {
    expect(detectSearchTrigger("搜索：注意力机制")).toEqual({
      kind: "search",
      query: "注意力机制",
    })
    expect(detectSearchTrigger("search: transformer")).toEqual({
      kind: "search",
      query: "transformer",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(detectSearchTrigger("  /search   hello world  ")).toEqual({
      kind: "search",
      query: "hello world",
    })
  })

  it("returns null when not a search trigger", () => {
    expect(detectSearchTrigger("hello world")).toBeNull()
    expect(detectSearchTrigger("写一段关于 LLM 的介绍")).toBeNull()
    expect(detectSearchTrigger("explain how transformers work")).toBeNull()
  })

  it("returns null for empty / whitespace input", () => {
    expect(detectSearchTrigger("")).toBeNull()
    expect(detectSearchTrigger("   ")).toBeNull()
  })

  it("returns null for trigger with empty query", () => {
    expect(detectSearchTrigger("/search")).toBeNull()
    expect(detectSearchTrigger("/search   ")).toBeNull()
    expect(detectSearchTrigger("搜索 ")).toBeNull()
  })

  it("does not match when prefix is a substring of another word", () => {
    // "research" starts with "search" but should not trigger
    expect(detectSearchTrigger("research the transformer paper")).toBeNull()
    // "搜罗" / "搜集" start with 搜 but the regex requires a separator
    expect(detectSearchTrigger("搜罗一些 LLM 资料")).toBeNull()
  })
})

describe("looksLikeSearchTrigger", () => {
  it("returns true even when query is empty (mid-edit hint)", () => {
    expect(looksLikeSearchTrigger("/search")).toBe(true)
    expect(looksLikeSearchTrigger("/search ")).toBe(true)
    expect(looksLikeSearchTrigger("搜索 ")).toBe(true)
    expect(looksLikeSearchTrigger("search ")).toBe(true)
  })

  it("returns false for plain messages", () => {
    expect(looksLikeSearchTrigger("hello")).toBe(false)
    expect(looksLikeSearchTrigger("research the X")).toBe(false)
    expect(looksLikeSearchTrigger("")).toBe(false)
  })
})
