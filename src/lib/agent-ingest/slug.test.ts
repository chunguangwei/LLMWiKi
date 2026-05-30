import { describe, it, expect } from "vitest"
import { validateSlug, slugifyTitle } from "./slug"

describe("validateSlug — accepts well-formed slugs", () => {
  it.each([
    ["concepts/foo"],
    ["entities/karpathy-andrej"],
    ["Books/原则-读书笔记"],
    ["a"],
    ["a/b/c/d"],
    ["123-numeric-prefix"],
    ["with_underscores"],
    ["mixed-Case-OK"],
    ["unicode-é-è"],
  ])("accepts %s", (slug) => {
    expect(validateSlug(slug)).toBeNull()
  })
})

describe("validateSlug — rejects path traversal / absolute", () => {
  it.each([
    ["/abs/path", /relative/],
    ["concepts/../etc/passwd", /invalid path segment/],
    ["..", /invalid path segment/],
    [".", /invalid path segment/],  // bare `.` also rejected (curr dir resolves outside the directory)
    ["concepts/.", /invalid path segment/],
    ["concepts/", /trailing/],
    ["", /non-empty/],
    ["   ", /non-empty/],
  ])("rejects %s with reason matching %s", (slug, reasonRe) => {
    const r = validateSlug(slug)
    expect(r).not.toBeNull()
    expect(r).toMatch(reasonRe)
  })
})

describe("validateSlug — rejects Windows-illegal chars / names", () => {
  it.each([
    ['concepts/foo<bar', /reserved character/],
    ['concepts/foo>bar', /reserved character/],
    ['concepts/foo:bar', /reserved character/],
    ['concepts/foo"bar', /reserved character/],
    ['concepts/foo|bar', /reserved character/],
    ['concepts/foo?bar', /reserved character/],
    ['concepts/foo*bar', /reserved character/],
    ['concepts/foo\\bar', /reserved character/],
    ['\\windows\\style', /forward slashes/],
    ['conceptsbell', /reserved character/],
    ['CON', /Windows-reserved/],
    ['con', /Windows-reserved/],
    ['con.md', /must NOT include/],
    // CON inside a path segment is still reserved on Windows
    // when accessed standalone — Windows refuses to open `CON.txt`.
    ['folder/CON.txt', /Windows-reserved/],
    ['folder/nul', /Windows-reserved/],
    ['folder/COM1', /Windows-reserved/],
    ['folder/LPT9', /Windows-reserved/],
  ])("rejects %s", (slug, reasonRe) => {
    const r = validateSlug(slug)
    expect(r).not.toBeNull()
    expect(r).toMatch(reasonRe)
  })
})

describe("validateSlug — misc rejections", () => {
  it("rejects slugs ending in .md (must be extension-stripped)", () => {
    expect(validateSlug("concepts/foo.md")).toMatch(/must NOT include/)
  })

  it("rejects non-string input", () => {
    expect(validateSlug(42 as unknown)).toMatch(/must be a string/)
    expect(validateSlug(null)).toMatch(/must be a string/)
    expect(validateSlug(undefined)).toMatch(/must be a string/)
    expect(validateSlug({})).toMatch(/must be a string/)
  })

  it("rejects pathologically long slugs", () => {
    expect(validateSlug("a".repeat(201))).toMatch(/too long/)
  })

  it("trims whitespace before validating (a slug of `  foo  ` is fine)", () => {
    expect(validateSlug("  concepts/foo  ")).toBeNull()
  })
})

describe("slugifyTitle", () => {
  it("lowercases and replaces whitespace with dashes", () => {
    expect(slugifyTitle("Hello World")).toBe("hello-world")
  })

  it("preserves CJK characters", () => {
    expect(slugifyTitle("快手IT-OKR评审")).toBe("快手it-okr评审")
  })

  it("collapses runs of punctuation to a single dash", () => {
    expect(slugifyTitle("Q3 -- Revenue !! 2024")).toBe("q3-revenue-2024")
  })

  it("trims leading and trailing dashes", () => {
    expect(slugifyTitle("---foo---")).toBe("foo")
  })

  it("caps at 60 chars", () => {
    expect(slugifyTitle("a".repeat(100)).length).toBeLessThanOrEqual(60)
  })

  it("returns 'untitled' for inputs that produce empty slugs", () => {
    expect(slugifyTitle("!!!")).toBe("untitled")
    expect(slugifyTitle("")).toBe("untitled")
  })
})
