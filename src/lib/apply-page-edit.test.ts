import { describe, it, expect, vi, beforeEach } from "vitest"

const writes: { path: string; content: string }[] = []
const files = new Map<string, string>()

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    if (files.has(path)) return files.get(path) as string
    throw new Error("ENOENT")
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    writes.push({ path, content })
    files.set(path, content)
  }),
}))

import { applyPageEdit } from "./apply-page-edit"

beforeEach(() => {
  writes.length = 0
  files.clear()
})

describe("applyPageEdit", () => {
  it("backs up an existing page, writes the new content, and logs the edit", async () => {
    const proj = "/p"
    files.set("/p/wiki/概念/rope.md", "---\ntype: concept\ntitle: RoPE\ncreated: 2026-01-01\n---\nOld body")

    const res = await applyPageEdit(proj, "wiki/概念/rope.md", "---\ntype: concept\ntitle: RoPE\ncreated: 2026-01-01\n---\nNew body")

    expect(res.backedUp).toBe(true)
    expect(res.created).toBe(false)
    // a backup snapshot was written under page-history
    expect(writes.some((w) => w.path.startsWith("/p/.llm-wiki/page-history/wiki_概念_rope.md-"))).toBe(true)
    // the page was overwritten with the new body
    expect(files.get("/p/wiki/概念/rope.md")).toContain("New body")
    // log appended
    expect(files.get("/p/wiki/log.md")).toMatch(/Edited \(via chat\) `wiki\/概念\/rope\.md`/)
  })

  it("creates a new page without a backup when the target does not exist", async () => {
    const res = await applyPageEdit("/p", "wiki/笔记/new.md", "---\ntype: note\n---\nHello")
    expect(res.created).toBe(true)
    expect(res.backedUp).toBe(false)
    expect(writes.some((w) => w.path.includes("page-history"))).toBe(false)
    expect(files.get("/p/wiki/笔记/new.md")).toContain("Hello")
    expect(files.get("/p/wiki/log.md")).toMatch(/Created `wiki\/笔记\/new\.md`/)
  })

  it("preserves the original created date when the new content omits it", async () => {
    files.set("/p/wiki/x.md", "---\ntype: note\ntitle: X\ncreated: 2025-12-31\n---\nold")
    await applyPageEdit("/p", "wiki/x.md", "---\ntype: note\ntitle: X\n---\nnew")
    expect(files.get("/p/wiki/x.md")).toContain("created: 2025-12-31")
    expect(files.get("/p/wiki/x.md")).toContain("new")
  })
})
