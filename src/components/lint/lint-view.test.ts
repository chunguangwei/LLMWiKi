import { describe, expect, it } from "vitest"
import {
  groupByType,
  groupLintResultsForDisplay,
  isRateLimitError,
  rateLimitBackoffMs,
  shouldShowLintResults,
} from "./lint-view"
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

describe("isRateLimitError", () => {
  it("detects the Anthropic HTTP 429 string the user actually saw", () => {
    const err = new Error(
      'agent LLM call failed: HTTP 429 Too Many Requests — {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan ..."}}',
    )
    expect(isRateLimitError(err)).toBe(true)
  })

  it("detects 'rate_limit_exceeded' (OpenAI-style)", () => {
    expect(isRateLimitError(new Error("openai: rate_limit_exceeded"))).toBe(true)
    expect(isRateLimitError(new Error("rate-limit-exceeded"))).toBe(true)
  })

  it("detects bilingual Chinese reseller phrasings", () => {
    expect(isRateLimitError(new Error("当前请求量较高，请稍后重试"))).toBe(true)
    expect(isRateLimitError(new Error("超过当前套餐的并发限制"))).toBe(true)
  })

  it("does NOT flag unrelated errors as rate-limit", () => {
    expect(isRateLimitError(new Error("schema mismatch in tool result"))).toBe(false)
    expect(isRateLimitError(new Error("HTTP 500 Internal Server Error"))).toBe(false)
    expect(isRateLimitError(new Error("AbortError"))).toBe(false)
  })

  it("handles non-Error inputs without throwing", () => {
    expect(isRateLimitError("just a string")).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
  })
})

describe("rateLimitBackoffMs", () => {
  it("returns 5s, 15s, 30s for attempts 1..3", () => {
    expect(rateLimitBackoffMs(1)).toBe(5_000)
    expect(rateLimitBackoffMs(2)).toBe(15_000)
    expect(rateLimitBackoffMs(3)).toBe(30_000)
  })

  it("caps at 30s for further attempts", () => {
    expect(rateLimitBackoffMs(4)).toBe(30_000)
    expect(rateLimitBackoffMs(100)).toBe(30_000)
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
