import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  AnthropicAgentLlm,
  OpenAiAgentLlm,
  createAgentLlm,
} from "./agent-llm"
import type {
  AgentMessage,
  ToolSchema,
  AssistantTurn,
} from "./llm-interface"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Stub the Tauri plugin-http fetch the adapter uses. Captures every
 * call's URL + headers + body so tests can assert what got sent;
 * returns whatever Response the test queues up.
 */
type FetchCall = {
  url: string
  init: RequestInit
}

let calls: FetchCall[] = []
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

function queueResponse(body: unknown, status = 200) {
  nextResponse = { status, body }
}

vi.mock("@/lib/tauri-fetch", () => ({
  isFetchNetworkError: () => false,
  getHttpFetch: async () =>
    async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      const r = nextResponse
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        statusText: r.status === 200 ? "OK" : "Error",
        headers: { "Content-Type": "application/json" },
      })
    },
}))

beforeEach(() => {
  calls = []
  nextResponse = { status: 200, body: {} }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const TOOLS: ToolSchema[] = [
  {
    name: "read_outline",
    description: "Get the outline.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "done",
    description: "Stop.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
]

function baseAnthropicConfig(): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-test",
    model: "claude-haiku-4-5-20251001",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 200_000,
  }
}

function baseOpenAiConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128_000,
  }
}

/* ────────────────────────────────────────────────
 * AnthropicAgentLlm
 * ────────────────────────────────────────────────*/

describe("AnthropicAgentLlm — request shape", () => {
  it("posts to /v1/messages with model + messages + tools + system", async () => {
    queueResponse({
      content: [{ type: "tool_use", id: "u1", name: "done", input: { reason: "ok" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    })
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    const messages: AgentMessage[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Process source." },
    ]
    await llm.chat(messages, TOOLS, new AbortController().signal)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages")
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe("claude-haiku-4-5-20251001")
    expect(body.system).toBe("You are an agent.")
    expect(body.tools).toHaveLength(2)
    expect(body.tools[0]).toEqual({
      name: "read_outline",
      description: "Get the outline.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    })
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Process source." }],
    })
  })

  it("sends x-api-key + anthropic-version for Anthropic native", async () => {
    queueResponse({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    await llm.chat(
      [{ role: "user", content: "x" }],
      TOOLS,
      new AbortController().signal,
    )
    const h = calls[0].init.headers as Record<string, string>
    expect(h["x-api-key"]).toBe("sk-test")
    expect(h["anthropic-version"]).toBe("2023-06-01")
    expect(h.Authorization).toBeUndefined()
  })

  it("sends Bearer for MiniMax (gateway needs Bearer, not x-api-key)", async () => {
    queueResponse({ content: [], stop_reason: "end_turn", usage: {} })
    const cfg: LlmConfig = {
      ...baseAnthropicConfig(),
      provider: "minimax",
      customEndpoint: "https://api.minimaxi.com/anthropic",
    }
    const llm = new AnthropicAgentLlm(cfg)
    await llm.chat([{ role: "user", content: "x" }], TOOLS, new AbortController().signal)
    const h = calls[0].init.headers as Record<string, string>
    expect(h.Authorization).toBe("Bearer sk-test")
    expect(h["x-api-key"]).toBeUndefined()
  })

  it("threads assistant tool_use + user tool_result blocks back into messages", async () => {
    queueResponse({
      content: [],
      stop_reason: "end_turn",
      usage: {},
    })
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    const messages: AgentMessage[] = [
      { role: "user", content: "Go." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading…" },
          { type: "tool_use", id: "u1", name: "read_outline", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u1", content: '{"headings":[]}' },
        ],
      },
    ]
    await llm.chat(messages, TOOLS, new AbortController().signal)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading…" },
        { type: "tool_use", id: "u1", name: "read_outline", input: {} },
      ],
    })
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "u1", content: '{"headings":[]}' },
      ],
    })
  })
})

describe("AnthropicAgentLlm — response parse", () => {
  it("parses tool_use blocks + stop_reason + usage", async () => {
    queueResponse({
      content: [
        { type: "text", text: "Planning…" },
        { type: "tool_use", id: "u1", name: "done", input: { reason: "ok" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 30 },
    })
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    const turn = await llm.chat(
      [{ role: "user", content: "x" }],
      TOOLS,
      new AbortController().signal,
    )
    expect(turn.content).toEqual([
      { type: "text", text: "Planning…" },
      { type: "tool_use", id: "u1", name: "done", input: { reason: "ok" } },
    ])
    expect(turn.stop_reason).toBe("tool_use")
    expect(turn.usage).toEqual({ input_tokens: 120, output_tokens: 30 })
  })

  it("maps Anthropic stop_reason values to our union", async () => {
    const cases: Array<[string | undefined, AssistantTurn["stop_reason"]]> = [
      ["end_turn", "end_turn"],
      ["tool_use", "tool_use"],
      ["max_tokens", "max_tokens"],
      ["stop_sequence", "stop_sequence"],
      [undefined, "end_turn"],
      ["something_new", "end_turn"],
    ]
    for (const [raw, expected] of cases) {
      queueResponse({
        content: [],
        stop_reason: raw,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const llm = new AnthropicAgentLlm(baseAnthropicConfig())
      const turn = await llm.chat(
        [{ role: "user", content: "x" }],
        TOOLS,
        new AbortController().signal,
      )
      expect(turn.stop_reason).toBe(expected)
    }
  })

  it("skips unknown block types (Anthropic's reasoning blocks etc.)", async () => {
    queueResponse({
      content: [
        { type: "text", text: "kept" },
        { type: "thinking", text: "private reasoning" },
        { type: "tool_use", id: "u1", name: "done", input: { reason: "ok" } },
      ],
      stop_reason: "tool_use",
      usage: {},
    })
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    const turn = await llm.chat(
      [{ role: "user", content: "x" }],
      TOOLS,
      new AbortController().signal,
    )
    expect(turn.content).toHaveLength(2)
    expect(turn.content[0]).toEqual({ type: "text", text: "kept" })
  })

  it("throws on HTTP non-2xx with body prefix in the message", async () => {
    queueResponse({ error: { message: "bad request" } }, 400)
    const llm = new AnthropicAgentLlm(baseAnthropicConfig())
    await expect(
      llm.chat([{ role: "user", content: "x" }], TOOLS, new AbortController().signal),
    ).rejects.toThrow(/HTTP 400/)
  })
})

/* ────────────────────────────────────────────────
 * OpenAiAgentLlm
 * ────────────────────────────────────────────────*/

describe("OpenAiAgentLlm — request shape", () => {
  it("posts to /v1/chat/completions with messages + tools (function format)", async () => {
    queueResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    })
    const llm = new OpenAiAgentLlm(baseOpenAiConfig())
    await llm.chat(
      [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Process source." },
      ],
      TOOLS,
      new AbortController().signal,
    )
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions")
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe("gpt-4o-mini")
    expect(body.tools).toHaveLength(2)
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "read_outline",
        description: "Get the outline.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    })
    expect(body.messages[0]).toEqual({ role: "system", content: "You are an agent." })
  })

  it("converts assistant tool_use blocks → tool_calls array", async () => {
    queueResponse({
      choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "stop" }],
      usage: {},
    })
    const llm = new OpenAiAgentLlm(baseOpenAiConfig())
    await llm.chat(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "u1", name: "read_outline", input: { x: 1 } },
          ],
        },
      ],
      TOOLS,
      new AbortController().signal,
    )
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "Reading.",
      tool_calls: [
        {
          id: "u1",
          type: "function",
          function: { name: "read_outline", arguments: '{"x":1}' },
        },
      ],
    })
  })

  it("converts user tool_result blocks → role:'tool' messages", async () => {
    queueResponse({
      choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "stop" }],
      usage: {},
    })
    const llm = new OpenAiAgentLlm(baseOpenAiConfig())
    await llm.chat(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "read_outline", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "u1", content: '{"headings":[]}' },
          ],
        },
      ],
      TOOLS,
      new AbortController().signal,
    )
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "u1",
      content: '{"headings":[]}',
    })
  })

  it("uses max_completion_tokens for o-series / gpt-5 models, strips temperature", async () => {
    queueResponse({
      choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "stop" }],
      usage: {},
    })
    const cfg: LlmConfig = { ...baseOpenAiConfig(), model: "o3-mini" }
    const llm = new OpenAiAgentLlm(cfg)
    await llm.chat([{ role: "user", content: "x" }], TOOLS, new AbortController().signal)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it("Azure v1 endpoint → max_completion_tokens + URL preserved", async () => {
    queueResponse({
      choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "stop" }],
      usage: {},
    })
    const cfg: LlmConfig = {
      ...baseOpenAiConfig(),
      provider: "custom",
      customEndpoint: "https://my-res.openai.azure.com/openai/v1",
      apiMode: "chat_completions",
      apiKey: "azure-key",
    }
    const llm = new OpenAiAgentLlm(cfg)
    await llm.chat([{ role: "user", content: "x" }], TOOLS, new AbortController().signal)
    expect(calls[0].url).toBe("https://my-res.openai.azure.com/openai/v1/chat/completions")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers["api-key"]).toBe("azure-key")
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.max_completion_tokens).toBeDefined()
    expect(body.max_tokens).toBeUndefined()
  })
})

describe("OpenAiAgentLlm — response parse", () => {
  it("parses tool_calls back into ToolUseBlock with parsed input", async () => {
    queueResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Planning…",
            tool_calls: [
              {
                id: "u1",
                type: "function",
                function: { name: "done", arguments: '{"reason":"ok"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
    const llm = new OpenAiAgentLlm(baseOpenAiConfig())
    const turn = await llm.chat(
      [{ role: "user", content: "x" }],
      TOOLS,
      new AbortController().signal,
    )
    expect(turn.content).toEqual([
      { type: "text", text: "Planning…" },
      { type: "tool_use", id: "u1", name: "done", input: { reason: "ok" } },
    ])
    expect(turn.stop_reason).toBe("tool_use")
    expect(turn.usage).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  it("treats malformed JSON arguments as empty object (tool layer flags missing fields)", async () => {
    queueResponse({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "u1",
                type: "function",
                function: { name: "done", arguments: "not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {},
    })
    const llm = new OpenAiAgentLlm(baseOpenAiConfig())
    const turn = await llm.chat(
      [{ role: "user", content: "x" }],
      TOOLS,
      new AbortController().signal,
    )
    const block = turn.content[0]
    expect(block).toEqual({ type: "tool_use", id: "u1", name: "done", input: {} })
  })

  it("maps finish_reason values", async () => {
    const cases: Array<[string | undefined, AssistantTurn["stop_reason"]]> = [
      ["stop", "end_turn"],
      ["tool_calls", "tool_use"],
      ["length", "max_tokens"],
      [undefined, "end_turn"],
      ["something_new", "end_turn"],
    ]
    for (const [raw, expected] of cases) {
      queueResponse({
        choices: [{ message: { content: "", tool_calls: [] }, finish_reason: raw }],
        usage: {},
      })
      const llm = new OpenAiAgentLlm(baseOpenAiConfig())
      const turn = await llm.chat(
        [{ role: "user", content: "x" }],
        TOOLS,
        new AbortController().signal,
      )
      expect(turn.stop_reason).toBe(expected)
    }
  })
})

/* ────────────────────────────────────────────────
 * createAgentLlm factory
 * ────────────────────────────────────────────────*/

describe("createAgentLlm — provider dispatch", () => {
  it.each([
    ["anthropic", baseAnthropicConfig(), "AnthropicAgentLlm"],
    ["minimax", { ...baseAnthropicConfig(), provider: "minimax" as const }, "AnthropicAgentLlm"],
    [
      "custom + anthropic_messages",
      { ...baseAnthropicConfig(), provider: "custom" as const, apiMode: "anthropic_messages" as const, customEndpoint: "https://x.example.com/anthropic" },
      "AnthropicAgentLlm",
    ],
    ["openai", baseOpenAiConfig(), "OpenAiAgentLlm"],
    [
      "azure",
      { ...baseOpenAiConfig(), provider: "azure" as const, customEndpoint: "https://r.openai.azure.com" },
      "OpenAiAgentLlm",
    ],
    [
      "ollama",
      { ...baseOpenAiConfig(), provider: "ollama" as const, ollamaUrl: "http://localhost:11434" },
      "OpenAiAgentLlm",
    ],
    [
      "custom + chat_completions",
      { ...baseOpenAiConfig(), provider: "custom" as const, apiMode: "chat_completions" as const, customEndpoint: "https://api.openai.com/v1" },
      "OpenAiAgentLlm",
    ],
  ])("%s → %s", (_label, cfg, expectedClass) => {
    const llm = createAgentLlm(cfg as LlmConfig)
    expect(llm.constructor.name).toBe(expectedClass)
  })

  it("throws for unsupported providers (google / claude-code / codex-cli)", () => {
    expect(() =>
      createAgentLlm({ ...baseOpenAiConfig(), provider: "google" } as LlmConfig),
    ).toThrow(/google/)
    expect(() =>
      createAgentLlm({ ...baseOpenAiConfig(), provider: "claude-code" } as LlmConfig),
    ).toThrow(/claude-code/)
  })
})
