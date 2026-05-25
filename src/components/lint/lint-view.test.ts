import { describe, expect, it } from "vitest"
import { groupLintResultsForDisplay } from "./lint-view"
import type { LintItem } from "@/stores/lint-store"

function makeLintItem(
  page: string,
  severity: "warning" | "info",
  index: number,
): LintItem {
  return {
    id: `lint-${index}`,
    type: severity === "warning" ? "broken-link" : "orphan",
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
