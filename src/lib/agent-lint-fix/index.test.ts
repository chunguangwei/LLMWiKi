/**
 * End-to-end smoke test for runLintFix.
 *
 * Same trick as agent-ingest's end-to-end.test.ts: mock @/commands/fs
 * with an in-memory FS, replace the LLM adapter with a ScriptedLlm,
 * exercise the entry point. Covers wire-up correctness across the
 * three lint types (broken-link / orphan / no-outlinks) — not the
 * LLM's reasoning quality.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runLintFix } from "./index"
import { ScriptedLlm, toolUseTurn } from "@/lib/agent-ingest/scripted-llm"
import * as agentLlmModule from "@/lib/agent-ingest/agent-llm"
import type { LintItem } from "@/stores/lint-store"
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

beforeEach(() => {
  fs = { files: new Map(), tree: new Map() }
  vi.restoreAllMocks()
})

const PROJECT = { id: "p1", name: "Test", path: "/p" }
const LLM_CONFIG = {
  provider: "openai" as const,
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}
const WIKI = "/p/wiki"

function brokenLinkItem(overrides: Partial<LintItem> = {}): LintItem {
  return {
    id: "lint-1",
    type: "broken-link",
    severity: "warning",
    page: "concepts/foo.md",
    detail: "Broken link: [[bar]] — target page not found.",
    createdAt: 0,
    ...overrides,
  }
}

function orphanItem(overrides: Partial<LintItem> = {}): LintItem {
  return {
    id: "lint-2",
    type: "orphan",
    severity: "info",
    page: "concepts/foo.md",
    detail: "No other pages link to this page.",
    createdAt: 0,
    ...overrides,
  }
}

describe("runLintFix — broken-link happy path", () => {
  it("agent updates the broken page in place and reports the result", async () => {
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\n# Foo\n\nReferences [[bar]] which is missing.")
    setTree(WIKI, [
      {
        name: "concepts",
        path: `${WIKI}/concepts`,
        is_dir: true,
        children: [
          { name: "foo.md", path: `${WIKI}/concepts/foo.md`, is_dir: false },
        ],
      },
    ])

    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "update_wiki_page",
        input: {
          slug: "concepts/foo",
          body: "# Foo\n\nReferences a missing target — link removed.",
        },
      }),
      toolUseTurn({
        name: "done",
        input: { reason: "removed the broken link from concepts/foo" },
      }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runLintFix({
      item: brokenLinkItem(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.pagesUpdated).toHaveLength(1)
    expect(result.pagesUpdated[0].slug).toBe("concepts/foo")
    expect(result.reason).toMatch(/done/i)
    expect(result.itemId).toBe("lint-1")
    expect(result.budgetExhausted).toBe(false)
    // The page actually got rewritten on the "disk".
    expect(fs.files.get(`${WIKI}/concepts/foo.md`)).toMatch(
      /link removed/,
    )
  })
})

describe("runLintFix — orphan happy path", () => {
  it("agent surfaces a gap when no related page is found", async () => {
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nbody")
    setTree(WIKI, [
      {
        name: "concepts",
        path: `${WIKI}/concepts`,
        is_dir: true,
        children: [
          { name: "foo.md", path: `${WIKI}/concepts/foo.md`, is_dir: false },
        ],
      },
    ])

    const llm = new ScriptedLlm([
      toolUseTurn({
        name: "surface_gap",
        input: {
          topic: "concepts/foo is disconnected",
          reason: "no related page found in this wiki",
        },
      }),
      toolUseTurn({ name: "done", input: { reason: "surfaced for review" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runLintFix({
      item: orphanItem(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    expect(result.gapsSurfaced).toHaveLength(1)
    expect(result.gapsSurfaced[0].topic).toMatch(/disconnected/)
    expect(result.pagesUpdated).toHaveLength(0)
  })
})

describe("runLintFix — system prompt is per-type", () => {
  it("broken-link prompt mentions search_wiki_by_title", async () => {
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nbody")
    setTree(WIKI, [])
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "no-op" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runLintFix({
      item: brokenLinkItem(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const firstCall = llm.calls[0]
    const systemMsg = firstCall.messages.find((m) => m.role === "system")!
    if (typeof systemMsg.content !== "string") throw new Error("expected string system")
    expect(systemMsg.content).toMatch(/search_wiki_by_title/)
    expect(systemMsg.content).toMatch(/broken/i)
  })

  it("orphan prompt mentions cross-linking rather than index.md push", async () => {
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nbody")
    setTree(WIKI, [])
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "no-op" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    await runLintFix({
      item: orphanItem(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
    })

    const systemMsg = llm.calls[0].messages.find((m) => m.role === "system")!
    if (typeof systemMsg.content !== "string") throw new Error("expected string system")
    expect(systemMsg.content).toMatch(/index\.md mechanically/i)
    expect(systemMsg.content).toMatch(/cross-link/i)
  })
})

describe("runLintFix — abort propagation", () => {
  it("aborts before any tool dispatch", async () => {
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nbody")
    setTree(WIKI, [])
    const controller = new AbortController()
    controller.abort()
    const llm = new ScriptedLlm([
      toolUseTurn({ name: "done", input: { reason: "won't run" } }),
    ])
    vi.spyOn(agentLlmModule, "createAgentLlm").mockReturnValue(llm)

    const result = await runLintFix({
      item: brokenLinkItem(),
      project: PROJECT,
      llmConfig: LLM_CONFIG,
      signal: controller.signal,
    })

    expect(result.reason).toMatch(/aborted/i)
    expect(llm.calls).toHaveLength(0)
  })
})
