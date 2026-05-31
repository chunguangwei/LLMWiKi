import { describe, it, expect, vi, beforeEach } from "vitest"
import { wikifyForSave } from "./wikify"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))
import { streamChat } from "@/lib/llm-client"

const LLM_CONFIG: LlmConfig = {
  provider: "openai" as const,
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}

beforeEach(() => {
  vi.mocked(streamChat).mockReset()
})

/** Test helper that drives streamChat's callbacks with a canned output. */
function mockStreamChatToReturn(text: string) {
  vi.mocked(streamChat).mockImplementationOnce(async (_cfg, _msgs, cb) => {
    cb.onToken(text)
    cb.onDone()
  })
}

describe("wikifyForSave — happy path", () => {
  it("returns the LLM-cleaned content when the call succeeds", async () => {
    mockStreamChatToReturn(
      "## OpenClaw\n\nOpenClaw is a multi-modal AI platform.\n\n### Key features\n\n- Vision\n- Audio",
    )
    const input =
      "Based on the search results, here's a summary: I found that OpenClaw is a multi-modal AI platform with vision and audio features." +
      "\n\nLet me know if you need more detail."
    const out = await wikifyForSave(input, LLM_CONFIG)
    expect(out).toMatch(/## OpenClaw/)
    expect(out).not.toMatch(/Based on the search results/)
    expect(out).not.toMatch(/Let me know if you need more/)
  })

  it("passes the right system + user messages to streamChat", async () => {
    mockStreamChatToReturn("# Clean output")
    // Note: input must be > 100 chars AFTER trim() — wikifyForSave
    // bails before calling streamChat when content.trim().length is
    // below SKIP_BELOW_CHARS. padEnd with spaces doesn't help (trim
    // drops trailing whitespace), so repeat instead.
    const input = "Based on the article, X happened. Hope this helps! ".repeat(5)
    await wikifyForSave(input, LLM_CONFIG)
    const calls = vi.mocked(streamChat).mock.calls
    expect(calls).toHaveLength(1)
    const [_cfg, messages, _cb, _signal, overrides] = calls[0]
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toMatch(/REMOVE/)
    expect(messages[0].content).toMatch(/Based on/)  // system prompt cites the pattern
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toBe(input)
    expect(overrides?.temperature).toBe(0)
  })
})

describe("wikifyForSave — skip-too-short", () => {
  it("returns the input unchanged when shorter than SKIP_BELOW_CHARS", async () => {
    const tiny = "Yes."
    const out = await wikifyForSave(tiny, LLM_CONFIG)
    expect(out).toBe(tiny)
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled()
  })

  it("does the LLM call once content crosses the SKIP_BELOW_CHARS threshold", async () => {
    mockStreamChatToReturn("# cleaned")
    const input = "Based on the article, ".repeat(20)  // > 100 chars
    await wikifyForSave(input, LLM_CONFIG)
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1)
  })
})

describe("wikifyForSave — failure fallback", () => {
  it("returns the original content when the LLM call surfaces an error", async () => {
    vi.mocked(streamChat).mockImplementationOnce(async (_cfg, _msgs, cb) => {
      cb.onError(new Error("HTTP 429: rate limited"))
      cb.onDone()
    })
    const input = "Based on the article, X is interesting and Y happened.".repeat(4)
    const out = await wikifyForSave(input, LLM_CONFIG)
    expect(out).toBe(input)
  })

  it("returns the original content when streamChat throws synchronously", async () => {
    vi.mocked(streamChat).mockImplementationOnce(() => {
      throw new Error("network down")
    })
    const input = "Some chat content that is long enough to trigger wikify.".repeat(4)
    const out = await wikifyForSave(input, LLM_CONFIG)
    expect(out).toBe(input)
  })

  it("returns the original content when the LLM returns empty text", async () => {
    mockStreamChatToReturn("")
    const input = "A reasonably long chat reply that should be wikified.".repeat(4)
    const out = await wikifyForSave(input, LLM_CONFIG)
    expect(out).toBe(input)
  })

  it("returns the input when signal is already aborted (skips LLM call)", async () => {
    const c = new AbortController()
    c.abort()
    const input = "A reasonably long chat reply.".repeat(4)
    const out = await wikifyForSave(input, LLM_CONFIG, c.signal)
    expect(out).toBe(input)
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled()
  })
})

describe("wikifyForSave — preamble stripping", () => {
  it("strips a full-content code fence", async () => {
    mockStreamChatToReturn("```markdown\n# Title\n\nbody.\n```")
    const out = await wikifyForSave("Based on...".repeat(20), LLM_CONFIG)
    expect(out).toBe("# Title\n\nbody.")
  })

  it("strips a 'Here is the rewritten page:' preamble", async () => {
    mockStreamChatToReturn("Here's the rewritten page:\n\n# Title\n\nbody.")
    const out = await wikifyForSave("Based on...".repeat(20), LLM_CONFIG)
    expect(out).toBe("# Title\n\nbody.")
  })

  it("strips a Chinese '以下是改写后的页面' preamble", async () => {
    mockStreamChatToReturn("以下是改写后的页面:\n\n## 标题\n\n正文。")
    const out = await wikifyForSave("基于搜索结果...".repeat(20), LLM_CONFIG)
    expect(out).toBe("## 标题\n\n正文。")
  })
})
