import { describe, it, expect } from "vitest"
import {
  isCjkCharCode,
  estimateTokens,
  charsPerToken,
  tokensToChars,
  trimToTokenBudget,
} from "./token-estimate"

describe("isCjkCharCode", () => {
  it("recognizes ideographs, kana, hangul, fullwidth; rejects Latin", () => {
    expect(isCjkCharCode("中".charCodeAt(0))).toBe(true)
    expect(isCjkCharCode("あ".charCodeAt(0))).toBe(true)
    expect(isCjkCharCode("한".charCodeAt(0))).toBe(true)
    expect(isCjkCharCode("１".charCodeAt(0))).toBe(true) // fullwidth digit
    expect(isCjkCharCode("A".charCodeAt(0))).toBe(false)
    expect(isCjkCharCode("1".charCodeAt(0))).toBe(false)
    expect(isCjkCharCode(" ".charCodeAt(0))).toBe(false)
  })
})

describe("estimateTokens", () => {
  it("is 0 for empty", () => {
    expect(estimateTokens("")).toBe(0)
  })

  it("counts CJK ~1 token/char", () => {
    // 10 ideographs → ~10 tokens.
    expect(estimateTokens("一二三四五六七八九十")).toBe(10)
  })

  it("counts Latin ~0.25 token/char (≈4 chars/token)", () => {
    // 100 ASCII chars → ~25 tokens.
    expect(estimateTokens("a".repeat(100))).toBe(25)
  })

  it("a CJK string estimates far more tokens than the same char count of Latin", () => {
    const cjk = estimateTokens("中".repeat(1000)) // ~1000 tokens
    const latin = estimateTokens("a".repeat(1000)) // ~250 tokens
    expect(cjk).toBeGreaterThan(latin * 3)
  })

  it("the core bug: a 200k-char source is over a 128k-token window in CJK but well under in English", () => {
    const window = 128_000
    expect(estimateTokens("中".repeat(200_000))).toBeGreaterThan(window) // ~200k tokens → overflow
    expect(estimateTokens("a".repeat(200_000))).toBeLessThan(window) // ~50k tokens → fits
  })
})

describe("charsPerToken / tokensToChars", () => {
  it("CJK ≈ 1 char/token, Latin ≈ 4 chars/token", () => {
    expect(charsPerToken("中".repeat(500))).toBeCloseTo(1, 1)
    expect(charsPerToken("a".repeat(500))).toBeCloseTo(4, 1)
  })

  it("tokensToChars uses the sample's script (more chars allowed for Latin)", () => {
    expect(tokensToChars(1000, "a".repeat(100))).toBeGreaterThan(tokensToChars(1000, "中".repeat(100)))
  })

  it("tokensToChars defaults to ~4 chars/token with no sample", () => {
    expect(tokensToChars(1000)).toBe(4000)
  })
})

describe("trimToTokenBudget", () => {
  it("returns text unchanged when it already fits", () => {
    const text = "short text"
    expect(trimToTokenBudget(text, 1000)).toBe(text)
  })

  it("trims CJK text to within the token budget (with marker)", () => {
    const text = "中".repeat(5000) // ~5000 tokens
    const out = trimToTokenBudget(text, 500)
    expect(estimateTokens(out)).toBeLessThanOrEqual(500)
    expect(out).toContain("trimmed for token budget")
  })

  it("trims Latin text to within the token budget", () => {
    const text = "word ".repeat(5000) // ~6250 tokens
    const out = trimToTokenBudget(text, 1000)
    expect(estimateTokens(out)).toBeLessThanOrEqual(1000)
  })

  it("keeps more Latin characters than CJK for the same token budget", () => {
    const latin = trimToTokenBudget("a".repeat(100_000), 1000)
    const cjk = trimToTokenBudget("中".repeat(100_000), 1000)
    expect(latin.length).toBeGreaterThan(cjk.length)
  })

  it("handles a non-positive budget", () => {
    expect(trimToTokenBudget("anything", 0)).toBe("")
  })

  it("stays under budget even when the kept prefix is denser than average", () => {
    // CJK-heavy head, Latin tail: a proportional cut by overall ratio would
    // over-keep, so the refine loop must shave further.
    const text = "中".repeat(2000) + "a".repeat(20000)
    const out = trimToTokenBudget(text, 300)
    expect(estimateTokens(out)).toBeLessThanOrEqual(300)
  })
})
