import { describe, it, expect } from "vitest"
import { diffLines, diffStats, isUnchanged } from "./text-diff"

describe("diffLines", () => {
  it("returns all context lines for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc")
    expect(d.every((l) => l.type === "ctx")).toBe(true)
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 })
  })

  it("detects a single changed line as del + add", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc")
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
    // unchanged a and c are preserved as context
    expect(d.filter((l) => l.type === "ctx").map((l) => l.text)).toEqual(["a", "c"])
    expect(d.find((l) => l.type === "del")?.text).toBe("b")
    expect(d.find((l) => l.type === "add")?.text).toBe("B")
  })

  it("detects pure insertions", () => {
    const d = diffLines("a\nc", "a\nb\nc")
    expect(diffStats(d)).toEqual({ added: 1, removed: 0 })
    expect(d.find((l) => l.type === "add")?.text).toBe("b")
  })

  it("detects pure deletions", () => {
    const d = diffLines("a\nb\nc", "a\nc")
    expect(diffStats(d)).toEqual({ added: 0, removed: 1 })
    expect(d.find((l) => l.type === "del")?.text).toBe("b")
  })

  it("normalizes CRLF", () => {
    const d = diffLines("a\r\nb", "a\nb")
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 })
  })
})

describe("isUnchanged", () => {
  it("ignores trailing whitespace / EOF newline", () => {
    expect(isUnchanged("a\nb\n", "a\nb")).toBe(true)
    expect(isUnchanged("a\nb", "a\nc")).toBe(false)
  })
})
