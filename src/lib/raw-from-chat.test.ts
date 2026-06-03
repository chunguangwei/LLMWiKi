import { describe, it, expect, vi, beforeEach } from "vitest"

const files = new Map<string, string>()
const dirs = new Set<string>()

vi.mock("@/commands/fs", () => ({
  copyFile: vi.fn(async (src: string, dest: string) => {
    files.set(dest, files.get(src) ?? "")
  }),
  createDirectory: vi.fn(async (path: string) => {
    dirs.add(path)
  }),
  fileExists: vi.fn(async (path: string) => files.has(path)),
  preprocessFile: vi.fn(async () => ""),
  readFile: vi.fn(async (path: string) => {
    if (files.has(path)) return files.get(path) as string
    throw new Error("ENOENT")
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
}))

vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: vi.fn(async () => []),
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: vi.fn(() => true),
}))

const fetchAndExtractMock = vi.fn()
vi.mock("@/lib/web-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-fetch")>()
  return {
    ...actual,
    fetchAndExtract: (...args: unknown[]) => fetchAndExtractMock(...args),
  }
})

import {
  addFilesToRawWithContext,
  addUrlsToRawWithContext,
  buildContextBlock,
  contextSidecarPath,
  readSourceWithSidecar,
  isImageSourcePath,
  CHAT_CONTEXT_MARKER,
} from "./raw-from-chat"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"

const proj = { id: "p1", name: "P", path: "/proj" } as const
const llm = { provider: "test" } as unknown as Parameters<typeof addFilesToRawWithContext>[3]

beforeEach(() => {
  files.clear()
  dirs.clear()
  fetchAndExtractMock.mockReset()
  vi.clearAllMocks()
})

describe("isImageSourcePath", () => {
  it("routes common + modern image formats to the vision path", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg", "avif", "heic", "heif", "jfif"]) {
      expect(isImageSourcePath(`/x/photo.${ext}`)).toBe(true)
      expect(isImageSourcePath(`/x/photo.${ext.toUpperCase()}`)).toBe(true)  // case-insensitive
    }
  })

  it("does NOT treat documents as images", () => {
    for (const ext of ["epub", "pdf", "docx", "md", "txt", "json"]) {
      expect(isImageSourcePath(`/x/doc.${ext}`)).toBe(false)
    }
    expect(isImageSourcePath("/x/noext")).toBe(false)
  })
})

describe("buildContextBlock", () => {
  it("returns empty for blank notes", () => {
    expect(buildContextBlock("")).toBe("")
    expect(buildContextBlock("   \n  ")).toBe("")
  })

  it("wraps the note with the marker comment and ## Context heading", () => {
    const out = buildContextBlock("hello there")
    expect(out.startsWith(CHAT_CONTEXT_MARKER)).toBe(true)
    expect(out).toContain("## Context (added via chat)")
    expect(out).toContain("hello there")
    expect(out.endsWith("\n\n")).toBe(true)
  })
})

describe("contextSidecarPath", () => {
  it("places a dot-prefixed sidecar next to the source", () => {
    expect(contextSidecarPath("/proj/raw/sources/sub/paper.pdf")).toBe(
      "/proj/raw/sources/sub/.paper.pdf.context.md",
    )
  })
  it("handles a flat (root) path", () => {
    expect(contextSidecarPath("paper.pdf")).toBe("/.paper.pdf.context.md")
  })
})

describe("addFilesToRawWithContext", () => {
  it("prepends context inline for a text source and enqueues ingest", async () => {
    files.set("/src/notes.md", "# Existing\nhello")

    const res = await addFilesToRawWithContext(proj as never, ["/src/notes.md"], "RAG paper notes", llm)

    expect(res.imported).toEqual(["/proj/raw/sources/notes.md"])
    expect(res.contextApplied).toBe(1)
    const dest = files.get("/proj/raw/sources/notes.md") as string
    expect(dest.startsWith(CHAT_CONTEXT_MARKER)).toBe(true)
    expect(dest).toContain("RAG paper notes")
    expect(dest).toContain("# Existing")
    expect(enqueueSourceIngest).toHaveBeenCalledTimes(1)
  })

  it("writes a sidecar (not inline) for a binary source", async () => {
    files.set("/src/paper.pdf", "<<binary>>")

    const res = await addFilesToRawWithContext(proj as never, ["/src/paper.pdf"], "RAG survey", llm)

    expect(res.imported).toEqual(["/proj/raw/sources/paper.pdf"])
    expect(res.contextApplied).toBe(1)
    expect(files.get("/proj/raw/sources/paper.pdf")).toBe("<<binary>>")
    const sidecar = files.get("/proj/raw/sources/.paper.pdf.context.md") as string
    expect(sidecar).toBeDefined()
    expect(sidecar).toContain("RAG survey")
    expect(sidecar.startsWith(CHAT_CONTEXT_MARKER)).toBe(true)
  })

  it("does not touch the file when the context note is empty", async () => {
    files.set("/src/x.md", "# x\nbody")
    const res = await addFilesToRawWithContext(proj as never, ["/src/x.md"], "", llm)
    expect(res.contextApplied).toBe(0)
    expect(files.get("/proj/raw/sources/x.md")).toBe("# x\nbody")
  })

  it("renames to avoid clobbering an existing dest", async () => {
    files.set("/proj/raw/sources/x.md", "EXISTING")
    files.set("/src/x.md", "NEW")
    const res = await addFilesToRawWithContext(proj as never, ["/src/x.md"], "", llm)
    expect(res.imported[0]).toMatch(/x-\d{8}\.md$/)
    expect(files.get("/proj/raw/sources/x.md")).toBe("EXISTING")
  })

  it("readSourceWithSidecar prepends sidecar content when present", async () => {
    files.set("/proj/raw/sources/paper.pdf", "EXTRACTED TEXT")
    files.set(
      "/proj/raw/sources/.paper.pdf.context.md",
      `${CHAT_CONTEXT_MARKER} added=2026-05-28 -->\n## Context (added via chat)\n\nRAG survey\n\n---\n\n`,
    )
    const merged = await readSourceWithSidecar("/proj/raw/sources/paper.pdf")
    expect(merged.startsWith(CHAT_CONTEXT_MARKER)).toBe(true)
    expect(merged).toContain("RAG survey")
    expect(merged).toContain("EXTRACTED TEXT")
  })

  it("readSourceWithSidecar returns plain content when no sidecar exists", async () => {
    files.set("/proj/raw/sources/notes.md", "hello")
    const out = await readSourceWithSidecar("/proj/raw/sources/notes.md")
    expect(out).toBe("hello")
  })

  it("fetches URLs and writes web markdown with frontmatter + context", async () => {
    fetchAndExtractMock.mockResolvedValueOnce({
      url: "https://x.test/rag",
      finalUrl: "https://x.test/rag",
      title: "RAG Overview",
      markdown: "## Body\n\nstuff",
      contentType: "text/html",
      fetchedAt: "2026-05-28T10:00:00Z",
    })

    const res = await addUrlsToRawWithContext(
      proj as never,
      ["https://x.test/rag"],
      "Survey paper notes",
      llm,
    )
    expect(res.imported).toHaveLength(1)
    expect(res.failed).toHaveLength(0)
    const dest = res.imported[0]
    expect(dest).toMatch(/\/proj\/raw\/sources\/web\/rag-overview-\d{8}\.md$/)
    const content = files.get(dest) as string
    expect(content).toContain("source_url: https://x.test/rag")
    expect(content).toContain('title: "RAG Overview"')
    expect(content).toContain("fetched_at: 2026-05-28T10:00:00Z")
    expect(content).toContain(CHAT_CONTEXT_MARKER)
    expect(content).toContain("Survey paper notes")
    expect(content).toContain("# RAG Overview")
    expect(content).toContain("## Body")
    expect(enqueueSourceIngest).toHaveBeenCalledTimes(1)
  })

  it("records URL fetch failures and keeps successes", async () => {
    fetchAndExtractMock
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        url: "https://x.test/b",
        finalUrl: "https://x.test/b",
        title: "B",
        markdown: "b",
        contentType: "text/html",
        fetchedAt: "2026-05-28T10:00:00Z",
      })

    const res = await addUrlsToRawWithContext(
      proj as never,
      ["https://x.test/a", "https://x.test/b"],
      "",
      llm,
    )
    expect(res.imported).toHaveLength(1)
    expect(res.failed).toEqual([{ url: "https://x.test/a", error: "timeout" }])
  })

  it("records a failed source under `failed` and continues", async () => {
    const { copyFile } = await import("@/commands/fs")
    ;(copyFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("EACCES")
    })
    files.set("/src/ok.md", "ok")

    const res = await addFilesToRawWithContext(
      proj as never,
      ["/src/bad.md", "/src/ok.md"],
      "",
      llm,
    )
    expect(res.failed).toEqual(["/src/bad.md"])
    expect(res.imported).toEqual(["/proj/raw/sources/ok.md"])
  })
})
