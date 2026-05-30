import { describe, it, expect } from "vitest"
import { runVerifyPass } from "./verify"
import { InMemoryCoverageTracker } from "./tracker"
import type {
  AgentLlm,
  AgentMessage,
  AssistantTurn,
  ToolSchema,
  ChatOptions,
} from "./llm-interface"
import type {
  AgentContext,
  OutlineHeading,
  SourceChunk,
} from "./types"
import type { RunAgentLoopResult } from "./runner"

/* ────────────────────────────────────────────────
 * Mock AgentLlm — scripts the verifier's text reply
 * ────────────────────────────────────────────────*/

class StubVerifyLlm implements AgentLlm {
  readonly calls: Array<{
    messages: AgentMessage[]
    tools: ToolSchema[]
    options?: ChatOptions
  }> = []
  constructor(private readonly reply: string | (() => never)) {}
  async chat(
    messages: AgentMessage[],
    tools: ToolSchema[],
    _signal: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantTurn> {
    this.calls.push({
      messages: JSON.parse(JSON.stringify(messages)),
      tools: JSON.parse(JSON.stringify(tools)),
      options: options ? { ...options } : undefined,
    })
    if (typeof this.reply === "function") this.reply()  // throws
    return {
      content: [{ type: "text", text: this.reply as string }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    }
  }
}

/* ────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────*/

function buildCtx(opts: {
  chunks?: SourceChunk[]
} = {}): { ctx: AgentContext; tracker: InMemoryCoverageTracker } {
  const tracker = new InMemoryCoverageTracker("test", "h", opts.chunks?.length ?? 0)
  const chunkMap = new Map<string, SourceChunk>()
  for (const c of opts.chunks ?? []) chunkMap.set(c.chunk_id, c)
  const ctx: AgentContext = {
    chunks: chunkMap,
    outline: [],
    vectorIndex: { search: async () => [] },
    project: { id: "t", name: "t", path: "/p" },
    tracker,
    wikiAccess: {
      listPages: async () => [],
      readPage: async () => null,
      writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
      linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
    },
    llmConfig: {} as AgentContext["llmConfig"],
    signal: new AbortController().signal,
  }
  return { ctx, tracker }
}

const OUTLINE: OutlineHeading[] = [
  { level: 1, text: "Intro", line_start: 1, chunk_id: "c0" },
  { level: 2, text: "Section A", line_start: 5, chunk_id: "c0" },
  { level: 2, text: "Section B", line_start: 30, chunk_id: "c2" },
]
const CHUNKS: SourceChunk[] = [
  { chunk_id: "c0", line_range: [1, 10], content: "intro + A" },
  { chunk_id: "c2", line_range: [25, 40], content: "B body" },
]

function baseOpts(
  llm: AgentLlm,
  _tracker: InMemoryCoverageTracker,
  ctx: AgentContext,
  overrides: Partial<Parameters<typeof runVerifyPass>[0]> = {},
): Parameters<typeof runVerifyPass>[0] {
  return {
    llm,
    ctx,
    sourcePath: "/p/raw/sources/foo.md",
    outline: OUTLINE,
    pagesCreated: [{ slug: "concepts/intro", fromChunks: ["c0"] }],
    pagesUpdated: [],
    stopReason: "done_called" as RunAgentLoopResult["stopReason"],
    signal: new AbortController().signal,
    ...overrides,
    // ensure tracker is the one we return so tests can inspect gaps
    ...(overrides.ctx ? {} : { ctx }),
  }
}

void baseOpts  // hush the linter — used below per-test
void OUTLINE
void CHUNKS

/* ────────────────────────────────────────────────
 * Skip rules
 * ────────────────────────────────────────────────*/

describe("runVerifyPass — skip rules", () => {
  it("skips when stopReason is 'aborted'", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    const r = await runVerifyPass({
      ...baseOpts(llm, tracker, ctx),
      stopReason: "aborted",
    })
    expect(r.ran).toBe(false)
    expect(r.skipReason).toBe("aborted")
    expect(llm.calls).toHaveLength(0)
  })

  it("skips when stopReason is 'max_tokens'", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    const r = await runVerifyPass({
      ...baseOpts(llm, tracker, ctx),
      stopReason: "max_tokens",
    })
    expect(r.skipReason).toBe("budget")
  })

  it("skips when stopReason is 'max_turns'", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    const r = await runVerifyPass({
      ...baseOpts(llm, tracker, ctx),
      stopReason: "max_turns",
    })
    expect(r.skipReason).toBe("budget")
  })

  it("skips when outline is empty", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    const r = await runVerifyPass({
      ...baseOpts(llm, tracker, ctx),
      outline: [],
    })
    expect(r.skipReason).toBe("no_outline")
  })
})

/* ────────────────────────────────────────────────
 * Happy paths
 * ────────────────────────────────────────────────*/

describe("runVerifyPass — happy paths", () => {
  it("calls the LLM with no tools (verifier replies with text JSON)", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].tools).toEqual([])
    expect(llm.calls[0].options?.temperature).toBe(0)
  })

  it("user prompt includes source path + outline + pages list", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    await runVerifyPass(baseOpts(llm, tracker, ctx))
    const userMsg = llm.calls[0].messages.find((m) => m.role === "user")!
    const text = userMsg.content as string
    expect(text).toContain("/p/raw/sources/foo.md")
    expect(text).toContain("Source outline")
    expect(text).toContain("Section A")
    expect(text).toContain("Wiki pages the agent produced")
    expect(text).toContain("concepts/intro")
  })

  it("empty gaps reply → ran=true, gapsAdded=0, no tracker mutation", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[]}')
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.ran).toBe(true)
    expect(r.gapsAdded).toBe(0)
    expect(tracker.gaps()).toEqual([])
  })

  it("populated gaps → surfaceGap called for each; tracker reflects them", async () => {
    const { ctx, tracker } = buildCtx({ chunks: CHUNKS })
    const llm = new StubVerifyLlm(
      JSON.stringify({
        gaps: [
          {
            heading: "Section B",
            chunk_id: "c2",
            reason: "no page covers this section",
          },
          {
            heading: "Section A",
            chunk_id: "c0",
            reason: "page exists but is only a passing mention",
          },
        ],
      }),
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(2)
    const gaps = tracker.gaps()
    expect(gaps).toHaveLength(2)
    expect(gaps[0].topic).toBe("Section B")
    expect(gaps[0].reason).toContain("no page covers")
    expect(gaps[0].chunks).toEqual(["c2"])
  })

  it("drops gaps whose chunk_id isn't known (verifier hallucinated id)", async () => {
    const { ctx, tracker } = buildCtx({ chunks: CHUNKS })
    const llm = new StubVerifyLlm(
      JSON.stringify({
        gaps: [{ heading: "Real heading", chunk_id: "ghost", reason: "x" }],
      }),
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(1)
    // The gap still goes through — only the chunk anchor is dropped.
    const g = tracker.gaps()[0]
    expect("chunks" in g).toBe(false)
  })

  it("rawReply is the LLM's text verbatim", async () => {
    const { ctx, tracker } = buildCtx()
    const reply = '{"gaps":[{"heading":"X","reason":"y"}]}'
    const llm = new StubVerifyLlm(reply)
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.rawReply).toBe(reply)
  })
})

/* ────────────────────────────────────────────────
 * Reply parsing tolerance
 * ────────────────────────────────────────────────*/

describe("runVerifyPass — reply parsing", () => {
  it("strips a markdown json code fence", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(
      '```json\n{"gaps":[{"heading":"A","reason":"x"}]}\n```',
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(1)
  })

  it("strips a courteous preamble before the JSON", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(
      'Here is my verification:\n{"gaps":[{"heading":"A","reason":"x"}]}',
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(1)
  })

  it("accepts 'topic' as a synonym for 'heading' (LLM occasionally uses our field name)", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(
      '{"gaps":[{"topic":"Section X","reason":"y"}]}',
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(1)
    expect(tracker.gaps()[0].topic).toBe("Section X")
  })

  it("drops entries with missing heading/topic", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(
      '{"gaps":[{"reason":"orphan"},{"heading":"Ok","reason":"y"}]}',
    )
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(1)
  })

  it("returns gapsAdded=0 on malformed JSON (best-effort: don't crash)", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm("not json at all")
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.ran).toBe(true)
    expect(r.gapsAdded).toBe(0)
  })

  it("returns gapsAdded=0 when JSON shape lacks 'gaps' array", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"foo":"bar"}')
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.gapsAdded).toBe(0)
  })

  it("uses default reason when verifier omits one", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm('{"gaps":[{"heading":"X"}]}')
    await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(tracker.gaps()[0].reason).toMatch(/not covered/i)
  })
})

/* ────────────────────────────────────────────────
 * LLM error handling
 * ────────────────────────────────────────────────*/

describe("runVerifyPass — LLM errors", () => {
  it("LLM throw → ran=false, error_state, errorMessage captured", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(() => {
      throw new Error("network blew up")
    })
    const r = await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(r.ran).toBe(false)
    expect(r.skipReason).toBe("error_state")
    expect(r.errorMessage).toMatch(/network blew up/)
  })

  it("LLM error doesn't add gaps to tracker", async () => {
    const { ctx, tracker } = buildCtx()
    const llm = new StubVerifyLlm(() => {
      throw new Error("nope")
    })
    await runVerifyPass(baseOpts(llm, tracker, ctx))
    expect(tracker.gaps()).toEqual([])
  })
})
