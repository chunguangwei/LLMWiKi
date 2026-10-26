import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import { createImportGuard, importDroppedSourcePaths } from "./source-drop"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  importSourceFiles: vi.fn(),
  importSourceFolder: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  fileExists: mocks.fileExists,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  importSourceFiles: mocks.importSourceFiles,
  importSourceFolder: mocks.importSourceFolder,
}))

const project = { id: "project-1", path: "/project", name: "Project" } as WikiProject
const llmConfig = {} as LlmConfig

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listDirectory.mockImplementation(async (path: string) => {
    if (path === "/missing") throw new Error("Path does not exist")
    if (path.startsWith("/file")) throw new Error(`Path is not a directory: '${path}'`)
    return []
  })
  mocks.fileExists.mockImplementation(async (path: string) => path !== "/missing")
  mocks.importSourceFiles.mockImplementation(async (_project, paths: string[]) => ({
    imported: paths.map((path) => `/project/raw/sources/${path.split("/").pop()}`),
    skipped: [],
  }))
  mocks.importSourceFolder.mockImplementation(async (_project, path: string) => ({
    imported: [`/project/raw/sources/${path.split("/").pop()}/notes.md`],
    skipped: [],
  }))
})

describe("source drops", () => {
  it("deduplicates mixed files and folders and reports missing paths", async () => {
    const result = await importDroppedSourcePaths(
      project,
      ["/file/notes.md", "/folder", "/file/notes.md", "/missing", "relative.md"],
      llmConfig,
    )

    expect(mocks.importSourceFiles).toHaveBeenCalledExactlyOnceWith(project, ["/file/notes.md"], llmConfig, undefined)
    expect(mocks.importSourceFolder).toHaveBeenCalledExactlyOnceWith(project, "/folder", llmConfig, undefined)
    expect(result.imported).toEqual([
      "/project/raw/sources/notes.md",
      "/project/raw/sources/folder/notes.md",
    ])
    expect(result.skipped).toEqual([
      { name: "missing", reason: "unreadable", detail: "Path does not exist" },
      { name: "relative.md", reason: "unreadable", detail: "Dropped path is not absolute" },
    ])
    expect(result.error).toBeNull()
  })

  it("keeps importing later folders after the current project is rejected", async () => {
    mocks.importSourceFolder.mockImplementation(async (_project, path: string) => {
      if (path === "/project") throw new Error("Cannot import the project folder")
      return { imported: [`/project/raw/sources/${path.split("/").pop()}/notes.md`], skipped: [] }
    })

    const result = await importDroppedSourcePaths(project, ["/project", "/folder"], llmConfig)

    expect(mocks.importSourceFolder).toHaveBeenCalledTimes(2)
    expect(result.imported).toEqual(["/project/raw/sources/folder/notes.md"])
    expect(result.error).toContain("Cannot import the project folder")
  })

  it("preserves folder results when the file batch fails", async () => {
    mocks.importSourceFiles.mockRejectedValue(new Error("copy failed"))

    const result = await importDroppedSourcePaths(project, ["/file/a.md", "/folder"], llmConfig)

    expect(mocks.importSourceFolder).toHaveBeenCalledOnce()
    expect(result.imported).toEqual(["/project/raw/sources/folder/notes.md"])
    expect(result.error).toBe("copy failed")
  })

  it("does not attempt imports for missing paths", async () => {
    const result = await importDroppedSourcePaths(project, ["/missing"], llmConfig)

    expect(mocks.importSourceFiles).not.toHaveBeenCalled()
    expect(mocks.importSourceFolder).not.toHaveBeenCalled()
    expect(result.imported).toEqual([])
    expect(result.skipped[0].reason).toBe("unreadable")
  })
})

describe("import guard", () => {
  it("rejects overlapping imports and accepts a later import after release", () => {
    const guard = createImportGuard()
    expect(guard.tryAcquire()).toBe(true)
    expect(guard.tryAcquire()).toBe(false)
    guard.release()
    expect(guard.tryAcquire()).toBe(true)
    guard.release()
  })
})
