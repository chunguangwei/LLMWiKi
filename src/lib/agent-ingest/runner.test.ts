import { describe, it, expect } from "vitest"
import { runAgentLoop } from "./runner"
import { ScriptedLlm, toolUseTurn, textTurn } from "./scripted-llm"
import { toolSchemasForLlm } from "./tool-schemas"
import { InMemoryCoverageTracker } from "./tracker"
import type {
  AgentContext,
  SourceChunk,
  OutlineHeading,
  WikiAccess,
} from "./types"
import type { AgentMessage } from "./llm-interface"

function buildCtx(opts: {
  chunks?: SourceChunk[]
  outline?: OutlineHeading[]
  aborted?: boolean
  wikiAccess?: Partial<WikiAccess>
}): AgentContext {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const chunks = new Map<string, SourceChunk>()
  for (const c of opts.chunks ?? []) chunks.set(c.chunk_id, c)
  return {
    chunks,
    outline: opts.outline ?? [],
    vectorIndex: { search: async () => [] },
    project: { id: "test", name: "test", path: "/tmp/test" },
    tracker: new InMemoryCoverageTracker("test", "h", opts.chunks?.length ?? 0),
    wikiAccess: {
      listPages: async () => [],
      readPage: async () => null,
      writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
      deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      ...opts.wikiAccess,
    },
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  }
}

const INIT_MESSAGES: AgentMessage[] = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "Process source X." },
]

describe("runner — basic loop", () => {
  it("calls done in one turn → stop_reason 'done_called'", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "trivial source" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("done_called")
    expect(result.turnsUsed).toBe(1)
    expect(ctx.tracker.isComplete()).toBe(true)
  })

  it("appends assistant + tool_result blocks to the transcript", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ id: "u1", name: "done", input: { reason: "ok" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    // initial 2 + assistant (tool_use) + user (tool_result) = 4
    expect(result.finalMessages).toHaveLength(4)
    const assistantMsg = result.finalMessages[2]
    if (assistantMsg.role !== "assistant") throw new Error("expected assistant")
    expect(assistantMsg.content[0]).toMatchObject({ type: "tool_use", name: "done" })
    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    expect(Array.isArray(userMsg.content)).toBe(true)
    const results = userMsg.content as Array<{ type: string; tool_use_id: string }>
    expect(results[0].type).toBe("tool_result")
    expect(results[0].tool_use_id).toBe("u1")
  })

  it("aggregates token usage across turns", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "done",
        input: { reason: "ok" },
        inputTokens: 350,
        outputTokens: 50,
      }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.tokensSpent).toBe(400)
  })
})

describe("runner — multi-turn", () => {
  it("threads multiple tool calls in sequence + stops on done", async () => {
    const ctx = buildCtx({
      chunks: [
        { chunk_id: "c0", line_range: [1, 10], content: "x" },
        { chunk_id: "c1", line_range: [11, 20], content: "y" },
      ],
      outline: [{ level: 1, text: "H1", line_start: 1, chunk_id: "c0" }],
    })
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "read_outline", input: {} }),
      toolUseTurn({ name: "read_chunk", input: { chunk_id: "c0" } }),
      toolUseTurn({ name: "mark_section_covered", input: { chunk_id: "c0", covered_by: [] } }),
      toolUseTurn({ name: "done", input: { reason: "done" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("done_called")
    expect(result.turnsUsed).toBe(4)
    expect(ctx.tracker.coveragePercent()).toBeCloseTo(0.5)
  })

  it("forwards each turn's complete history to the LLM", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "read_outline", input: {} }),
      toolUseTurn({ name: "done", input: { reason: "ok" } }),
    ])

    await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    // Turn 1 sees just the initial 2 messages.
    expect(llm.calls[0].messages).toHaveLength(2)
    // Turn 2 sees initial 2 + assistant(read_outline) + user(tool_result) = 4
    expect(llm.calls[1].messages).toHaveLength(4)
  })
})

describe("runner — done short-circuits its own batch", () => {
  it("skips tools that come after `done` in the same assistant turn", async () => {
    const ctx = buildCtx({
      chunks: [{ chunk_id: "c0", line_range: [1, 10], content: "x" }],
    })
    // Single assistant turn with THREE tool calls: a benign
    // mark_section_covered, then done, then a mark that should NOT run.
    const llm = new ScriptedLlm([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_section_covered",
            input: { chunk_id: "c0", covered_by: [] },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "done",
            input: { reason: "wrapping up" },
          },
          {
            type: "tool_use",
            id: "t3",
            // Bogus chunk id — if this ran, it would surface as
            // chunk_not_found. With the short-circuit, the runner
            // emits a "skipped" tool_result instead.
            name: "mark_section_covered",
            input: { chunk_id: "bogus", covered_by: [] },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("done_called")
    expect(ctx.tracker.isComplete()).toBe(true)

    const userMsg = result.finalMessages[result.finalMessages.length - 1]
    if (userMsg.role !== "user" || typeof userMsg.content === "string") {
      throw new Error("expected tool_result user turn")
    }
    const results = userMsg.content as Array<{
      type: string
      tool_use_id: string
      content: string
      is_error?: boolean
    }>
    expect(results).toHaveLength(3)
    // First two dispatched normally.
    expect(results[0].tool_use_id).toBe("t1")
    expect(JSON.parse(results[0].content)).toMatchObject({ ok: true })
    expect(results[1].tool_use_id).toBe("t2")
    expect(JSON.parse(results[1].content)).toMatchObject({ ok: true })
    // Third short-circuited with the skipped sentinel.
    expect(results[2].tool_use_id).toBe("t3")
    expect(results[2].is_error).toBe(true)
    expect(JSON.parse(results[2].content)).toMatchObject({
      error: "skipped",
    })
  })
})

describe("runner — implicit done", () => {
  it("stop_reason 'no_tools_called' when the LLM replies with text only", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([textTurn("I think I'm done.")])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("no_tools_called")
    // tracker NOT marked complete — only the `done` tool does that
    expect(ctx.tracker.isComplete()).toBe(false)
  })

  it("preserves the text reply in the transcript", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([textTurn("Implicit stop.")])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    const assistant = result.finalMessages[2]
    if (assistant.role !== "assistant") throw new Error("expected assistant")
    expect(assistant.content).toEqual([{ type: "text", text: "Implicit stop." }])
  })
})

describe("runner — tool dispatch errors", () => {
  it("unknown tool → invalid_tool error result (loop continues)", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ id: "u1", name: "ghost_tool", input: { foo: "bar" } }),
      toolUseTurn({ name: "done", input: { reason: "recovered" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("done_called")
    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    const results = userMsg.content as Array<{
      type: string
      tool_use_id: string
      content: string
      is_error?: boolean
    }>
    expect(results[0].is_error).toBe(true)
    const parsed = JSON.parse(results[0].content)
    expect(parsed.error).toBe("invalid_tool")
    expect(parsed.detail).toMatch(/ghost_tool/)
  })

  it("tool throw → runtime_error result (loop continues)", async () => {
    // Force a tool to throw by passing an aborted-but-recovering
    // signal pattern. Easier: use read_chunk with a context whose
    // chunks map throws on .get(). We use a custom wikiAccess that
    // throws to simulate a runtime error in an actual tool.
    const ctx = buildCtx({
      wikiAccess: {
        async listPages() {
          throw new Error("disk on fire")
        },
      },
    })
    const llm = new ScriptedLlm([
      toolUseTurn({ id: "u1", name: "list_wiki_pages", input: {} }),
      toolUseTurn({ name: "done", input: { reason: "recovered" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    const results = userMsg.content as Array<{
      type: string
      content: string
      is_error?: boolean
    }>
    expect(results[0].is_error).toBe(true)
    const parsed = JSON.parse(results[0].content)
    expect(parsed.error).toBe("runtime_error")
    expect(parsed.detail).toMatch(/disk on fire/)
    expect(result.stopReason).toBe("done_called")
  })

  it("tool error result → is_error=true in the tool_result block", async () => {
    const ctx = buildCtx({})  // no chunks → read_chunk will return chunk_not_found
    const llm = new ScriptedLlm([
      toolUseTurn({ id: "u1", name: "read_chunk", input: { chunk_id: "ghost" } }),
      toolUseTurn({ name: "done", input: { reason: "skipped" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    const results = userMsg.content as Array<{ is_error?: boolean; content: string }>
    expect(results[0].is_error).toBe(true)
    const parsed = JSON.parse(results[0].content)
    expect(parsed.error).toBe("chunk_not_found")
  })

  it("tool ok result → no is_error flag", async () => {
    const ctx = buildCtx({
      outline: [{ level: 1, text: "H1", line_start: 1, chunk_id: "c0" }],
    })
    const llm = new ScriptedLlm([
      toolUseTurn({ id: "u1", name: "read_outline", input: {} }),
      toolUseTurn({ name: "done", input: { reason: "ok" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    const results = userMsg.content as Array<{ is_error?: boolean }>
    expect(results[0].is_error).toBeUndefined()
  })

  it("multiple tool_use in one turn → all dispatch, results in order", async () => {
    const ctx = buildCtx({
      outline: [{ level: 1, text: "H1", line_start: 1, chunk_id: "c0" }],
    })
    const llm = new ScriptedLlm([
      {
        content: [
          { type: "tool_use", id: "u1", name: "read_outline", input: {} },
          { type: "tool_use", id: "u2", name: "list_wiki_pages", input: {} },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30 },
      },
      toolUseTurn({ name: "done", input: { reason: "ok" } }),
    ])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    const userMsg = result.finalMessages[3]
    if (userMsg.role !== "user") throw new Error("expected user")
    const results = userMsg.content as Array<{ tool_use_id: string }>
    expect(results).toHaveLength(2)
    expect(results[0].tool_use_id).toBe("u1")
    expect(results[1].tool_use_id).toBe("u2")
  })
})

describe("runner — budget", () => {
  it("max_turns hit → stop_reason 'max_turns'", async () => {
    const ctx = buildCtx({})
    // Endless script — every call asks for read_outline, never done.
    const llm = new ScriptedLlm((_messages, i) =>
      toolUseTurn({ name: "read_outline", input: {}, id: `u${i}` }),
    )

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
      maxTurns: 3,
    })

    expect(result.stopReason).toBe("max_turns")
    expect(result.turnsUsed).toBe(3)
  })

  it("max_tokens hit → stop_reason 'max_tokens'", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm((_messages, i) =>
      toolUseTurn({
        name: "read_outline",
        input: {},
        id: `u${i}`,
        inputTokens: 60,
        outputTokens: 0,
      }),
    )

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
      maxTokens: 100,
    })

    expect(result.stopReason).toBe("max_tokens")
    // Two turns (60 + 60 = 120 > 100) — guard at top of loop fires
    // before the 3rd attempt.
    expect(result.turnsUsed).toBe(2)
  })
})

describe("runner — abort", () => {
  it("pre-loop abort → stop_reason 'aborted' (no LLM calls)", async () => {
    const ctx = buildCtx({ aborted: true })
    const llm = new ScriptedLlm([toolUseTurn({ name: "done", input: { reason: "x" } })])

    const result = await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
    })

    expect(result.stopReason).toBe("aborted")
    expect(result.turnsUsed).toBe(0)
    expect(llm.calls).toHaveLength(0)
  })
})

describe("runner — onTurn hook", () => {
  it("fires once per turn with index", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "read_outline", input: {} }),
      toolUseTurn({ name: "done", input: { reason: "ok" } }),
    ])
    const seen: number[] = []

    await runAgentLoop({
      llm,
      ctx,
      initialMessages: INIT_MESSAGES,
      tools: toolSchemasForLlm(),
      onTurn: (_turn, idx) => seen.push(idx),
    })

    expect(seen).toEqual([0, 1])
  })
})

describe("ScriptedLlm — guard rails", () => {
  it("throws when the script is exhausted (test plan likely missed `done`)", async () => {
    const ctx = buildCtx({})
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "read_outline", input: {} }),
    ])

    await expect(
      runAgentLoop({
        llm,
        ctx,
        initialMessages: INIT_MESSAGES,
        tools: toolSchemasForLlm(),
      }),
    ).rejects.toThrow(/script exhausted/)
  })
})
