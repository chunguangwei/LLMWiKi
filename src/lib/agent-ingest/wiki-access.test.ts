import { describe, it, expect, vi, beforeEach } from "vitest"
import { FileSystemWikiAccess } from "./wiki-access"
import type { FileNode } from "@/types/wiki"

/**
 * Mock `@/commands/fs` with an in-memory filesystem. Tests build
 * a tree per scenario and then assert what FileSystemWikiAccess
 * produced. Keeps the test isolated from Tauri, Rust, and disk —
 * the WikiAccess logic IS the thing under test.
 */
type FsState = {
  files: Map<string, string>  // absolute path → content
  tree: Map<string, FileNode[]>  // absolute dir → immediate children listing
}

let fs: FsState = { files: new Map(), tree: new Map() }

function resetFs() {
  fs = { files: new Map(), tree: new Map() }
}

function setFile(path: string, content: string) {
  fs.files.set(path, content)
}

function setTree(dir: string, tree: FileNode[]) {
  fs.tree.set(dir, tree)
}

vi.mock("@/commands/fs", () => ({
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock: file not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
  listDirectory: async (p: string) => {
    const tree = fs.tree.get(p)
    if (!tree) throw new Error(`mock: dir not in tree: ${p}`)
    return tree
  },
}))

beforeEach(() => {
  resetFs()
})

const PROJECT = "/p"
const WIKI = `${PROJECT}/wiki`

function pageNode(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dirNode(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children }
}

/* ────────────────────────────────────────────────
 * listPages
 * ────────────────────────────────────────────────*/

describe("FileSystemWikiAccess — listPages", () => {
  it("walks the wiki tree, returns summaries for every .md", async () => {
    setTree(WIKI, [
      pageNode("foo.md", `${WIKI}/foo.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("bar.md", `${WIKI}/concepts/bar.md`),
      ]),
    ])
    setFile(
      `${WIKI}/foo.md`,
      "---\ntype: note\ntitle: Foo\n---\n\nNote body.",
    )
    setFile(
      `${WIKI}/concepts/bar.md`,
      "---\ntype: concept\ntitle: Bar\nrelated: [foo]\n---\n\nBar body.",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect(pages.map((p) => p.slug).sort()).toEqual(["concepts/bar", "foo"])
    const bar = pages.find((p) => p.slug === "concepts/bar")!
    expect(bar.type).toBe("concept")
    expect(bar.title).toBe("Bar")
    expect(bar.related).toEqual(["foo"])
  })

  it("skips index.md / log.md / overview.md (structural, not knowledge)", async () => {
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      pageNode("log.md", `${WIKI}/log.md`),
      pageNode("overview.md", `${WIKI}/overview.md`),
      pageNode("foo.md", `${WIKI}/foo.md`),
    ])
    setFile(`${WIKI}/index.md`, "# Index")
    setFile(`${WIKI}/log.md`, "# Log")
    setFile(`${WIKI}/overview.md`, "# Overview")
    setFile(`${WIKI}/foo.md`, "---\ntype: note\ntitle: Foo\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect(pages.map((p) => p.slug)).toEqual(["foo"])
  })

  it("falls back: type defaults to 'other' / title to first H1 / description from first para", async () => {
    setTree(WIKI, [pageNode("x.md", `${WIKI}/x.md`)])
    setFile(`${WIKI}/x.md`, "# Hand-Written Page\n\nFirst paragraph here.\n\nSecond para.")
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect(pages[0]).toEqual({
      slug: "x",
      type: "other",
      title: "Hand-Written Page",
      description: "First paragraph here.",
    })
  })

  it("filters by type when provided", async () => {
    setTree(WIKI, [
      pageNode("a.md", `${WIKI}/a.md`),
      pageNode("b.md", `${WIKI}/b.md`),
    ])
    setFile(`${WIKI}/a.md`, "---\ntype: concept\ntitle: A\n---\n\nx")
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages({ type: "concept" })
    expect(pages.map((p) => p.slug)).toEqual(["a"])
  })

  it("returns [] when wiki/ doesn't exist (fresh project)", async () => {
    // No tree registered for this path — listDirectory throws inside.
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect(pages).toEqual([])
  })

  it("truncates description preview at 200 chars + ellipsis", async () => {
    setTree(WIKI, [pageNode("long.md", `${WIKI}/long.md`)])
    setFile(
      `${WIKI}/long.md`,
      `---\ntype: note\ntitle: Long\n---\n\n${"A".repeat(500)}`,
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect(pages[0].description.length).toBe(201)
    expect(pages[0].description.endsWith("…")).toBe(true)
  })

  it("omits empty related[] from summaries", async () => {
    setTree(WIKI, [pageNode("a.md", `${WIKI}/a.md`)])
    setFile(`${WIKI}/a.md`, "---\ntype: note\ntitle: A\nrelated: []\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const pages = await wa.listPages()
    expect("related" in pages[0]).toBe(false)
  })
})

/* ────────────────────────────────────────────────
 * readPage
 * ────────────────────────────────────────────────*/

describe("FileSystemWikiAccess — readPage", () => {
  it("returns slug + type + title + frontmatter + body", async () => {
    setFile(
      `${WIKI}/concepts/foo.md`,
      "---\ntype: concept\ntitle: Foo\nrelated: [bar]\ntags: [x]\n---\n\n# Foo\n\nBody.",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    const page = await wa.readPage("concepts/foo")
    expect(page).not.toBeNull()
    expect(page!.slug).toBe("concepts/foo")
    expect(page!.type).toBe("concept")
    expect(page!.title).toBe("Foo")
    expect(page!.frontmatter.related).toEqual(["bar"])
    expect(page!.frontmatter.tags).toEqual(["x"])
    expect(page!.body).toBe("# Foo\n\nBody.")
  })

  it("preserves arbitrary frontmatter keys", async () => {
    // Note: parseFrontmatter normalises scalars to strings — the
    // wiki convention is that frontmatter values are strings or
    // string[]; numeric / boolean coercion lives in the consumer.
    setFile(
      `${WIKI}/x.md`,
      "---\ntype: note\ntitle: X\ncustom_field: 42\nsources: [a, b]\n---\n\nx",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    const page = await wa.readPage("x")
    expect(page!.frontmatter.custom_field).toBe("42")
    expect(page!.frontmatter.sources).toEqual(["a", "b"])
  })

  it("returns null when the slug has no file", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    const page = await wa.readPage("ghost/page")
    expect(page).toBeNull()
  })
})

/* ────────────────────────────────────────────────
 * writePage
 * ────────────────────────────────────────────────*/

describe("FileSystemWikiAccess — writePage", () => {
  const today = new Date().toISOString().slice(0, 10)

  it("creates a new page with full frontmatter + body", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    const result = await wa.writePage({
      slug: "concepts/foo",
      type: "concept",
      title: "Foo",
      body: "# Foo\n\nbody.",
      related: ["bar"],
      tags: ["llm"],
    })
    expect(result).toEqual({ kind: "created", path: `${WIKI}/concepts/foo.md` })
    const written = fs.files.get(`${WIKI}/concepts/foo.md`)!
    expect(written).toContain("type: concept")
    expect(written).toContain("title: Foo")
    expect(written).toContain(`created: ${today}`)
    expect(written).toContain(`updated: ${today}`)
    expect(written).toContain("# Foo")
  })

  it("orders frontmatter keys: type → title → created → updated → tags → related → sources", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    await wa.writePage({
      slug: "a",
      type: "note",
      title: "T",
      body: "x",
      related: ["r"],
      tags: ["g"],
    })
    const written = fs.files.get(`${WIKI}/a.md`)!
    const fmBlock = written.match(/^---\n([\s\S]*?)\n---/)![1]
    const keysInOrder = fmBlock.split("\n").map((l) => l.split(":")[0]).filter(Boolean)
    expect(keysInOrder).toEqual(["type", "title", "created", "updated", "tags", "related"])
  })

  it("returns slug_taken when the file already exists", async () => {
    setFile(`${WIKI}/foo.md`, "---\ntype: note\ntitle: Foo\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const result = await wa.writePage({
      slug: "foo",
      type: "note",
      title: "Foo new",
      body: "different",
    })
    expect(result).toEqual({ kind: "slug_taken" })
    expect(fs.files.get(`${WIKI}/foo.md`)).toMatch(/title: Foo$/m)  // unchanged
  })

  it("returns validation_failed for empty type / title", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    expect(
      await wa.writePage({ slug: "a", type: " ", title: "T", body: "x" }),
    ).toMatchObject({ kind: "validation_failed", detail: expect.stringMatching(/type/) })
    expect(
      await wa.writePage({ slug: "a", type: "note", title: "", body: "x" }),
    ).toMatchObject({ kind: "validation_failed", detail: expect.stringMatching(/title/) })
  })

  it("omits empty tags / related from frontmatter", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    await wa.writePage({ slug: "a", type: "note", title: "T", body: "x" })
    const written = fs.files.get(`${WIKI}/a.md`)!
    expect(written).not.toContain("tags:")
    expect(written).not.toContain("related:")
  })

  it("deduplicates entries in related / tags before writing", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    await wa.writePage({
      slug: "a",
      type: "note",
      title: "T",
      body: "x",
      related: ["b", "b", "c"],
      tags: ["t1", "t1"],
    })
    const written = fs.files.get(`${WIKI}/a.md`)!
    // The yaml dump format may be flow [b, c] or block "- b\n- c"; check both.
    expect(written).toMatch(/related:.*\bb\b/)
    expect(written).toMatch(/related:.*\bc\b/)
    expect((written.match(/\bb\b/g) ?? []).length).toBe(1)  // not duplicated
  })
})

/* ────────────────────────────────────────────────
 * updatePage
 * ────────────────────────────────────────────────*/

describe("FileSystemWikiAccess — updatePage", () => {
  it("replaces body, preserves type/title/created, bumps updated", async () => {
    setFile(
      `${WIKI}/a.md`,
      "---\ntype: note\ntitle: A\ncreated: 2024-01-01\nupdated: 2024-01-01\n---\n\nOLD BODY",
    )
    const today = new Date().toISOString().slice(0, 10)
    const wa = new FileSystemWikiAccess(PROJECT)
    const result = await wa.updatePage({
      slug: "a",
      body: "NEW BODY",
    })
    expect(result).toMatchObject({ kind: "updated", path: `${WIKI}/a.md` })
    const written = fs.files.get(`${WIKI}/a.md`)!
    expect(written).toContain("type: note")
    expect(written).toContain("title: A")
    expect(written).toContain("created: 2024-01-01")  // preserved
    expect(written).toContain(`updated: ${today}`)
    expect(written).toContain("NEW BODY")
    expect(written).not.toContain("OLD BODY")
  })

  it("union-merges related + tags with existing", async () => {
    setFile(
      `${WIKI}/a.md`,
      "---\ntype: note\ntitle: A\nrelated: [b, c]\ntags: [x, y]\n---\n\nbody",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    await wa.updatePage({
      slug: "a",
      body: "body",
      related: ["c", "d"],  // c is dup
      tags: ["y", "z"],     // y is dup
    })
    const written = fs.files.get(`${WIKI}/a.md`)!
    expect(written).toMatch(/related:.*\b[bcd]\b.*\b[bcd]\b.*\b[bcd]\b/)
    // Each appears exactly once
    expect((written.match(/\bb\b/g) ?? []).length).toBe(1)
    expect((written.match(/\bc\b/g) ?? []).length).toBe(1)
    expect((written.match(/\bd\b/g) ?? []).length).toBe(1)
  })

  it("preserves arbitrary frontmatter keys (sources, custom)", async () => {
    setFile(
      `${WIKI}/a.md`,
      "---\ntype: note\ntitle: A\nsources: [raw/sources/foo.md]\ncustom: hello\n---\n\nbody",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    await wa.updatePage({ slug: "a", body: "new" })
    const written = fs.files.get(`${WIKI}/a.md`)!
    expect(written).toContain("sources:")
    expect(written).toContain("raw/sources/foo.md")
    expect(written).toMatch(/custom:\s*hello/)
  })

  it("returns added_chars = max(0, new - old)", async () => {
    setFile(
      `${WIKI}/a.md`,
      "---\ntype: note\ntitle: A\n---\n\noriginal",
    )
    const wa = new FileSystemWikiAccess(PROJECT)
    const grew = await wa.updatePage({ slug: "a", body: "much longer body here" })
    expect(grew).toMatchObject({ added_chars: "much longer body here".length - "original".length })
    const shrank = await wa.updatePage({ slug: "a", body: "x" })
    expect(shrank).toMatchObject({ added_chars: 0 })
  })

  it("returns slug_not_found when the page doesn't exist", async () => {
    const wa = new FileSystemWikiAccess(PROJECT)
    const r = await wa.updatePage({ slug: "ghost", body: "x" })
    expect(r).toEqual({ kind: "slug_not_found" })
  })
})

/* ────────────────────────────────────────────────
 * linkPages
 * ────────────────────────────────────────────────*/

describe("FileSystemWikiAccess — linkPages", () => {
  it("adds to from's related (forward only by default)", async () => {
    setFile(`${WIKI}/a.md`, "---\ntype: note\ntitle: A\n---\n\nx")
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const r = await wa.linkPages({ from: "a", to: "b" })
    expect(r).toEqual({ kind: "linked", from_was_new: true })
    expect(fs.files.get(`${WIKI}/a.md`)!).toMatch(/related:\s*\n?\s*[-\[]\s*b/)
    // b's file unchanged
    expect(fs.files.get(`${WIKI}/b.md`)).not.toContain("related")
  })

  it("bidirectional=true updates both pages", async () => {
    setFile(`${WIKI}/a.md`, "---\ntype: note\ntitle: A\n---\n\nx")
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const r = await wa.linkPages({ from: "a", to: "b", bidirectional: true })
    expect(r).toEqual({ kind: "linked", from_was_new: true, to_was_new: true })
    expect(fs.files.get(`${WIKI}/a.md`)!).toMatch(/b/)
    expect(fs.files.get(`${WIKI}/b.md`)!).toMatch(/related:.*a/)
  })

  it("idempotent: re-linking a pair reports was_new=false and doesn't touch the file", async () => {
    setFile(`${WIKI}/a.md`, "---\ntype: note\ntitle: A\nrelated: [b]\n---\n\nbody")
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nx")
    const before = fs.files.get(`${WIKI}/a.md`)!
    const wa = new FileSystemWikiAccess(PROJECT)
    const r = await wa.linkPages({ from: "a", to: "b" })
    expect(r).toEqual({ kind: "linked", from_was_new: false })
    expect(fs.files.get(`${WIKI}/a.md`)).toBe(before)
  })

  it("slug_not_found.missing identifies which side was wrong", async () => {
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nx")
    const wa = new FileSystemWikiAccess(PROJECT)
    const r1 = await wa.linkPages({ from: "ghost", to: "b" })
    expect(r1).toEqual({ kind: "slug_not_found", missing: "from" })
    const r2 = await wa.linkPages({ from: "b", to: "ghost" })
    expect(r2).toEqual({ kind: "slug_not_found", missing: "to" })
  })

  it("bidirectional + one side already linked → only the other is new", async () => {
    setFile(`${WIKI}/a.md`, "---\ntype: note\ntitle: A\nrelated: [b]\n---\n\nbody")
    setFile(`${WIKI}/b.md`, "---\ntype: note\ntitle: B\n---\n\nbody")
    const wa = new FileSystemWikiAccess(PROJECT)
    const r = await wa.linkPages({ from: "a", to: "b", bidirectional: true })
    expect(r).toEqual({ kind: "linked", from_was_new: false, to_was_new: true })
  })
})
