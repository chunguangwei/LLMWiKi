import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isFetchNetworkError, streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

/* ─────────────────────────────────────────────────────────────────
 * Mocks: getHttpFetch returns a controllable queued fetch.
 * Same pattern as agent-llm.test.ts; lives here to test the
 * streaming layer's 429 retry independently.
 * ─────────────────────────────────────────────────────────────────*/

interface QueuedResponse {
  status: number
  /** Body returned as-is. For 200 we pass an OpenAI-style streaming
   *  body terminated with [DONE]; for 429/500 a short text body is
   *  enough since the code reads it via response.text(). */
  body: string
  contentType?: string
}

let fetchCalls: number = 0
let responseQueue: QueuedResponse[] = []

function streamingOkBody(token: string): string {
  // Minimal OpenAI-compatible SSE: one delta then [DONE].
  return (
    `data: {"choices":[{"delta":{"content":"${token}"},"index":0}]}\n\n` +
    `data: [DONE]\n\n`
  )
}

// We mock ONLY getHttpFetch so streamChat takes a controlled response.
// Other tauri-fetch exports (notably isFetchNetworkError) keep their
// real implementations — `isFetchNetworkError — cross-webview ...`
// tests below depend on it.
vi.mock("@/lib/tauri-fetch", async () => {
  const actual = await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch")
  return {
    ...actual,
    getHttpFetch: async () =>
      async (_url: string, _init: RequestInit): Promise<Response> => {
        fetchCalls += 1
        const next = responseQueue.shift()
        if (!next) {
          throw new Error("mock fetch: no queued response")
        }
        return new Response(next.body, {
          status: next.status,
          statusText: next.status === 200 ? "OK" : `HTTP ${next.status}`,
          headers: {
            "Content-Type": next.contentType ?? "text/event-stream",
          },
        })
      },
  }
})

/**
 * Guards for cross-webview error detection. Tauri renders the frontend
 * with WebKit on macOS/Linux and Edge WebView2 (Chromium) on Windows,
 * and each backend phrases fetch failures differently. These tests pin
 * down that every real-world error shape gets classified as a network
 * error so the user sees a helpful message instead of a raw stack.
 */
describe("isFetchNetworkError — cross-webview fetch failures", () => {
  it("recognises WebKit's 'Load failed' (macOS / Linux GTK)", () => {
    const e = new Error("Load failed")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises Chromium/Edge's TypeError: Failed to fetch (Windows)", () => {
    // Real Chromium throws a TypeError with this exact shape.
    const e = new TypeError("Failed to fetch")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises any TypeError (Chromium fetch failure class)", () => {
    // Chromium also throws TypeError with messages like "NetworkError
    // when attempting to fetch resource." — the name alone is enough.
    const e = new TypeError("NetworkError when attempting to fetch resource.")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises messages containing 'network error' (mid-stream drops)", () => {
    const e = new Error("The network error occurred while reading")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("rejects AbortError (user cancelled)", () => {
    const e = new Error("The operation was aborted.")
    e.name = "AbortError"
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects plain application errors (HTTP 4xx surfaced as Error)", () => {
    const e = new Error("HTTP 401: Unauthorized")
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects non-Error values (strings, null, objects)", () => {
    expect(isFetchNetworkError("boom")).toBe(false)
    expect(isFetchNetworkError(null)).toBe(false)
    expect(isFetchNetworkError(undefined)).toBe(false)
    expect(isFetchNetworkError({ message: "Load failed" })).toBe(false)
  })
})

/* ─────────────────────────────────────────────────────────────────
 * streamChat — 429 retry / backoff
 * (Mirrors postJson's tests in agent-llm.test.ts but for the
 *  streaming path used by chat / autoIngest / wikify / semantic.)
 * ─────────────────────────────────────────────────────────────────*/

describe("streamChat — rate-limit retry", () => {
  beforeEach(() => {
    fetchCalls = 0
    responseQueue = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function openAiConfig(): LlmConfig {
    return {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
    }
  }

  it("retries on HTTP 429 and streams a successful response on the retry", async () => {
    responseQueue.push({ status: 429, body: "rate limited" })
    responseQueue.push({ status: 200, body: streamingOkBody("ok") })
    const tokens: string[] = []
    let done = false
    const promise = streamChat(
      openAiConfig(),
      [{ role: "user", content: "ping" }],
      {
        onToken: (t) => tokens.push(t),
        onDone: () => { done = true },
        onError: (e) => { throw e },
      },
    )
    await vi.advanceTimersByTimeAsync(6_000)  // past 5s backoff
    await promise
    expect(fetchCalls).toBe(2)
    expect(tokens.join("")).toContain("ok")
    expect(done).toBe(true)
  })

  it("gives up after 3 attempts and surfaces HTTP 429 via onError", async () => {
    responseQueue.push({ status: 429, body: "rate limited" })
    responseQueue.push({ status: 429, body: "rate limited" })
    responseQueue.push({ status: 429, body: "rate limited" })
    const errors: Error[] = []
    let done = false
    const promise = streamChat(
      openAiConfig(),
      [{ role: "user", content: "ping" }],
      {
        onToken: () => {},
        onDone: () => { done = true },
        onError: (e) => errors.push(e),
      },
    )
    // 5s + 15s of backoff before the 3rd attempt fires + surfaces.
    await vi.advanceTimersByTimeAsync(25_000)
    await promise
    expect(fetchCalls).toBe(3)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/HTTP 429/)
    expect(done).toBe(false)
  })

  it("does NOT retry on non-429 errors (e.g. 500)", async () => {
    responseQueue.push({ status: 500, body: "internal error" })
    const errors: Error[] = []
    await streamChat(
      openAiConfig(),
      [{ role: "user", content: "ping" }],
      {
        onToken: () => {},
        onDone: () => {},
        onError: (e) => errors.push(e),
      },
    )
    expect(fetchCalls).toBe(1)
    expect(errors[0].message).toMatch(/HTTP 500/)
  })
})
