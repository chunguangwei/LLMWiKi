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

/* ────────────────────────────────────────────────
 * Index auto-add (missing entries)
 * ────────────────────────────────────────────────*/

function typedPage(type: string, title: string, body = "x"): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`
}

describe("reconcileWiki — index.md auto-add (missing knowledge pages)", () => {
  it("adds missing concept pages to the Concepts section", async () => {
    setFile(`${WIKI}/index.md`, [
      "# Wiki Index",
      "",
      "## Concepts",
      "- [[concepts/foo|Foo]]",
      "",
    ].join("\n"))
    setFile(`${WIKI}/concepts/foo.md`, typedPage("concept", "Foo"))
    setFile(`${WIKI}/concepts/transformer.md`, typedPage("concept", "Transformer"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
        pageNode("transformer.md", `${WIKI}/concepts/transformer.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsAdded).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).toMatch(/- \[\[concepts\/foo\|Foo\]\]/)  // existing entry preserved
    expect(idx).toMatch(/- \[\[concepts\/transformer\|Transformer\]\]/)
  })

  it("creates the Entities section if it doesn't exist yet", async () => {
    // The Notes section already lists a real page — it should stay
    // verbatim while the new Entities section gets appended below.
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n## Notes\n\n- [[notes/intro]]\n")
    setFile(`${WIKI}/notes/intro.md`, typedPage("note", "Intro"))
    setFile(`${WIKI}/entities/openai.md`, typedPage("entity", "OpenAI"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("notes", `${WIKI}/notes`, [
        pageNode("intro.md", `${WIKI}/notes/intro.md`),
      ]),
      dirNode("entities", `${WIKI}/entities`, [
        pageNode("openai.md", `${WIKI}/entities/openai.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsAdded).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).toMatch(/## Entities/)
    expect(idx).toMatch(/- \[\[entities\/openai\|OpenAI\]\]/)
    // Existing Notes section untouched.
    expect(idx).toMatch(/## Notes\n\n- \[\[notes\/intro\]\]/)
  })

  it("is idempotent: re-running adds nothing the second time", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n")
    setFile(`${WIKI}/concepts/foo.md`, typedPage("concept", "Foo"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
      ]),
    ])

    const first = await reconcileWiki(PROJECT)
    expect(first.totalIndexRowsAdded).toBe(1)
    const afterFirst = fs.files.get(`${WIKI}/index.md`)!

    const second = await reconcileWiki(PROJECT)
    expect(second.totalIndexRowsAdded).toBe(0)
    expect(fs.files.get(`${WIKI}/index.md`)).toBe(afterFirst)
  })

  it("recognises a localised section heading and adds under it", async () => {
    setFile(`${WIKI}/index.md`, "# 知识索引\n\n## 概念\n\n- [[concepts/foo]]\n")
    setFile(`${WIKI}/concepts/foo.md`, typedPage("concept", "Foo"))
    setFile(`${WIKI}/concepts/bar.md`, typedPage("concept", "Bar"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
        pageNode("bar.md", `${WIKI}/concepts/bar.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsAdded).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    // No duplicate Concepts section created — the 概念 heading stays.
    expect(idx).toMatch(/## 概念/)
    expect(idx).not.toMatch(/## Concepts/)
    expect(idx).toMatch(/- \[\[concepts\/bar\|Bar\]\]/)
  })

  it("skips non-knowledge types (queries/, raw/, sources/, notes)", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n")
    setFile(`${WIKI}/queries/q.md`, typedPage("query", "Q"))
    setFile(`${WIKI}/raw/r.md`, typedPage("note", "R"))
    setFile(`${WIKI}/notes/n.md`, typedPage("note", "N"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("queries", `${WIKI}/queries`, [
        pageNode("q.md", `${WIKI}/queries/q.md`),
      ]),
      dirNode("raw", `${WIKI}/raw`, [
        pageNode("r.md", `${WIKI}/raw/r.md`),
      ]),
      dirNode("notes", `${WIKI}/notes`, [
        pageNode("n.md", `${WIKI}/notes/n.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsAdded).toBe(0)
  })

  it("synthesises a new index.md when missing AND there are candidates", async () => {
    setFile(`${WIKI}/concepts/foo.md`, typedPage("concept", "Foo"))
    setTree(WIKI, [
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsAdded).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)
    expect(idx).toBeDefined()
    expect(idx!).toMatch(/## Concepts/)
    expect(idx!).toMatch(/- \[\[concepts\/foo\|Foo\]\]/)
  })

  it("does NOT synthesise an index.md when wiki has no candidates", async () => {
    // No knowledge-type pages → no index drift to fix → no new file.
    setFile(`${WIKI}/notes/n.md`, typedPage("note", "N"))
    setTree(WIKI, [
      dirNode("notes", `${WIKI}/notes`, [
        pageNode("n.md", `${WIKI}/notes/n.md`),
      ]),
    ])

    await reconcileWiki(PROJECT)
    expect(fs.files.has(`${WIKI}/index.md`)).toBe(false)
  })

  it("drops broken rows AND adds missing rows in the same pass", async () => {
    setFile(`${WIKI}/index.md`, [
      "# Wiki Index",
      "",
      "## Concepts",
      "- [[concepts/ghost]]",
      "",
    ].join("\n"))
    setFile(`${WIKI}/concepts/real.md`, typedPage("concept", "Real"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("real.md", `${WIKI}/concepts/real.md`),
      ]),
    ])

    const r = await reconcileWiki(PROJECT)
    expect(r.totalIndexRowsDropped).toBe(1)
    expect(r.totalIndexRowsAdded).toBe(1)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).not.toMatch(/ghost/)
    expect(idx).toMatch(/- \[\[concepts\/real\|Real\]\]/)
  })

  it("uses bare [[slug]] when title equals the last slug segment", async () => {
    // Tidiness: if title === filename, don't bother with the `|alias`.
    setFile(`${WIKI}/index.md`, "# Wiki Index\n")
    setFile(`${WIKI}/concepts/foo.md`, typedPage("concept", "foo"))
    setTree(WIKI, [
      pageNode("index.md", `${WIKI}/index.md`),
      dirNode("concepts", `${WIKI}/concepts`, [
        pageNode("foo.md", `${WIKI}/concepts/foo.md`),
      ]),
    ])

    await reconcileWiki(PROJECT)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).toMatch(/- \[\[concepts\/foo\]\]/)
    expect(idx).not.toMatch(/\[\[concepts\/foo\|foo\]\]/)
  })
})
