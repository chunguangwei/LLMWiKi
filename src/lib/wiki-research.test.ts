import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { buildProjectPathIndexFromTree } from "./wiki-page-resolver"
import {
  collectWikiResearchSources,
  formatResearchReference,
  parseWikiResearchResolution,
  resolveWikiResearchPath,
} from "./wiki-research"
import { buildResearchPageContent } from "./deep-research"

const tree: FileNode[] = [{
  name: "project",
  path: "/project",
  is_dir: true,
  children: [
    {
      name: "wiki",
      path: "/project/wiki",
      is_dir: true,
      children: [{
        name: "concepts",
        path: "/project/wiki/concepts",
        is_dir: true,
        children: [
          { name: "alpha.md", path: "/project/wiki/concepts/alpha.md", is_dir: false },
          { name: "beta.md", path: "/project/wiki/concepts/beta.md", is_dir: false },
          { name: "gamma.md", path: "/project/wiki/concepts/gamma.md", is_dir: false },
        ],
      }],
    },
    { name: "raw", path: "/project/raw", is_dir: true, children: [
      { name: "secret.md", path: "/project/raw/secret.md", is_dir: false },
    ] },
  ],
}]
const index = buildProjectPathIndexFromTree(tree)
const contents: Record<string, string> = {
  "/project/wiki/concepts/alpha.md": "---\ntitle: Alpha\n---\n# Alpha\n\n[[concepts/beta]]",
  "/project/wiki/concepts/beta.md": "---\ntitle: Beta\n---\n# Beta\n\nLinked evidence",
  "/project/wiki/concepts/gamma.md": "---\ntitle: Gamma\n---\n# Gamma\n\nSearch evidence",
  "/project/raw/secret.md": "do not read",
}

describe("internal Wiki research", () => {
  it("resolves only indexed Wiki pages and rejects traversal or external paths", () => {
    expect(resolveWikiResearchPath("/project", "wiki/concepts/alpha.md", index)).toBe("/project/wiki/concepts/alpha.md")
    expect(resolveWikiResearchPath("/project", "concepts/alpha", index)).toBe("/project/wiki/concepts/alpha.md")
    expect(resolveWikiResearchPath("/project", "/project/wiki/concepts/alpha.md", index)).toBe("/project/wiki/concepts/alpha.md")
    expect(resolveWikiResearchPath("/project", "../raw/secret.md", index)).toBeNull()
    expect(resolveWikiResearchPath("/project", "/project/raw/secret.md", index)).toBeNull()
    expect(resolveWikiResearchPath("/project", "/outside/secret.md", index)).toBeNull()
  })

  it("starts with affected pages, follows links, and adds bounded search evidence", async () => {
    const read = vi.fn((path: string) => Promise.resolve(contents[path] ?? ""))
    const search = vi.fn().mockResolvedValue([{
      path: "/project/wiki/concepts/gamma.md",
      title: "Gamma",
      snippet: "Search evidence",
      titleMatch: true,
      score: 1,
      images: [],
    }])
    const collection = await collectWikiResearchSources({
      projectPath: "/project",
      affectedPages: ["wiki/concepts/alpha.md"],
      queries: ["evidence"],
    }, { read, search, index })

    expect(collection.results.map((result) => result.wikiPath)).toEqual([
      "wiki/concepts/alpha.md",
      "wiki/concepts/beta.md",
      "wiki/concepts/gamma.md",
    ])
    expect(collection.results[1].snippet).toContain("Linked evidence")
    expect(collection.results[2].snippet).toContain("Search evidence")
    expect(search).toHaveBeenCalledWith("/project", "evidence")
    expect(read).not.toHaveBeenCalledWith("/project/raw/secret.md")
  })

  it("caps total context and reports missing pages instead of reading outside the wiki", async () => {
    const collection = await collectWikiResearchSources({
      projectPath: "/project",
      affectedPages: ["wiki/concepts/alpha.md", "../raw/secret.md"],
      queries: [],
      llmConfig: { maxContextSize: 10_000 } as LlmConfig,
    }, {
      read: vi.fn((path: string) => Promise.resolve(contents[path] ?? "")),
      search: vi.fn().mockResolvedValue([]),
      index,
    })

    expect(collection.results.reduce((total, result) => total + result.snippet.length, 0)).toBeLessThanOrEqual(4_000)
    expect(collection.errors.some((error) => error.includes("../raw/secret.md"))).toBe(true)
  })

  it("requires an explicit resolution and preserves path-form source citations", () => {
    expect(parseWikiResearchResolution("RESOLUTION: UNRESOLVED\n\nEvidence is missing")).toEqual({
      resolution: "unresolved",
      cleaned: "Evidence is missing",
    })
    expect(parseWikiResearchResolution("RESOLUTION: RESOLVED\n\nResolved finding").resolution).toBe("resolved")
    expect(parseWikiResearchResolution("No decision").resolution).toBeNull()
    expect(formatResearchReference({ title: "Alpha", url: "wiki/concepts/alpha.md", wikiPath: "wiki/concepts/alpha.md", snippet: "", source: "Wiki" }, 1))
      .toBe("1. [[wiki/concepts/alpha.md|Alpha]] — Wiki")
    expect(buildResearchPageContent("Topic", "2026-10-24", "Finding", "1. [[wiki/concepts/alpha.md|Alpha]] — Wiki", true))
      .toContain("[[wiki/concepts/alpha.md|Alpha]]")
  })
})
