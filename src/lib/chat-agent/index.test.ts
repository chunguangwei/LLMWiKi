/**
 * End-to-end smoke test for runChatAgent.
 *
 * Same pattern as agent-lint-fix's smoke test: mock @/commands/fs with
 * an in-memory FS, mock fetchAndExtract / webSearch for the web tools,
 * swap createAgentLlm for a ScriptedLlm, exercise runChatAgent across
 * the paths that matter:
 *
 *   - text-only reply (no tool calls)
 *   - LLM invokes web_fetch
 *   - web_search with NO configured provider → structured error to LLM
 *   - history is carried into the initial user prompt
 *   - abort signal propagates and reason is "aborted"
 *   - toolCalls array on the result reflects what the agent ran
 *
 * Smoke-only — does NOT exercise the real LLM, real network, or real
 * fs. The aim is "the pieces are wired together correctly" rather
 * than "the LLM picks good tools".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runChatAgent } from "./index"
import { ScriptedLlm, toolUseTurn, textTurn } from "@/lib/agent-ingest/scripted-llm"
import * as agentLlmModule from "@/lib/agent-ingest/agent-llm"
import type { DisplayMessage } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"
import type { SearchApiConfig } from "@/stores/wiki-store"

/* ──────────── in-memory fs mock ──────────── */
type FsState = {
  files: Map<string, string>
  tree: Map<string, FileNode[]>
}
let fs: FsState = { files: new Map(), tree: new Map() }
function setTree(d: string, t: FileNode[]) {
  fs.tree.set(d, t)
}

vi.mock("@/commands/fs", () => ({
  createDirectory: async () => {},
  deleteFile: async (p: string) => {
    fs.files.delete(p)
  },
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: file not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
  listDirectory: async (p: string) => {
    const t = fs.tree.get(p)
    if (!t) throw new Error(`mock fs: dir not in tree: ${p}`)
    return t
  },
}))

/* ──────────── web mocks ──────────── */
vi.mock("@/lib/web-fetch", () => ({
  fetchAndExtract: vi.fn(),
}))
vi.mock("@/lib/web-search", () => ({
  webSearch: vi.fn(),
  hasConfiguredSearchProvider: vi.fn(),
}))
import { fetchAndExtract } from "@/lib/web-fetch"
import { webSearch, hasConfiguredSearchProvider } from "@/lib/web-search"

beforeEach(() => {
  fs = { files: new Map(), tree: new Map() }
  vi.restoreAllMocks()
})

/* ──────────── fixtures ──────────── */
const PROJECT = { id: "p1", name: "Test", path: "/p" }
const LLM_CONFIG = {
  provider: "openai" as const,
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}
const SEARCH_API_NO_PROVIDER: SearchApiConfig = {
  provider: "none",
  apiKey: "",
  ollamaUrl: "",
  searXngUrl: "",
  searXngCategories: ["general"],
  serpApiEngine: "google",
}
const SEARCH_API_TAVILY: SearchApiConfig = {
  provider: "tavily",
  apiKey: "tvly-test",
  ollamaUrl: "",
  searXngUrl: "",
  searXngCategories: ["general"],
  serpApiEngine: "google",
}
const WIKI = "/p/wiki"

function setupEmptyProject() {
  // Empty wiki so list_wiki_pages returns []. purpose.md absent so the
  // prompt's project-purpose block stays empty.
  setTree(WIKI, [])
}

function emptyHistory(): DisplayMessage[] {
  return []
}

/* ──────────── tests ──────────── */

describe("runChatAgent — text-only reply", () => {
  it("returns the agent's text as result.text when no tools are called", async () => {
    setupEmptyProject()
    const llm = new ScriptedLlm([
      textTurn("Hi! I don't need any tools for this question."),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runChatAgent({
      userMessage: "Hello",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.text).toBe("Hi! I don't need any tools for this question.")
    expect(result.toolCalls).toEqual([])
    // humaniseStopReason for `no_tools_called` returns "Agent replied
    // without further tool calls." — pin a stable phrase from that
    // string.
    expect(result.reason).toMatch(/without further tool calls/i)
    expect(result.turnsUsed).toBe(1)
  })
})

describe("runChatAgent — web_fetch path", () => {
  it("forwards the fetched markdown into the toolCalls summary, returns final text", async () => {
    setupEmptyProject()
    vi.mocked(fetchAndExtract).mockResolvedValueOnce({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "Example article",
      markdown: "# Example\n\nBody from the fetched page.",
      contentType: "text/html",
      fetchedAt: "2026-05-30T12:00:00.000Z",
    })

    // The runner stops the loop as soon as a turn has no tool_use
    // blocks (text-only = implicit done). So if we want to test the
    // "text reply + done" combo we have to interleave them: put the
    // text in the SAME turn as done. toolUseTurn supports an optional
    // `text` field exactly for this.
    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "web_fetch",
        input: { url: "https://example.com/article" },
      }),
      toolUseTurn({
        name: "done",
        text: "Based on the fetched page: the body says X.",
        input: { reason: "answered from fetched page" },
      }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runChatAgent({
      userMessage: "Summarise https://example.com/article",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.text).toMatch(/based on the fetched page/i)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe("web_fetch")
    expect(result.toolCalls[0].inputSummary).toMatch(/example\.com/)
    expect(result.toolCalls[0].resultSummary).toMatch(/ok/)
    expect(result.toolCalls[1].name).toBe("done")
    expect(result.reason).toMatch(/done/i)
  })
})

describe("runChatAgent — web_search no-provider fallback", () => {
  it("returns no_provider_configured to the LLM when search isn't configured", async () => {
    setupEmptyProject()
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(false)

    const llm = new ScriptedLlm([
      toolUseTurn({ name: "web_search", input: { query: "what is X" } }),
      textTurn("I tried searching but search isn't configured."),
      toolUseTurn({
        name: "done",
        input: { reason: "no search provider; surfaced to user" },
      }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runChatAgent({
      userMessage: "Search the web for X",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      searchApiConfig: SEARCH_API_NO_PROVIDER,
    })

    const searchCall = result.toolCalls.find((c) => c.name === "web_search")
    expect(searchCall).toBeDefined()
    expect(searchCall!.resultSummary).toMatch(/no_provider_configured/)
    // webSearch impl must not have been invoked.
    expect(vi.mocked(webSearch)).not.toHaveBeenCalled()
  })
})

describe("runChatAgent — web_search with provider", () => {
  it("dispatches through webSearch and returns mapped results to the LLM", async () => {
    setupEmptyProject()
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    vi.mocked(webSearch).mockResolvedValueOnce([
      {
        title: "Result A",
        url: "https://a.example",
        snippet: "snippet a",
        source: "tavily",
      },
    ])

    const llm = new ScriptedLlm([
      toolUseTurn({ name: "web_search", input: { query: "what is X" } }),
      textTurn("Top result said: snippet a"),
      toolUseTurn({ name: "done", input: { reason: "answered" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runChatAgent({
      userMessage: "Look it up",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      searchApiConfig: SEARCH_API_TAVILY,
    })

    expect(vi.mocked(webSearch)).toHaveBeenCalledWith(
      "what is X",
      SEARCH_API_TAVILY,
      5,
    )
    expect(result.toolCalls[0].resultSummary).toMatch(/1 results/)
  })
})

describe("runChatAgent — history is threaded into the user prompt", () => {
  it("includes the last few exchanges in the LLM's initial user message", async () => {
    setupEmptyProject()
    const history: DisplayMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "I asked about FOO earlier.",
        timestamp: 1,
        conversationId: "c1",
      },
      {
        id: "m2",
        role: "assistant",
        content: "I answered with BAR.",
        timestamp: 2,
        conversationId: "c1",
      },
    ]
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "follow-up question",
      history,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const userMsg = llm.calls[0].messages.find((m) => m.role === "user")!
    if (typeof userMsg.content !== "string") {
      throw new Error("expected string user content")
    }
    expect(userMsg.content).toContain("Recent conversation")
    expect(userMsg.content).toContain("I asked about FOO earlier.")
    expect(userMsg.content).toContain("I answered with BAR.")
    expect(userMsg.content).toContain("follow-up question")
  })
})

describe("runChatAgent — system prompt rails", () => {
  it("includes Karpathy framing + tool calling rules + done stopping rule", async () => {
    setupEmptyProject()
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    expect(sys.content).toMatch(/wiki is your primary memory/i)
    expect(sys.content).toMatch(/list_wiki_pages/)
    expect(sys.content).toMatch(/search_wiki_by_title/)
    expect(sys.content).toMatch(/web_fetch/)
    expect(sys.content).toMatch(/cannot mutate the wiki/i)
    expect(sys.content).toMatch(/call `done`/)
  })

  it("adds the no-search-provider note only when hasConfiguredSearchProvider is false", async () => {
    setupEmptyProject()
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(false)
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      searchApiConfig: SEARCH_API_NO_PROVIDER,
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    expect(sys.content).toMatch(/has NOT configured a web-search provider/)
    // Backticks in the prompt around web_fetch — use a flexible match.
    expect(sys.content).toMatch(/web_fetch[^a-z]*with it/)
  })

  it("omits the no-search-provider note when a provider IS configured", async () => {
    setupEmptyProject()
    vi.mocked(hasConfiguredSearchProvider).mockReturnValue(true)
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      searchApiConfig: SEARCH_API_TAVILY,
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    expect(sys.content).not.toMatch(/has NOT configured/)
  })

  it("pins the answer language when outputLanguage is zh", async () => {
    setupEmptyProject()
    const llm = new ScriptedLlm([textTurn("好")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      outputLanguage: "zh",
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    expect(sys.content).toContain("以中文回答")
  })

  it("teaches the answer-first rule (substantive text before done, even when can't mutate)", async () => {
    // Real-LLM regression: when a user asked the agent to "write a
    // wiki page about X", the agent did 12 tool calls (search, fetch)
    // then called `done` with empty text — because the prompt said
    // "you can't mutate the wiki", the agent treated that as
    // "nothing to do". Strengthened both the mutation note and the
    // stopping rules to require substantive answer text even when
    // the side effect can't be performed.
    setupEmptyProject()
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    // The substantive-answer requirement is the key contract.
    expect(sys.content).toMatch(/answer the SUBSTANTIVE question/i)
    expect(sys.content).toMatch(/FAILURE mode/i)
    expect(sys.content).toMatch(/Save to Wiki/)
    // Specifically forbid the structured-block emission that routed
    // a real-LLM OpenClaw summary into the Review queue instead of
    // letting Save to Wiki own the path.
    expect(sys.content).toMatch(/DO NOT emit/i)
    expect(sys.content).toMatch(/---REVIEW/)
  })

  it("injects today's date so time-sensitive web searches use the current year", async () => {
    // Real-world prompt-tuning fix: without this, MiniMax-M2.7 generated
    // `query="OpenAI 2025"` while running on 2026-05-30 because the
    // model has no clock and falls back to the year in its training
    // data. The runtime entry point uses todayIsoDate() which calls
    // new Date() — this test only checks the section header + an
    // ISO-ish date appears, so the assertion stays stable across runs.
    setupEmptyProject()
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const sys = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof sys.content !== "string") throw new Error("expected string system")
    expect(sys.content).toMatch(/## Today/)
    expect(sys.content).toMatch(/Today is \d{4}-\d{2}-\d{2}\./)
    expect(sys.content).toMatch(/time-sensitive web_search queries/)
  })
})

describe("runChatAgent — chat tool catalogue", () => {
  it("exposes only the chat-agent tool subset (no source/mutation tools)", async () => {
    setupEmptyProject()
    const llm = new ScriptedLlm([textTurn("OK.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const toolNames = llm.calls[0].tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(
      [
        "list_wiki_pages",
        "read_wiki_page",
        "search_wiki_by_title",
        "web_fetch",
        "web_search",
        "search_local_files",
        "done",
      ].sort(),
    )
    // Explicitly NOT exposed: source-side + mutation tools.
    expect(toolNames).not.toContain("write_wiki_page")
    expect(toolNames).not.toContain("update_wiki_page")
    expect(toolNames).not.toContain("delete_wiki_page")
    expect(toolNames).not.toContain("read_outline")
    expect(toolNames).not.toContain("search_source")
  })
})

describe("runChatAgent — abort propagation", () => {
  it("propagates an already-aborted signal and returns reason=aborted", async () => {
    setupEmptyProject()
    const controller = new AbortController()
    controller.abort()
    const llm = new ScriptedLlm([textTurn("won't run")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runChatAgent({
      userMessage: "hi",
      history: emptyHistory(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      signal: controller.signal,
    })

    expect(result.reason).toMatch(/aborted/i)
    expect(llm.calls).toHaveLength(0)
  })
})
