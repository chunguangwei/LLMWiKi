import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StreamCallbacks } from "./llm-client"

const boundary = vi.hoisted(() => ({
  files: new Map<string, string>(),
  answer: "STATUS=fresh",
  failure: false,
  duringRequest: (() => {}) as () => void | Promise<void>,
  reviews: [] as unknown[],
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (p: string) => {
    const content = boundary.files.get(p)
    if (content === undefined) throw new Error("missing file")
    return content
  }),
  writeFile: vi.fn(async (p: string, content: string) => { boundary.files.set(p, content) }),
}))
vi.mock("@/lib/web-search", () => ({ webSearch: async () => [{ title: "Evidence", url: "https://example.com", snippet: "new information" }] }))
vi.mock("@/lib/llm-client", () => ({ streamChat: async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
  await boundary.duringRequest()
  if (boundary.failure) callbacks.onError(new Error("HTTP 401"))
  else { callbacks.onToken(boundary.answer); callbacks.onDone() }
} }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: { getState: () => ({ llmConfig: {}, searchApiConfig: {} }) } }))
vi.mock("@/stores/review-store", () => ({ useReviewStore: { getState: () => ({ addItem: (item: unknown) => boundary.reviews.push(item) }) } }))
import { runPageRefresh } from "./refresh-runner"
import { withProjectLock } from "./project-mutex"
import { markdownFileSaver } from "./markdown-file-saver"

const page = "/project/wiki/page.md"
const original = '---\ntitle: Page\nrefresh-enabled: true\n---\nOriginal body'
describe("page refresh pipeline", () => {
  beforeEach(async () => {
    await markdownFileSaver.invalidate(page)
    markdownFileSaver.activate(page)
    boundary.files.clear()
    boundary.files.set(page, original)
    boundary.answer = "STATUS=fresh"
    boundary.failure = false
    boundary.duringRequest = () => {}
    boundary.reviews = []
  })
  it("preserves edits saved while the model is running", async () => {
    boundary.duringRequest = () => { boundary.files.set(page, original.replace("Original body", "Edited body")) }
    await runPageRefresh(page)
    expect(boundary.files.get(page)).toContain("Edited body")
    expect(boundary.files.get(page)).not.toContain("refresh-last-refreshed")
  })
  it("preserves a queued editor draft during refresh", async () => {
    boundary.duringRequest = () => { markdownFileSaver.schedule(page, original.replace("Original body", "Draft body")) }
    await runPageRefresh(page)
    await markdownFileSaver.flush(page)
    expect(boundary.files.get(page)).toContain("Draft body")
    expect(boundary.files.get(page)).not.toContain("refresh-last-refreshed")
  })
  it("does not recreate a deleted page", async () => {
    boundary.duringRequest = () => { boundary.files.delete(page) }
    await runPageRefresh(page)
    expect(boundary.files.has(page)).toBe(false)
  })
  it("marks callback failures as errors", async () => {
    boundary.failure = true
    expect(await runPageRefresh(page)).toBe("error")
    expect(boundary.files.get(page)).not.toContain("refresh-last-result: no-change")
    expect(boundary.reviews).toEqual([])
  })
  it.each(["", "looks fresh to me", "STATUS=unknown", "STATUS=fresh\nSTATUS=stale"])("rejects invalid verdict %j", async (answer) => {
    boundary.answer = answer
    expect(await runPageRefresh(page)).toBe("error")
    expect(boundary.files.get(page)).not.toContain("refresh-last-result: no-change")
  })
  it("stamps successful fresh checks without changing body", async () => {
    expect(await runPageRefresh(page)).toBe("no-change")
    expect(boundary.files.get(page)).toContain("refresh-last-result: no-change")
    expect(boundary.files.get(page)).toMatch(/Original body$/)
  })
  it("queues a stale suggestion only for the unchanged page", async () => {
    boundary.answer = "STATUS=stale\n- New evidence [1]"
    expect(await runPageRefresh(page)).toBe("pending-review")
    expect(boundary.reviews).toHaveLength(1)
  })
})

it("uses the actual project lock for a page inside a nested wiki directory", async () => {
  const nested = "/project/wiki/topics/wiki/page.md"
  boundary.files.set(nested, original)
  boundary.answer = "STATUS=fresh"
  boundary.failure = false
  let release!: () => void
  const holding = withProjectLock("/project", () => new Promise<void>((resolve) => { release = resolve }))
  await Promise.resolve()
  let modelStarted!: () => void
  const started = new Promise<void>((resolve) => { modelStarted = resolve })
  boundary.duringRequest = () => { modelStarted() }
  const refreshing = runPageRefresh(nested, "/project")
  try {
    await started
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(boundary.files.get(nested)).not.toContain("refresh-last-refreshed")
  } finally {
    release()
    await holding
    await refreshing
  }
  expect(boundary.files.get(nested)).toContain("refresh-last-result: no-change")
})
