import { describe, expect, it } from "vitest"
import {
  isRateLimitError,
  rateLimitBackoffMs,
  sleepRespectingAbort,
} from "./rate-limit"

describe("isRateLimitError", () => {
  it("detects the Anthropic HTTP 429 string from postJson", () => {
    const err = new Error(
      'agent LLM call failed: HTTP 429 Too Many Requests — {"type":"error","error":{"type":"rate_limit_error"}}',
    )
    expect(isRateLimitError(err)).toBe(true)
  })

  it("detects 'rate_limit_exceeded' (OpenAI-style)", () => {
    expect(isRateLimitError(new Error("openai: rate_limit_exceeded"))).toBe(true)
    expect(isRateLimitError(new Error("rate-limit-exceeded"))).toBe(true)
    expect(isRateLimitError(new Error("rate limit hit"))).toBe(true)
  })

  it("detects bilingual Chinese reseller phrasings", () => {
    expect(isRateLimitError(new Error("当前请求量较高，请稍后重试"))).toBe(true)
    expect(isRateLimitError(new Error("超过当前套餐的并发限制"))).toBe(true)
  })

  it("does NOT flag unrelated errors as rate-limit", () => {
    expect(isRateLimitError(new Error("schema mismatch in tool result"))).toBe(false)
    expect(isRateLimitError(new Error("HTTP 500 Internal Server Error"))).toBe(false)
    expect(isRateLimitError(new Error("AbortError"))).toBe(false)
    expect(isRateLimitError(new Error("network timeout"))).toBe(false)
  })

  it("handles non-Error inputs without throwing", () => {
    expect(isRateLimitError("just a string")).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
    // String("HTTP 429 issue") → "HTTP 429 issue" matches.
    expect(isRateLimitError("HTTP 429 issue")).toBe(true)
  })
})

describe("rateLimitBackoffMs", () => {
  it("returns 5s, 15s, 30s for attempts 1..3", () => {
    expect(rateLimitBackoffMs(1)).toBe(5_000)
    expect(rateLimitBackoffMs(2)).toBe(15_000)
    expect(rateLimitBackoffMs(3)).toBe(30_000)
  })

  it("caps at 30s for further attempts", () => {
    expect(rateLimitBackoffMs(4)).toBe(30_000)
    expect(rateLimitBackoffMs(100)).toBe(30_000)
  })
})

describe("sleepRespectingAbort", () => {
  it("returns early when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await sleepRespectingAbort(5_000, controller.signal)
    expect(Date.now() - start).toBeLessThan(500)  // not anywhere near 5s
  })

  it("returns after the requested duration when not aborted", async () => {
    const start = Date.now()
    await sleepRespectingAbort(300)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(800)  // generous upper for CI jitter
  })
})
