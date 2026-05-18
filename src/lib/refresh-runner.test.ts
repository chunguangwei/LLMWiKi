import { describe, expect, it } from "vitest"
import { isDue, readRefreshConfig, upsertField } from "./refresh-runner"

describe("upsertField", () => {
  it("replaces an existing key in a frontmatter block", () => {
    const block = `---\ntitle: Foo\nrefresh-last-result: pending-review\n---\n`
    const out = upsertField(block, "refresh-last-result", "ok")
    expect(out).toContain("refresh-last-result: ok")
    expect(out).not.toContain("pending-review")
    expect(out).toContain("title: Foo")
  })

  it("inserts a new key before the closing fence when absent", () => {
    const block = `---\ntitle: Foo\n---\n`
    const out = upsertField(block, "refresh-last-result", "ok")
    expect(out).toContain("refresh-last-result: ok")
    expect(out.endsWith("---\n")).toBe(true)
    expect(out).toContain("title: Foo")
  })

  it("does not corrupt multi-line YAML when replacing one field", () => {
    const block = `---\ntitle: Foo\ntags:\n  - a\n  - b\nrefresh-last-result: pending-review\n---\n`
    const out = upsertField(block, "refresh-last-result", "ok")
    expect(out).toContain("tags:\n  - a\n  - b")
    expect(out).toContain("refresh-last-result: ok")
  })

  it("only replaces the targeted key, not similarly-named ones", () => {
    const block = `---\nrefresh-last-result: pending-review\nrefresh-last-refreshed: 2026-01-01\n---\n`
    const out = upsertField(block, "refresh-last-result", "ok")
    expect(out).toContain("refresh-last-result: ok")
    // The other field must survive untouched.
    expect(out).toContain("refresh-last-refreshed: 2026-01-01")
  })
})

describe("readRefreshConfig", () => {
  it("returns disabled defaults for an empty frontmatter", () => {
    const cfg = readRefreshConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.intervalDays).toBe(7)
    expect(cfg.queries).toEqual([])
    expect(cfg.lastRefreshed).toBeNull()
    expect(cfg.lastResult).toBeNull()
  })

  it("coerces string booleans (the frontmatter parser stringifies scalars)", () => {
    const cfg = readRefreshConfig({ "refresh-enabled": "true" })
    expect(cfg.enabled).toBe(true)
  })

  it("clamps absurd interval values into a sane range", () => {
    expect(readRefreshConfig({ "refresh-interval-days": "0" }).intervalDays).toBe(7)
    expect(readRefreshConfig({ "refresh-interval-days": "9999" }).intervalDays).toBe(365)
    expect(readRefreshConfig({ "refresh-interval-days": "garbage" }).intervalDays).toBe(7)
  })

  it("accepts queries as an array", () => {
    const cfg = readRefreshConfig({
      "refresh-queries": ["q1", "q2"],
    })
    expect(cfg.queries).toEqual(["q1", "q2"])
  })

  it("treats a single-string query field as a one-element array (legacy hand-edited YAML)", () => {
    const cfg = readRefreshConfig({
      "refresh-queries": "just one",
    })
    expect(cfg.queries).toEqual(["just one"])
  })
})

describe("isDue", () => {
  it("is never due when disabled", () => {
    expect(isDue({ enabled: false, intervalDays: 1, queries: [], lastRefreshed: null, lastResult: null }, 0)).toBe(false)
  })

  it("is due when never refreshed before", () => {
    expect(isDue({ enabled: true, intervalDays: 7, queries: [], lastRefreshed: null, lastResult: null }, 0)).toBe(true)
  })

  it("respects the interval window", () => {
    const oneDayMs = 24 * 60 * 60 * 1000
    const lastRefreshed = new Date(0).toISOString()
    const dayBeforeDue = 6.5 * oneDayMs
    const dayAfterDue = 7.5 * oneDayMs
    const cfg = { enabled: true, intervalDays: 7, queries: [], lastRefreshed, lastResult: null }
    expect(isDue(cfg, dayBeforeDue)).toBe(false)
    expect(isDue(cfg, dayAfterDue)).toBe(true)
  })

  it("treats an unparseable lastRefreshed as 'due now' rather than throwing", () => {
    expect(
      isDue({ enabled: true, intervalDays: 7, queries: [], lastRefreshed: "not-a-date", lastResult: null }, 0),
    ).toBe(true)
  })
})
