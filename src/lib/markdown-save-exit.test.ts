import { describe, expect, it, vi } from "vitest"
import { createDeferred } from "@/test-helpers/deferred"
import { createMarkdownSaveExitHandler } from "./markdown-save-exit"

describe("Markdown save exit handshake", () => {
  it("cancels exit and reports files that could not be saved", async () => {
    const onFailure = vi.fn()
    const confirmExit = vi.fn().mockResolvedValue(undefined)
    const cancelExit = vi.fn().mockResolvedValue(undefined)
    const handler = createMarkdownSaveExitHandler({
      flush: vi.fn().mockResolvedValue([{ path: "/wiki/a.md", error: new Error("disk full") }]),
      onFailure,
      confirmExit,
      cancelExit,
    })

    await handler()
    expect(cancelExit).toHaveBeenCalledOnce()
    expect(confirmExit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith([{ path: "/wiki/a.md", error: new Error("disk full") }])
  })

  it("coalesces duplicate requests and rechecks pending edits", async () => {
    const firstFlush = createDeferred<Awaited<ReturnType<typeof import("./markdown-file-saver").markdownFileSaver.flushAll>>>()
    const flush = vi.fn()
      .mockReturnValueOnce(firstFlush.promise)
      .mockResolvedValueOnce([])
    const confirmExit = vi.fn().mockResolvedValue(undefined)
    const cancelExit = vi.fn().mockResolvedValue(undefined)
    const onFailure = vi.fn()
    const handler = createMarkdownSaveExitHandler({ flush, confirmExit, cancelExit, onFailure })

    const first = handler()
    await handler()
    firstFlush.resolve([{ path: "/wiki/a.md", error: new Error("disk full") }])
    await first

    expect(flush).toHaveBeenCalledTimes(2)
    expect(cancelExit).toHaveBeenCalledOnce()
    expect(confirmExit).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
