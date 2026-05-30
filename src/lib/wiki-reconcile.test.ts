import { describe, it, expect, vi, beforeEach } from "vitest"
import { reconcileWiki } from "./wiki-reconcile"
import type { FileNode } from "@/types/wiki"

/* in-memory fs mock — same pattern as agent-ingest end-to-end test */
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
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: file not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
  listDirectory: async (p: string) => {
    const t = fs.tree.get(p)
    if (!t) throw new Error(`mock fs: dir not in tree: ${p}`)
    return t
  },
}))

const PROJECT = "/p"
const WIKI = "/p/wiki"

beforeEach(() => {
  fs = { files: new Map(), tree: new Map() }
})

function pageNode(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}
function dirNode(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children }
}

function page(title: string, body: string, related?: string[]): string {
  const fm: string[] = ["---", `title: ${title}`]
  if (related && related.length > 0) {
    fm.push(`related: [${related.join(", ")}]`)
  }
  fm.push("---", "")
  return fm.join("\n") + body + "\n"
}

describe("reconcileWiki — broken wikilinks in body", () => {
  it("replaces broken [[X]] with plain text X, keeps valid ones", async () => {
    setFile(`${WIKI}/concepts/foo.md`, page(
      "Foo",
      "Foo references [[bar]] (real) and [[ghost]] (broken). Also [[missing|labelled link]]."
    ))
    setFile(`${WIKI}/concepts/bar.md`, page("Bar", "stub"))
    setTree(WIKI, [
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
        pageNode("bar.md", `${WIKI}/concepts/bar.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)

    expect(r.totalBrokenWikilinksReplaced).toBe(2)
    expect(r.filesScanned).toBe(2)
    expect(fs.files.get(`${WIKI}/concepts/foo.md`)).toMatch(
      /references \[\[bar\]\] \(real\) and ghost \(broken\)/,
    )
    expect(fs.files.get(`${WIKI}/concepts/foo.md`)).toMatch(/labelled link/)
    // bar.md unchanged (no broken links)
    expect(fs.files.get(`${WIKI}/concepts/bar.md`)).toMatch(/^---\n/)
  })

  it("preserves the displayed alias when the link is [[X|alias]]", async () => {
    setFile(`${WIKI}/a.md`, page("A", "See [[missing|My Custom Label]] for details."))
    setTree(WIKI, [pageNode("a.md", `${WIKI}/a.md`)])

    await reconcileWiki(PROJECT)
    expect(fs.files.get(`${WIKI}/a.md`)).toMatch(/See My Custom Label for details/)
  })
})

describe("reconcileWiki — dangling related: entries", () => {
  it("removes only the missing related slugs, keeps the rest", async () => {
    setFile(`${WIKI}/concepts/foo.md`, page("Foo", "body", ["bar", "ghost", "concepts/bar"]))
    setFile(`${WIKI}/concepts/bar.md`, page("Bar", "stub"))
    setTree(WIKI, [
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
        pageNode("bar.md", `${WIKI}/concepts/bar.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalRelatedEntriesRemoved).toBe(1)  // only "ghost" removed
    const out = fs.files.get(`${WIKI}/concepts/foo.md`)!
    expect(out).toMatch(/related: \[bar, concepts\/bar\]/)
    expect(out).not.toMatch(/ghost/)
  })

  it("deletes the related key entirely when every entry was broken", async () => {
    setFile(`${WIKI}/foo.md`, page("Foo", "body", ["ghost-a", "ghost-b"]))
    setTree(WIKI, [pageNode("foo.md", `${WIKI}/foo.md`)])

    await reconcileWiki(PROJECT)
    expect(fs.files.get(`${WIKI}/foo.md`)).not.toMatch(/related:/)
  })
})

describe("reconcileWiki — index.md sweep", () => {
  it("drops index rows whose [[target]] points at a non-existent page", async () => {
    setFile(`${WIKI}/index.md`, [
      "# Wiki Index",
      "",
      "## Concepts",
      "- [[concepts/foo]]",
      "- [[concepts/ghost]]",
      "- [[concepts/bar]]",
      "",
      "## Notes",
      "Some user prose, no wikilink — preserved.",
    ].join("\n"))
    setFile(`${WIKI}/concepts/foo.md`, page("Foo", "x"))
    setFile(`${WIKI}/concepts/bar.md`, page("Bar", "y"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
        pageNode("bar.md", `${WIKI}/concepts/bar.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsDropped).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).toMatch(/- \[\[concepts\/foo\]\]/)
    expect(idx).toMatch(/- \[\[concepts\/bar\]\]/)
    expect(idx).not.toMatch(/ghost/)
    expect(idx).toMatch(/Some user prose, no wikilink — preserved/)
  })
})

describe("reconcileWiki — fuzzy date-suffix slug alias", () => {
  it("resolves [[topic]] to topic-20260520 via the trailing-date alias", async () => {
    setFile(
      `${WIKI}/queries/openclaw-summary-20260520.md`,
      page("OpenClaw", "stub"),
    )
    setFile(
      `${WIKI}/concepts/related.md`,
      page("Related concept", "References [[openclaw-summary]] in passing."),
    )
    setTree(WIKI, [
      dirNode("queries", `${WIKI}/queries`, [
        pageNode(
          "openclaw-summary-20260520.md",
          `${WIKI}/queries/openclaw-summary-20260520.md`,
        ),
      ]),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("related.md", `${WIKI}/concepts/related.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    // The [[openclaw-summary]] reference should resolve via the date-
    // suffix alias — no replacement happens.
    expect(r.totalBrokenWikilinksReplaced).toBe(0)
    expect(fs.files.get(`${WIKI}/concepts/related.md`)).toMatch(
      /\[\[openclaw-summary\]\]/,
    )
  })
})

describe("reconcileWiki — skip-edit prefixes", () => {
  it("never modifies queries/ or sources/ files even when they have broken refs", async () => {
    setFile(`${WIKI}/queries/q1.md`, page("Q1", "References [[ghost]]."))
    setFile(`${WIKI}/sources/raw.md`, page("Raw", "References [[also-ghost]]."))
    setTree(WIKI, [
      dirNode("queries", `${WIKI}/queries`, [
        pageNode("q1.md", `${WIKI}/queries/q1.md`),
      ]),
      dirNode("sources", `${WIKI}/sources`, [
        pageNode("raw.md", `${WIKI}/sources/raw.md`),
      ]),
    ])
    const before = new Map(fs.files)
    await reconcileWiki(PROJECT)
    // queries/ + sources/ files unchanged.
    expect(fs.files.get(`${WIKI}/queries/q1.md`)).toBe(before.get(`${WIKI}/queries/q1.md`))
    expect(fs.files.get(`${WIKI}/sources/raw.md`)).toBe(before.get(`${WIKI}/sources/raw.md`))
  })

  it("INCLUDES queries/ pages as resolution targets even though they're not edited", async () => {
    // Setup: a knowledge page references a queries/ page. Without
    // resolving queries/ as a target, the wikilink would look broken
    // and get stripped.
    setFile(`${WIKI}/queries/my-q.md`, page("My Q", "stub"))
    setFile(`${WIKI}/concepts/c.md`, page("C", "See [[queries/my-q]] for the original question."))
    setTree(WIKI, [
      dirNode("queries", `${WIKI}/queries`, [
        pageNode("my-q.md", `${WIKI}/queries/my-q.md`),
      ]),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("c.md", `${WIKI}/concepts/c.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalBrokenWikilinksReplaced).toBe(0)
    expect(fs.files.get(`${WIKI}/concepts/c.md`)).toMatch(/\[\[queries\/my-q\]\]/)
  })
})

describe("reconcileWiki — dry-run", () => {
  it("returns the change set without writing", async () => {
    setFile(`${WIKI}/foo.md`, page("Foo", "[[ghost]] reference."))
    setTree(WIKI, [pageNode("foo.md", `${WIKI}/foo.md`)])
    const before = fs.files.get(`${WIKI}/foo.md`)!

    const r = await reconcileWiki(PROJECT, { dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.totalBrokenWikilinksReplaced).toBe(1)
    expect(r.changes[0].diffPreview).toBeDefined()
    expect(r.changes[0].diffPreview!.before).toBe(before)
    expect(r.changes[0].diffPreview!.after).toMatch(/ghost reference/)
    expect(r.changes[0].diffPreview!.after).not.toMatch(/\[\[ghost\]\]/)
    // File on disk is unchanged.
    expect(fs.files.get(`${WIKI}/foo.md`)).toBe(before)
  })
})

describe("reconcileWiki — no-op cases", () => {
  it("returns an empty result when wiki/ doesn't exist", async () => {
    // No tree set → listDirectory throws.
    const r = await reconcileWiki(PROJECT)
    expect(r.filesScanned).toBe(0)
    expect(r.changes).toEqual([])
  })

  it("skips log.md (history file, append-only)", async () => {
    setFile(`${WIKI}/log.md`, "# Log\n\n- 2026-05-30: [[ghost]] referenced\n")
    setTree(WIKI, [pageNode("log.md", `${WIKI}/log.md`)])
    const before = fs.files.get(`${WIKI}/log.md`)
    await reconcileWiki(PROJECT)
    expect(fs.files.get(`${WIKI}/log.md`)).toBe(before)
  })
})
