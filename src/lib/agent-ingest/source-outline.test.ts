import { describe, it, expect } from "vitest"
import {
  extractOutlineFromMarkdown,
  associateOutlineWithChunks,
} from "./source-outline"

describe("extractOutlineFromMarkdown", () => {
  it("returns [] for empty input", () => {
    expect(extractOutlineFromMarkdown("")).toEqual([])
  })

  it("returns [] for a body with no headings", () => {
    expect(extractOutlineFromMarkdown("just paragraphs\nand more text")).toEqual([])
  })

  it("captures one heading per ATX level", () => {
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6"
    const result = extractOutlineFromMarkdown(md)
    expect(result).toEqual([
      { level: 1, text: "H1", line_start: 1 },
      { level: 2, text: "H2", line_start: 2 },
      { level: 3, text: "H3", line_start: 3 },
      { level: 4, text: "H4", line_start: 4 },
      { level: 5, text: "H5", line_start: 5 },
      { level: 6, text: "H6", line_start: 6 },
    ])
  })

  it("tolerates 1-3 leading spaces (CommonMark)", () => {
    const md = " # one\n  ## two\n   ### three"
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "one", line_start: 1 },
      { level: 2, text: "two", line_start: 2 },
      { level: 3, text: "three", line_start: 3 },
    ])
  })

  it("skips 4+ space indent (treated as code block)", () => {
    // 4 spaces = CommonMark indented code block — NOT a heading.
    expect(extractOutlineFromMarkdown("    # not a heading")).toEqual([])
  })

  it("does not detect 7+ hashes (max ATX level is 6)", () => {
    expect(extractOutlineFromMarkdown("####### too deep")).toEqual([])
  })

  it("requires a space after the # marker", () => {
    // CommonMark: `#foo` is NOT a heading; needs a space.
    expect(extractOutlineFromMarkdown("#nospace")).toEqual([])
  })

  it("strips the optional trailing # sequence", () => {
    const md = "## section ##\n### deep #####"
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 2, text: "section", line_start: 1 },
      { level: 3, text: "deep", line_start: 2 },
    ])
  })

  it("ignores headings inside triple-backtick code fences", () => {
    const md = [
      "# Real",
      "```",
      "# Fake (inside fence)",
      "## Also fake",
      "```",
      "## Real two",
    ].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "Real", line_start: 1 },
      { level: 2, text: "Real two", line_start: 6 },
    ])
  })

  it("ignores headings inside tilde code fences", () => {
    const md = [
      "# A",
      "~~~",
      "# fake",
      "~~~",
      "# B",
    ].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "A", line_start: 1 },
      { level: 1, text: "B", line_start: 5 },
    ])
  })

  it("tilde inside backtick fence does not close it", () => {
    const md = [
      "```",
      "# fake",
      "~~~",          // doesn't close the ``` block
      "## still fake",
      "```",
      "# Real",
    ].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "Real", line_start: 6 },
    ])
  })

  it("tolerates an info string on the fence marker (```ts)", () => {
    const md = [
      "# Real one",
      "```typescript",
      "# fake",
      "```",
      "# Real two",
    ].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "Real one", line_start: 1 },
      { level: 1, text: "Real two", line_start: 5 },
    ])
  })

  it("skips YAML frontmatter at the top of the file", () => {
    const md = [
      "---",
      "title: Foo",
      "# this is YAML, not a heading",
      "---",
      "# Real H1",
      "## Real H2",
    ].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "Real H1", line_start: 5 },
      { level: 2, text: "Real H2", line_start: 6 },
    ])
  })

  it("returns [] on unterminated frontmatter (malformed input)", () => {
    const md = ["---", "title: Foo", "# never closes"].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([])
  })

  it("does NOT treat a `---` mid-document as frontmatter end", () => {
    // The `---` opener only matches if it's literally line 1.
    const md = ["# H1", "body", "---", "# H2"].join("\n")
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 1, text: "H1", line_start: 1 },
      { level: 1, text: "H2", line_start: 4 },
    ])
  })

  it("captures multi-word headings with punctuation verbatim", () => {
    const md = "## OKR — 2026 Q1: 收入 & 服务度量"
    expect(extractOutlineFromMarkdown(md)).toEqual([
      { level: 2, text: "OKR — 2026 Q1: 收入 & 服务度量", line_start: 1 },
    ])
  })

  it("returns line numbers 1-indexed (so they match editor display)", () => {
    const md = "intro paragraph\n\n# Heading at line 3"
    expect(extractOutlineFromMarkdown(md)[0].line_start).toBe(3)
  })
})

describe("associateOutlineWithChunks", () => {
  const chunks = [
    { chunk_id: "c0", line_range: [1, 10] as [number, number] },
    { chunk_id: "c1", line_range: [11, 25] as [number, number] },
    { chunk_id: "c2", line_range: [26, 40] as [number, number] },
  ]

  it("places each heading into the chunk containing its line", () => {
    const outline = [
      { level: 1, text: "A", line_start: 1 },
      { level: 1, text: "B", line_start: 11 },
      { level: 2, text: "B1", line_start: 20 },
      { level: 1, text: "C", line_start: 30 },
    ]
    const result = associateOutlineWithChunks(outline, chunks)
    expect(result).toEqual([
      { level: 1, text: "A", line_start: 1, chunk_id: "c0" },
      { level: 1, text: "B", line_start: 11, chunk_id: "c1" },
      { level: 2, text: "B1", line_start: 20, chunk_id: "c1" },
      { level: 1, text: "C", line_start: 30, chunk_id: "c2" },
    ])
  })

  it("handles chunk-boundary headings (line == range.end)", () => {
    const outline = [
      { level: 1, text: "edge-of-c0", line_start: 10 },
      { level: 1, text: "edge-of-c1", line_start: 11 },
    ]
    const result = associateOutlineWithChunks(outline, chunks)
    expect(result[0].chunk_id).toBe("c0")
    expect(result[1].chunk_id).toBe("c1")
  })

  it("drops headings outside every chunk's range", () => {
    const outline = [
      { level: 1, text: "stray", line_start: 99 },
      { level: 1, text: "real", line_start: 5 },
    ]
    const result = associateOutlineWithChunks(outline, chunks)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("real")
  })

  it("returns [] for empty outline", () => {
    expect(associateOutlineWithChunks([], chunks)).toEqual([])
  })

  it("returns [] when no chunks supplied (every heading drops)", () => {
    const outline = [{ level: 1, text: "x", line_start: 1 }]
    expect(associateOutlineWithChunks(outline, [])).toEqual([])
  })
})
