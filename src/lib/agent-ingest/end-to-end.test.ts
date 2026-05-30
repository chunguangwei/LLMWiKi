/**
 * End-to-end agent-ingest smoke test.
 *
 * Mocks @/commands/fs with an in-memory FS so the entire pipeline
 * runs without Tauri / Rust / disk — same approach as
 * wiki-access.test.ts. The LLM is replaced by ScriptedLlm so we
 * test the WIRING (preprocess + index + tools + tracker + runner +
 * result aggregation) rather than the agent's reasoning.
 *
 * Critically: we exercise `runAgentIngest()` directly. If the
 * end-to-end smoke passes, individual modules are wired correctly
 * for Phase D's UI integration.
 *
 * NOT covered here (deliberate scope):
 *   - Real LLM tool calling — agent-llm.test.ts mocks fetch at
 *     that layer; here we plug a ScriptedLlm above it.
 *   - Checkpoint persistence — Phase E.
 *   - Verify pass — Phase E.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runAgentIngest } from "./index"
import { ScriptedLlm, toolUseTurn, textTurn } from "./scripted-llm"
import * as agentLlmModule from "./agent-llm"
import type { FileNode } from "@/types/wiki"

/* ──────────── in-memory fs mock ──────────── */
type FsState = {
  files: Map<string, string>
  tree: Map<string, FileNode[]>
}
let fs: FsState = { files: new Map(), tree: new Map() }
function setFile(p: string, c: string) {
  fs.files.set(p, c)
}
function setTree(d: string, t: FileNode[]) {
  fs.tree.set(d, t)
}

vi.mock("@/commands/fs", () => ({
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

beforeEach(() => {
  fs = { files: new Map(), tree: new Map() }
  vi.restoreAllMocks()
})

const PROJECT = {
  id: "test",
  name: "Test Project",
  path: "/p",
}
const SOURCE_PATH = "/p/raw/sources/intro.md"
const LLM_CONFIG = {
  provider: "openai" as const,
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}
const WIKI = "/p/wiki"

const SAMPLE_SOURCE = `# Intro

Welcome to the source.

## Section A

Section A talks about chunked retrieval.

## Section B

Section B covers the agent loop.
`

describe("runAgentIngest — happy path", () => {
  it("ingests a source: writes 1 page, marks coverage, returns aggregate", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])  // empty wiki

    // Script the agent: write_wiki_page once, mark sections covered,
    // then done.
    const script = [
      toolUseTurn({
        name: "write_wiki_page",
        input: {
          slug: "concepts/chunked-retrieval",
          type: "concept",
          title: "Chunked Retrieval",
          body: "# Chunked Retrieval\n\nKey idea from section A.",
        },
      }),
      toolUseTurn({
        name: "mark_section_covered",
        input: { chunk_id: "c0", covered_by: ["concepts/chunked-retrieval"] },
      }),
      toolUseTurn({ name: "done", input: { reason: "single concept extracted" } }),
    ]
    const llm = new ScriptedLlm(script)
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.pagesCreated).toHaveLength(1)
    expect(result.pagesCreated[0].slug).toBe("concepts/chunked-retrieval")
    expect(result.pagesUpdated).toEqual([])
    expect(result.reason).toMatch(/done/i)
    expect(result.budgetExhausted).toBe(false)
    expect(result.turnsUsed).toBe(3)
    // The page actually landed on the "disk".
    expect(fs.files.get(`${WIKI}/concepts/chunked-retrieval.md`)).toMatch(
      /^---\ntype: concept/,
    )
  })

  it("forwards initial outline + existing-pages context to the LLM", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [
      { name: "existing.md", path: `${WIKI}/existing.md`, is_dir: false },
    ])
    setFile(
      `${WIKI}/existing.md`,
      "---\ntype: concept\ntitle: Existing Concept\n---\n\nbody",
    )

    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "trivial" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    // The first call to llm.chat — check the initial user prompt.
    const firstUserMsg = llm.calls[0].messages.find((m) => m.role === "user")!
    if (typeof firstUserMsg.content !== "string") throw new Error("expected string user content")
    expect(firstUserMsg.content).toContain("Source outline")
    expect(firstUserMsg.content).toContain("Section A")
    expect(firstUserMsg.content).toContain("Existing wiki pages")
    expect(firstUserMsg.content).toContain("Existing Concept")
  })

  it("propagates abort signal through the loop", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])
    const controller = new AbortController()
    controller.abort()

    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "won't run" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      signal: controller.signal,
    })
    expect(result.reason).toMatch(/abort/i)
    expect(result.turnsUsed).toBe(0)
  })

  it("surfaces gaps in reviewItemsCreated", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])

    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "surface_gap",
        input: {
          topic: "Cross-references to legacy schemas",
          reason: "Out of scope for current purpose.md",
        },
      }),
      toolUseTurn({ name: "done", input: { reason: "gap recorded" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.reviewItemsCreated).toHaveLength(1)
    expect(result.reviewItemsCreated[0]).toMatchObject({
      topic: "Cross-references to legacy schemas",
      reason: "Out of scope for current purpose.md",
    })
  })

  it("max_turns budget produces a budgetExhausted=false but max_turns reason", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])

    // Endless script — keeps calling read_outline, never done.
    const llm = new ScriptedLlm((_messages, i) =>
      toolUseTurn({ name: "read_outline", input: {}, id: `u${i}` }),
    )
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      maxTurns: 3,
    })
    expect(result.turnsUsed).toBe(3)
    expect(result.reason).toMatch(/turn budget/i)
    expect(result.budgetExhausted).toBe(false)
  })

  it("no_tools_called → reason mentions text-only stop", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])

    const llm = new ScriptedLlm([textTurn("I have nothing to do.")])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })
    expect(result.reason).toMatch(/text only|explicit done/i)
  })
})

describe("runAgentIngest — onTurn hook", () => {
  it("reports cumulative tokens per turn", async () => {
    setFile(SOURCE_PATH, SAMPLE_SOURCE)
    setTree(WIKI, [])

    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "read_outline",
        input: {},
        inputTokens: 50,
        outputTokens: 10,
      }),
      toolUseTurn({
        name: "done",
        input: { reason: "ok" },
        inputTokens: 70,
        outputTokens: 20,
      }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const seen: Array<[number, number]> = []
    await runAgentIngest({
      sourcePath: SOURCE_PATH,
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      onTurn: (i, tokens) => seen.push([i, tokens]),
    })
    // Cumulative: 60 after turn 0, 60+90=150 after turn 1.
    expect(seen).toEqual([
      [0, 60],
      [1, 150],
    ])
  })
})
