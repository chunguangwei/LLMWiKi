import { describe, expect, it } from "vitest"
import { groupByType, groupLintResultsForDisplay, shouldShowLintResults } from "./lint-view"
import type { LintItem } from "@/stores/lint-store"

function makeLintItem(
  page: string,
  severity: "warning" | "info",
  index: number,
  type?: LintItem["type"],
): LintItem {
  return {
    id: `lint-${index}`,
    type: type ?? (severity === "warning" ? "broken-link" : "orphan"),
    severity,
    page,
    detail: `${page} detail`,
    createdAt: Date.now(),
  }
}

describe("groupLintResultsForDisplay", () => {
  it("groups warnings and infos separately", () => {
    const items: LintItem[] = [
      makeLintItem("info-a.md", "info", 0),
      makeLintItem("warning-b.md", "warning", 1),
      makeLintItem("info-c.md", "info", 2),
      makeLintItem("warning-d.md", "warning", 3),
    ]

    const grouped = groupLintResultsForDisplay(items)

    expect(grouped.warnings.map((item) => item.page)).toEqual([
      "warning-b.md",
      "warning-d.md",
    ])
    expect(grouped.infos.map((item) => item.page)).toEqual([
      "info-a.md",
      "info-c.md",
    ])
  })
})

describe("groupByType", () => {
  it("buckets items by their type, preserving order within a bucket", () => {
    const items: LintItem[] = [
      makeLintItem("a.md", "warning", 0, "broken-link"),
      makeLintItem("b.md", "warning", 1, "broken-link"),
      makeLintItem("c.md", "info", 2, "orphan"),
    ]
    const groups = groupByType(items)
    expect(groups).toHaveLength(2)
    expect(groups[0].type).toBe("broken-link")
    expect(groups[0].items.map((i) => i.page)).toEqual(["a.md", "b.md"])
    expect(groups[1].type).toBe("orphan")
    expect(groups[1].items.map((i) => i.page)).toEqual(["c.md"])
  })

  it("sorts groups by descending count, then by canonical type order", () => {
    const items: LintItem[] = [
      makeLintItem("o1.md", "info", 0, "orphan"),
      makeLintItem("o2.md", "info", 1, "orphan"),
      makeLintItem("o3.md", "info", 2, "orphan"),
      makeLintItem("nl1.md", "info", 3, "no-outlinks"),
      makeLintItem("b1.md", "warning", 4, "broken-link"),
      makeLintItem("b2.md", "warning", 5, "broken-link"),
      makeLintItem("b3.md", "warning", 6, "broken-link"),
    ]
    const groups = groupByType(items)
    expect(groups.map((g) => g.type)).toEqual(["broken-link", "orphan", "no-outlinks"])
    // ties (broken-link 3 vs orphan 3) → canonical order picks broken-link first.
  })

  it("returns empty array when the input is empty", () => {
    expect(groupByType([])).toEqual([])
  })
})

describe("shouldShowLintResults", () => {
  it("shows restored persisted lint items before a new run in the current view", () => {
    expect(shouldShowLintResults(false, 2)).toBe(true)
  })

  it("keeps the first-run empty prompt when no run has happened and nothing was restored", () => {
    expect(shouldShowLintResults(false, 0)).toBe(false)
  })

  it("shows the all-clear state after a run with no items", () => {
    expect(shouldShowLintResults(true, 0)).toBe(true)
  })
})
