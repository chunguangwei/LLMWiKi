import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  searchLocalFilesTool,
  type SearchLocalFilesResult,
} from "./search-local-files"
import { InMemoryCoverageTracker } from "../tracker"
import type { AgentContext, WikiAccess } from "../types"
import type { FileNode } from "@/types/wiki"

/* in-memory fs mock (mirror end-to-end.test.ts pattern) */
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
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: file not found: ${p}`)
    return c
  },
  listDirectory: async (p: string) => {
    const t = fs.tree.get(p)
    if (!t) throw new Error(`mock fs: dir not in tree: ${p}`)
    return t
  },
}))

beforeEach(() => {
  fs = { files: new Map(), tree: new Map() }
})

function mockCtx(opts: { aborted?: boolean } = {}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  const wikiAccess: WikiAccess = {
    listPages: async () => [],
    readPage: async () => null,
    writePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    updatePage: async () => ({ kind: "validation_failed", detail: "mock" }),
    linkPages: async () => ({ kind: "validation_failed", detail: "mock" }),
    deletePage: async () => ({ kind: "validation_failed", detail: "mock" }),
  }
  return {
    chunks: new Map(),
    outline: [],
    vectorIndex: { search: async () => [] },
    project: { id: "p", name: "p", path: "/p" },
    tracker: new InMemoryCoverageTracker("test", "h", 0),
    wikiAccess,
    llmConfig: {} as AgentContext["llmConfig"],
    signal: controller.signal,
  } satisfies AgentContext
}

describe("search_local_files — contract", () => {
  it("declares schema with required query", () => {
    expect(searchLocalFilesTool.name).toBe("search_local_files")
    const s = searchLocalFilesTool.inputSchema as Record<string, any>
    expect(s.required).toEqual(["query"])
    expect(s.properties.limit.maximum).toBe(50)
    expect(s.additionalProperties).toBe(false)
  })
})

describe("search_local_files — happy path", () => {
  it("finds matches with snippet + 1-indexed line, returns project-relative paths", async () => {
    setFile("/p/notes.md", "first line\nsearching for needle here\nthird")
    setFile("/p/raw/sources/other.txt", "no match")
    setTree("/p", [
      { name: "notes.md", path: "/p/notes.md", is_dir: false },
      {
        name: "raw",
        path: "/p/raw",
        is_dir: true,
        children: [
          {
            name: "sources",
            path: "/p/raw/sources",
            is_dir: true,
            children: [
              { name: "other.txt", path: "/p/raw/sources/other.txt", is_dir: false },
            ],
          },
        ],
      },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "needle" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0].path).toBe("notes.md")
    expect(r.matches[0].line).toBe(2)
    expect(r.matches[0].snippet).toMatch(/needle/)
  })

  it("is case-insensitive by default; case_sensitive=true respects case", async () => {
    setFile("/p/a.md", "FOO bar")
    setTree("/p", [{ name: "a.md", path: "/p/a.md", is_dir: false }])
    const ctx = mockCtx()

    const ci = (await searchLocalFilesTool.execute(
      { query: "foo" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(ci.matches).toHaveLength(1)

    const cs = (await searchLocalFilesTool.execute(
      { query: "foo", case_sensitive: true },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(cs.matches).toHaveLength(0)
  })

  it("respects glob filename filter", async () => {
    setFile("/p/notes.md", "needle")
    setFile("/p/notes.txt", "needle")
    setTree("/p", [
      { name: "notes.md", path: "/p/notes.md", is_dir: false },
      { name: "notes.txt", path: "/p/notes.txt", is_dir: false },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "needle", glob: "*.md" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.matches.map((m) => m.path)).toEqual(["notes.md"])
  })

  it("walks under the given root, not the project root", async () => {
    setFile("/p/top.md", "needle here")
    setFile("/p/wiki/inside.md", "needle here too")
    setTree("/p/wiki", [
      { name: "inside.md", path: "/p/wiki/inside.md", is_dir: false },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "needle", root: "wiki" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0].path).toMatch(/inside/)
  })

  it("skips noisy directories like node_modules and .git", async () => {
    setFile("/p/wanted.md", "needle")
    setFile("/p/node_modules/junk.md", "needle")
    setFile("/p/.git/junk.md", "needle")
    setTree("/p", [
      { name: "wanted.md", path: "/p/wanted.md", is_dir: false },
      {
        name: "node_modules",
        path: "/p/node_modules",
        is_dir: true,
        children: [
          { name: "junk.md", path: "/p/node_modules/junk.md", is_dir: false },
        ],
      },
      {
        name: ".git",
        path: "/p/.git",
        is_dir: true,
        children: [
          { name: "junk.md", path: "/p/.git/junk.md", is_dir: false },
        ],
      },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "needle" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.matches.map((m) => m.path)).toEqual(["wanted.md"])
  })

  it("returns EVERY matching line within a single file (not just the first)", async () => {
    setFile(
      "/p/wiki/diary.md",
      [
        "2019-04-02 打了羽毛球",
        "随便写点别的",
        "2020-06-11 又去打羽毛球了",
        "无关行",
        "2021-09-30 周末羽毛球",
      ].join("\n"),
    )
    setTree("/p/wiki", [
      { name: "diary.md", path: "/p/wiki/diary.md", is_dir: false },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "羽毛球", root: "wiki" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.ok).toBe(true)
    expect(r.matches).toHaveLength(3)
    expect(r.matches.map((m) => m.line)).toEqual([1, 3, 5])
    expect(r.matches.every((m) => m.path === "wiki/diary.md")).toBe(true)
    expect(r.matches[0].snippet).toContain("2019-04-02")
  })

  it("strips trailing CRLF so Windows files give clean snippets", async () => {
    setFile("/p/win.md", "2019 羽毛球\r\n中间\r\n2020 羽毛球\r\n")
    setTree("/p", [{ name: "win.md", path: "/p/win.md", is_dir: false }])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "羽毛球" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.matches).toHaveLength(2)
    expect(r.matches[0].snippet).toBe("2019 羽毛球")
    expect(r.matches[0].snippet).not.toContain("\r")
  })

  it("respects limit and reports truncated", async () => {
    setFile("/p/a.md", "needle")
    setFile("/p/b.md", "needle")
    setFile("/p/c.md", "needle")
    setTree("/p", [
      { name: "a.md", path: "/p/a.md", is_dir: false },
      { name: "b.md", path: "/p/b.md", is_dir: false },
      { name: "c.md", path: "/p/c.md", is_dir: false },
    ])
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "needle", limit: 2 },
      ctx,
    )) as Extract<SearchLocalFilesResult, { ok: true }>
    expect(r.matches).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })
})

describe("search_local_files — traversal rejects", () => {
  it("invalid_input on absolute root", async () => {
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "x", root: "/etc" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/relative/)
  })

  it("invalid_input on '..' segment", async () => {
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "x", root: "../etc" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
    expect(r.detail).toMatch(/'\.\.'/)
  })

  it("invalid_input on backslash absolute root (Windows-style)", async () => {
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "x", root: "\\Users\\foo" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })
})

describe("search_local_files — error envelope", () => {
  it("invalid_input on empty query", async () => {
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "   " },
      ctx,
    )) as Extract<SearchLocalFilesResult, { error: "invalid_input" }>
    expect(r.error).toBe("invalid_input")
  })

  it("scan_failed when listDirectory throws", async () => {
    // No tree set → mock listDirectory throws.
    const ctx = mockCtx()
    const r = (await searchLocalFilesTool.execute(
      { query: "x" },
      ctx,
    )) as Extract<SearchLocalFilesResult, { error: "scan_failed" }>
    expect(r.error).toBe("scan_failed")
  })

  it("throws on aborted signal", async () => {
    const ctx = mockCtx({ aborted: true })
    await expect(
      searchLocalFilesTool.execute({ query: "x" }, ctx),
    ).rejects.toThrow(/aborted/)
  })
})
