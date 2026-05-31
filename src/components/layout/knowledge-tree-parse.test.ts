import { describe, it, expect } from "vitest"
import { parsePageInfo } from "./knowledge-tree"

const FM_HEADER = (type: string) => `---\ntype: ${type}\ntitle: Sample\n---\n\nbody`

describe("parsePageInfo — type categorisation", () => {
  it("uses the frontmatter type when it's in TYPE_CONFIG", () => {
    const info = parsePageInfo(
      "/proj/wiki/foo.md",
      "foo.md",
      FM_HEADER("concept"),
    )
    expect(info.type).toBe("concept")
  })

  it("falls back to PATH-inferred type when frontmatter type is not in TYPE_CONFIG", () => {
    // LLM picked a free-form slug ("openclaw") that isn't in the
    // 34-type taxonomy. Without this fallback the page would land in
    // "Other" regardless of folder.
    const info = parsePageInfo(
      "/proj/wiki/concepts/openclaw.md",
      "openclaw.md",
      FM_HEADER("openclaw"),
    )
    expect(info.type).toBe("concept")
  })

  it("infers from path when there's no frontmatter at all", () => {
    const info = parsePageInfo(
      "/proj/wiki/entities/foo.md",
      "foo.md",
      "# A page with no frontmatter\n\nbody",
    )
    expect(info.type).toBe("entity")
  })

  it("keeps falling back to 'other' when both frontmatter and path are unhelpful", () => {
    // A top-level page in wiki/ with a freely-typed type and no
    // matching folder. There's nothing the categoriser can do here —
    // honestly land in Other.
    const info = parsePageInfo(
      "/proj/wiki/random.md",
      "random.md",
      FM_HEADER("project-xyz-experimental"),
    )
    // Either falls to "other" OR keeps the original (both treated as
    // catch-all by TYPE_CONFIG). The test pins that we don't crash
    // and we don't pretend it's a real category.
    expect(["other", "project-xyz-experimental"]).toContain(info.type)
  })

  it("known taxonomy types under non-standard folders still resolve via frontmatter", () => {
    // type: report under wiki/项目文档/ (a user's Chinese folder name).
    // Frontmatter wins over path inference when the frontmatter is
    // recognised.
    const info = parsePageInfo(
      "/proj/wiki/项目文档/our-report.md",
      "our-report.md",
      FM_HEADER("report"),
    )
    expect(info.type).toBe("report")
  })
})
