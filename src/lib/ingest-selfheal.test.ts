import { describe, it, expect } from "vitest"
import {
  cjkRatio,
  splitTextInHalf,
  isContextOverflowError,
  isOverloadError,
} from "./ingest"

// Self-healing long-source helpers. Pure functions only — the bisection
// orchestration that consumes them lives in analyzeChunkResilient and is
// exercised end-to-end by the real-LLM suite. These guard the decisions
// that gate it: how CJK-heavy a source is, where to cut, and which
// provider errors are recoverable.

describe("cjkRatio", () => {
  it("is ~0 for pure ASCII and ~1 for pure Chinese", () => {
    expect(cjkRatio("The quick brown fox.")).toBeLessThan(0.05)
    expect(cjkRatio("司马光资治通鉴柏杨白话版")).toBeGreaterThan(0.95)
  })

  it("counts kana and hangul as CJK", () => {
    expect(cjkRatio("ひらがなカタカナ")).toBeGreaterThan(0.9)
    expect(cjkRatio("한국어텍스트")).toBeGreaterThan(0.9)
  })

  it("sits in between for mixed text", () => {
    const r = cjkRatio("Genghis 成吉思汗 conquered 蒙古 in 1206")
    expect(r).toBeGreaterThan(0.1)
    expect(r).toBeLessThan(0.6)
  })

  it("returns 0 for empty input", () => {
    expect(cjkRatio("")).toBe(0)
  })

  it("drives the CJK sizing scale below 1 for Chinese and ~1 for English", () => {
    // Mirrors the (1 - 0.5 * cjk) multiplier used for initial chunk sizing:
    // Chinese books get materially smaller chunks, English ones don't.
    const scale = (t: string) => 1 - 0.5 * cjkRatio(t)
    expect(scale("司马光资治通鉴柏杨白话版")).toBeLessThan(0.55)
    expect(scale("The quick brown fox jumped.")).toBeGreaterThan(0.95)
  })
})

describe("splitTextInHalf", () => {
  it("reconstructs the original exactly (no chars dropped or duplicated)", () => {
    const text = "a".repeat(500) + "\n\n" + "b".repeat(500)
    const [first, second] = splitTextInHalf(text)
    expect(first + second).toBe(text)
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBeGreaterThan(0)
  })

  it("prefers a paragraph break near the middle", () => {
    // Two roughly equal paragraphs: the blank-line boundary sits near the
    // midpoint, so the cut lands on it rather than mid-sentence.
    const text = "A".repeat(40) + "\n\n" + "B".repeat(40)
    const [first, second] = splitTextInHalf(text)
    expect(first.endsWith("\n")).toBe(true)
    expect(second.startsWith("B")).toBe(true)
    expect(first + second).toBe(text)
  })

  it("falls back to a sentence boundary when there's no newline", () => {
    const text = "句子一。句子二。句子三。句子四。句子五。"
    const [first, second] = splitTextInHalf(text)
    expect(first + second).toBe(text)
    // Cut after a full-width period, so the first half ends with one.
    expect(first.endsWith("。")).toBe(true)
  })

  it("still splits text with no boundaries at all", () => {
    const text = "x".repeat(101)
    const [first, second] = splitTextInHalf(text)
    expect(first + second).toBe(text)
    expect(first.length).toBe(50)
  })
})

describe("isContextOverflowError", () => {
  it("matches the provider's context-window rejection (incl. the reported one)", () => {
    expect(isContextOverflowError(new Error(
      'HTTP 400: Bad Request — {"message":"invalid params, context window exceeds limit (2013)"}',
    ))).toBe(true)
    expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(true)
    expect(isContextOverflowError(new Error("This model's maximum context length is 8192 tokens"))).toBe(true)
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true)
    expect(isContextOverflowError("上下文长度超出限制")).toBe(true)
  })

  it("does not match unrelated errors", () => {
    expect(isContextOverflowError(new Error("HTTP 401 Unauthorized"))).toBe(false)
    expect(isContextOverflowError(new Error("network timeout"))).toBe(false)
    expect(isContextOverflowError(new Error("HTTP 529 overloaded_error"))).toBe(false)
  })
})

describe("isOverloadError", () => {
  it("matches transient overload / rate-limit (incl. the reported 529)", () => {
    expect(isOverloadError(new Error(
      'HTTP 529: — {"type":"overloaded_error","message":"当前服务集群负载较高，请稍后重试 (2064) (529)"}',
    ))).toBe(true)
    expect(isOverloadError(new Error("HTTP 429 Too Many Requests"))).toBe(true)
    expect(isOverloadError(new Error("rate_limit_exceeded"))).toBe(true)
  })

  it("does not match context-overflow or auth errors", () => {
    expect(isOverloadError(new Error("context window exceeds limit"))).toBe(false)
    expect(isOverloadError(new Error("HTTP 400 invalid params"))).toBe(false)
    expect(isOverloadError(new Error("HTTP 401 Unauthorized"))).toBe(false)
  })
})
