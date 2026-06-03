import { describe, it, expect } from "vitest"
import { hydrateActivityItems } from "./persist"
import type { ActivityItem } from "@/stores/activity-store"

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    type: "ingest",
    title: "test",
    status: "done",
    detail: "ran fine",
    filesWritten: [],
    createdAt: 0,
    ...over,
  }
}

describe("hydrateActivityItems", () => {
  it("flips stale running entries to error with an interrupted note", () => {
    const out = hydrateActivityItems([
      item({ id: "activity-1", status: "running", detail: "Turn 3 · 8k tokens" }),
    ])
    expect(out[0].status).toBe("error")
    expect(out[0].detail).toMatch(/Interrupted by app reload/i)
    expect(out[0].detail).toMatch(/Turn 3/)  // original detail preserved
  })

  it("leaves done and error items untouched", () => {
    const before: ActivityItem[] = [
      item({ id: "a", status: "done", detail: "ok" }),
      item({ id: "b", status: "error", detail: "boom" }),
    ]
    const after = hydrateActivityItems(before)
    expect(after).toEqual(before)
  })

  it("appends a newline before the marker when detail doesn't end with one", () => {
    const out = hydrateActivityItems([
      item({ status: "running", detail: "line without newline" }),
    ])
    expect(out[0].detail).toBe(
      "line without newline\n⚠️ Interrupted by app reload — original task did not complete.",
    )
  })

  it("does NOT double-up the newline when detail ends with one", () => {
    const out = hydrateActivityItems([
      item({ status: "running", detail: "line with trailing newline\n" }),
    ])
    // Single newline between original detail and the marker — no
    // double-newline artefact.
    expect(out[0].detail).toBe(
      "line with trailing newline\n⚠️ Interrupted by app reload — original task did not complete.",
    )
  })

  it("preserves sourcePath when flipping a reload-killed ingest to error", () => {
    // Resume from the activity panel re-enqueues item.sourcePath. The
    // interruption that needs resuming is exactly a webview reload, so
    // sourcePath MUST survive the running→error hydration that runs at
    // startup — otherwise the Resume button has nothing to act on.
    const out = hydrateActivityItems([
      item({ status: "running", detail: "Analyzing long source chunk 18/937...", sourcePath: "/abs/book.epub" }),
    ])
    expect(out[0].status).toBe("error")
    expect(out[0].sourcePath).toBe("/abs/book.epub")
  })
})
