import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  clearSuppressions,
  findingKey,
  loadSuppressions,
  partitionBySuppression,
  recordAttempt,
  recordAttempts,
} from "./lint-suppressions"

type FsState = { files: Map<string, string> }
let fs: FsState = { files: new Map() }

vi.mock("@/commands/fs", () => ({
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
}))

beforeEach(() => {
  fs = { files: new Map() }
})

const PROJECT = "/p"

describe("findingKey", () => {
  it("uses target slug for broken-link (collapses sources)", () => {
    const a = findingKey({
      type: "broken-link",
      page: "concepts/foo.md",
      detail: "Broken link: [[领导梯队]] — target page not found.",
    })
    const b = findingKey({
      type: "broken-link",
      page: "concepts/bar.md",  // different source page
      detail: "Broken link: [[领导梯队]] — target page not found, referenced from 7 pages.",
    })
    expect(a).toBe(b)
  })

  it("uses page for orphan / no-outlinks", () => {
    expect(findingKey({ type: "orphan", page: "X.md", detail: "..." })).toBe("orphan::x.md")
    expect(findingKey({ type: "no-outlinks", page: "X.md", detail: "..." })).toBe("no-outlinks::x.md")
  })

  it("combines page + detail prefix for semantic", () => {
    const k1 = findingKey({ type: "semantic", page: "x.md", detail: "Specific gap A" })
    const k2 = findingKey({ type: "semantic", page: "x.md", detail: "Specific gap B" })
    expect(k1).not.toBe(k2)
  })

  it("is case-insensitive", () => {
    expect(findingKey({ type: "orphan", page: "Foo.md", detail: "" })).toBe(
      findingKey({ type: "orphan", page: "foo.md", detail: "" }),
    )
  })
})

describe("loadSuppressions", () => {
  it("returns {} when the file is missing", async () => {
    expect(await loadSuppressions(PROJECT)).toEqual({})
  })

  it("parses a saved suppressions file", async () => {
    fs.files.set(
      `${PROJECT}/.llm-wiki/lint-suppressions.json`,
      JSON.stringify({ "orphan::a.md": { attemptedAt: "2026-06-01", page: "a.md", type: "orphan", detailSnippet: "..." } }),
    )
    const s = await loadSuppressions(PROJECT)
    expect(s["orphan::a.md"]).toMatchObject({ page: "a.md", type: "orphan" })
  })

  it("returns {} when the file is corrupt", async () => {
    fs.files.set(`${PROJECT}/.llm-wiki/lint-suppressions.json`, "not json{")
    expect(await loadSuppressions(PROJECT)).toEqual({})
  })
})

describe("recordAttempt / recordAttempts", () => {
  it("appends a new suppression key with today's date", async () => {
    await recordAttempt(PROJECT, { type: "orphan", page: "x.md", detail: "..." })
    const s = await loadSuppressions(PROJECT)
    expect(s["orphan::x.md"]).toBeDefined()
    expect(s["orphan::x.md"].attemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("recordAttempts handles many in one I/O round-trip", async () => {
    await recordAttempts(PROJECT, [
      { type: "orphan", page: "a.md", detail: "..." },
      { type: "no-outlinks", page: "b.md", detail: "..." },
      { type: "broken-link", page: "c.md", detail: "Broken link: [[ghost]] — ..." },
    ])
    const s = await loadSuppressions(PROJECT)
    expect(Object.keys(s)).toHaveLength(3)
    expect(s["broken-link::ghost"]).toBeDefined()
  })

  it("is idempotent — re-recording same finding refreshes only the date", async () => {
    await recordAttempt(PROJECT, { type: "orphan", page: "x.md", detail: "..." })
    await recordAttempt(PROJECT, { type: "orphan", page: "X.md", detail: "..." })  // case-insensitive
    const s = await loadSuppressions(PROJECT)
    expect(Object.keys(s)).toHaveLength(1)
  })
})

describe("partitionBySuppression", () => {
  it("splits findings into visible vs hidden by key", () => {
    const suppressions = {
      "orphan::a.md": { attemptedAt: "2026-06-01", page: "a.md", type: "orphan" as const, detailSnippet: "" },
    }
    const findings = [
      { type: "orphan" as const, page: "a.md", detail: "no inbound" },
      { type: "orphan" as const, page: "b.md", detail: "no inbound" },
    ]
    const { visible, hidden } = partitionBySuppression(findings, suppressions)
    expect(visible).toEqual([findings[1]])
    expect(hidden).toEqual([findings[0]])
  })

  it("returns everything visible when suppressions are empty", () => {
    const findings = [{ type: "orphan" as const, page: "a.md", detail: "" }]
    expect(partitionBySuppression(findings, {})).toEqual({
      visible: findings,
      hidden: [],
    })
  })
})

describe("clearSuppressions", () => {
  it("wipes the on-disk state", async () => {
    await recordAttempt(PROJECT, { type: "orphan", page: "x.md", detail: "..." })
    expect(Object.keys(await loadSuppressions(PROJECT))).toHaveLength(1)
    await clearSuppressions(PROJECT)
    expect(await loadSuppressions(PROJECT)).toEqual({})
  })
})
