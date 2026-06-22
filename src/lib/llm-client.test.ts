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
// Escape hatch for tests that need a custom Response-like object (e.g. a
// reader whose read() stays pending until the test rejects it). When set,
// the mock fetch returns it instead of building one from `responseQueue`.
let rawResponseQueue: Response[] = []
// Escape hatch for tests that need the fetch CALL ITSELF to reject (the
// pre-fetch catch path), e.g. the plugin's bare-string "Request cancelled".
let fetchRejectQueue: unknown[] = []

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
        if (fetchRejectQueue.length > 0) {
          return Promise.reject(fetchRejectQueue.shift())
        }
        const raw = rawResponseQueue.shift()
        if (raw) return raw
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

/* ─────────────────────────────────────────────────────────────────
 * streamChat — mid-stream abort mapping
 *
 * When the 30-min backstop fires mid-stream the Tauri HTTP plugin tears
 * the body stream down with a BARE STRING "Request cancelled"
 * (controller.error(string)), not an Error. The old guard only matched
 * `err instanceof Error`, so that string fell through to the generic
 * branch and surfaced verbatim — exactly the cryptic "request cancelled"
 * the dedup scan showed. These pin down that the string is now
 * recognized as an abort and mapped to the actionable timeout message
 * (or a silent cancel when no backstop fired).
 * (Ported from upstream 253771b + 11292ea, adapted to our queued mock.)
 * ─────────────────────────────────────────────────────────────────*/

const cancelCfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 8192,
}

/** A Response whose reader.read() stays pending until we reject it,
 *  letting the test interleave the 30-min backstop before the abort.
 *  `readCalled` resolves once streamChat reaches read(), so the test
 *  can await it instead of guessing how many microtasks to flush. */
function pendingStreamResponse(): {
  response: Response
  getReject: () => (e: unknown) => void
  readCalled: Promise<void>
} {
  let reject!: (e: unknown) => void
  let signalReadCalled!: () => void
  const readCalled = new Promise<void>((res) => {
    signalReadCalled = res
  })
  const reader = {
    read: () =>
      new Promise<never>((_resolve, rej) => {
        reject = rej
        signalReadCalled()
      }),
    releaseLock: () => {},
    cancel: () => {},
  }
  const response = {
    ok: true,
    body: { getReader: () => reader },
  } as unknown as Response
  return { response, getReject: () => reject, readCalled }
}

describe("streamChat — mid-stream abort mapping", () => {
  beforeEach(() => {
    fetchCalls = 0
    responseQueue = []
    rawResponseQueue = []
    fetchRejectQueue = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("maps the plugin's bare-string abort to the timeout message when the 30-min backstop fired", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    rawResponseQueue.push(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cancelCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    // Wait until streamChat is parked in read(), then fire the long-horizon
    // backstop and let the plugin error the stream with its bare string.
    await readCalled
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    getReject()("Request cancelled")
    await promise

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 30 min/)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("treats a bare-string abort as a silent cancel when the backstop did NOT fire", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    rawResponseQueue.push(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cancelCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    await readCalled
    getReject()("Request cancelled")
    await promise

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("recognises lowercase and single-l cancelled spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      const { response, getReject, readCalled } = pendingStreamResponse()
      rawResponseQueue.push(response)

      const onError = vi.fn()
      const onDone = vi.fn()
      const promise = streamChat(
        cancelCfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      await readCalled
      getReject()(message)
      await promise

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })

  it("treats pre-fetch bare-string cancel spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      fetchCalls = 0
      responseQueue = []
      rawResponseQueue = []
      // Make the very first fetch CALL reject with the bare string so the
      // pre-fetch catch (not the streaming catch) handles it.
      fetchRejectQueue = [message]

      const onError = vi.fn()
      const onDone = vi.fn()
      await streamChat(
        cancelCfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })
})
