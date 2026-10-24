import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { MarkdownFileSaver, type MarkdownSaveEvent } from "./markdown-file-saver"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("MarkdownFileSaver", () => {
  it("debounces edits and writes only the latest draft", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "first")
    saver.schedule("/wiki/a.md", "latest")

    await vi.advanceTimersByTimeAsync(999)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await saver.waitFor("/wiki/a.md")

    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith("/wiki/a.md", "latest")
    expect(saver.getSnapshot("/wiki/a.md")?.dirty).toBe(false)
  })

  it("flushes each path independently when the editor changes pages", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "from A")
    saver.schedule("/wiki/b.md", "from B")

    await saver.flush("/wiki/a.md")
    await saver.flush("/wiki/b.md")

    expect(write.mock.calls).toEqual([
      ["/wiki/a.md", "from A"],
      ["/wiki/b.md", "from B"],
    ])
  })

  it("serializes writes to one path and finishes on the newest revision", async () => {
    const pending: { promise: Promise<void>; resolve: (value: void) => void }[] = []
    const write = vi.fn(() => {
      const deferred = createDeferred()
      pending.push(deferred)
      return deferred.promise
    })
    const saver = new MarkdownFileSaver(write)
    const events: MarkdownSaveEvent[] = []
    saver.subscribe((event) => events.push(event))

    saver.schedule("/wiki/a.md", "one", true)
    saver.schedule("/wiki/a.md", "two", true)
    await flushMicrotasks()
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenLastCalledWith("/wiki/a.md", "one")

    pending[0].resolve()
    await flushMicrotasks(10)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith("/wiki/a.md", "two")
    pending[1].resolve()
    await saver.waitFor("/wiki/a.md")

    expect(events.filter((event) => event.phase === "saved").map((event) => event.contents)).toEqual(["one", "two"])
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "two",
      savedContents: "two",
      dirty: false,
      revision: 2,
      savedRevision: 2,
    })
  })

  it("keeps a newer draft visible when an older write completes", async () => {
    const first = createDeferred()
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "one", true)
    await flushMicrotasks()
    saver.schedule("/wiki/a.md", "new draft")

    first.resolve()
    await flushMicrotasks(10)

    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "new draft",
      savedContents: "one",
      dirty: true,
      pending: true,
    })
    await saver.flush("/wiki/a.md")
    expect(saver.getSnapshot("/wiki/a.md")?.savedContents).toBe("new draft")
  })

  it("retains a failed draft and can retry it", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "do not lose", true)
    await saver.waitFor("/wiki/a.md")

    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "do not lose",
      dirty: true,
      error: new Error("disk full"),
    })

    saver.schedule("/wiki/a.md", "do not lose", true)
    await saver.waitFor("/wiki/a.md")
    expect(write).toHaveBeenCalledTimes(2)
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({ dirty: false, error: null })
  })

  it("continues a later queued write when an earlier revision fails", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "one", true)
    saver.schedule("/wiki/a.md", "two", true)
    await saver.waitFor("/wiki/a.md")

    expect(write.mock.calls).toEqual([
      ["/wiki/a.md", "one"],
      ["/wiki/a.md", "two"],
    ])
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "two",
      savedContents: "two",
      dirty: false,
      error: null,
    })
  })

  it("waits for an in-flight write before deletion and blocks stale cleanup", async () => {
    const first = createDeferred()
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "draft", true)
    await flushMicrotasks()

    const invalidated = saver.invalidate("/wiki/a.md")
    expect(saver.schedule("/wiki/a.md", "stale editor", true)).toBeNull()
    first.resolve()
    await invalidated
    await saver.flush("/wiki/a.md")

    expect(write).toHaveBeenCalledOnce()
    expect(saver.getSnapshot("/wiki/a.md")).toBeNull()
    saver.activate("/wiki/a.md")
    saver.schedule("/wiki/a.md", "intentionally recreated", true)
    await saver.waitFor("/wiki/a.md")
    expect(write).toHaveBeenLastCalledWith("/wiki/a.md", "intentionally recreated")
  })

  it("restores a draft when deletion fails", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "recover this draft")
    const invalidated = await saver.invalidate("/wiki/a.md")

    saver.restoreInvalidated("/wiki/a.md", invalidated)
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "recover this draft",
      dirty: true,
    })
    await saver.flush("/wiki/a.md")
    expect(write).toHaveBeenCalledWith("/wiki/a.md", "recover this draft")
  })

  it("cancels a pending debounce when a folder is deleted", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/folder/a.md", "draft")
    await saver.invalidatePrefix("/wiki/folder")
    await vi.runAllTimersAsync()
    await saver.flush("/wiki/folder/a.md")
    expect(write).not.toHaveBeenCalled()
  })

  it("serializes an external edit after pending saves", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "typed draft", true)
    const apply = vi.fn(async (current: string) => current.replace("typed draft", "AI replacement"))
    const updated = await saver.writeExternal("/wiki/a.md", "old disk", apply)

    expect(updated).toBe("AI replacement")
    expect(apply).toHaveBeenCalledWith("typed draft")
    expect(write).toHaveBeenCalledWith("/wiki/a.md", "typed draft")
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "AI replacement",
      savedContents: "AI replacement",
      dirty: false,
    })
  })

  it("keeps a newer draft queued behind an external edit", async () => {
    const applying = createDeferred<string>()
    const write = vi.fn().mockResolvedValue(undefined)
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "base", true)
    await saver.waitFor("/wiki/a.md")

    const external = saver.writeExternal("/wiki/a.md", "base", () => applying.promise)
    await flushMicrotasks()
    saver.schedule("/wiki/a.md", "newer typed draft", true)
    applying.resolve("external result")
    await external
    await saver.waitFor("/wiki/a.md")

    expect(write).toHaveBeenLastCalledWith("/wiki/a.md", "newer typed draft")
    expect(saver.getSnapshot("/wiki/a.md")).toMatchObject({
      contents: "newer typed draft",
      savedContents: "newer typed draft",
      dirty: false,
    })
  })

  it("reports only failed paths after flushing all editors", async () => {
    const write = vi.fn((path: string) => path === "/wiki/a.md"
      ? Promise.reject(new Error("disk full"))
      : Promise.resolve())
    const saver = new MarkdownFileSaver(write)
    saver.schedule("/wiki/a.md", "unsaved A", true)
    saver.schedule("/wiki/b.md", "saved B", true)

    const failures = await saver.flushAll()
    expect(failures).toEqual([{ path: "/wiki/a.md", error: new Error("disk full") }])
    expect(saver.getSnapshot("/wiki/b.md")?.dirty).toBe(false)
  })
})
