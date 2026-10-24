/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { useMarkdownAutoSave } from "./use-markdown-auto-save"

const { writeFileMock } = vi.hoisted(() => ({ writeFileMock: vi.fn() }))
vi.mock("@/commands/fs", () => ({ writeFile: writeFileMock }))

type AutoSaveApi = ReturnType<typeof useMarkdownAutoSave>

let api: AutoSaveApi | null = null
let root: Root | null = null
let container: HTMLDivElement | null = null
let pathSequence = 0

function Harness({ path, onSaved }: { path: string; onSaved: (path: string, contents: string) => void }) {
  api = useMarkdownAutoSave(path, onSaved)
  return null
}

async function render(path: string, onSaved = vi.fn()) {
  await act(async () => {
    root!.render(<Harness path={path} onSaved={onSaved} />)
  })
  return onSaved
}

async function settle() {
  await act(async () => {
    await flushMicrotasks(10)
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api = null
  await render(`/wiki/page-${pathSequence++}.md`)
})

afterEach(async () => {
  if (root) {
    const mountedRoot = root
    await act(async () => mountedRoot.unmount())
  }
  root = null
  container?.remove()
  container = null
  api = null
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("useMarkdownAutoSave", () => {
  it("flushes the latest edit when the panel unmounts", async () => {
    writeFileMock.mockResolvedValue(undefined)
    const path = `/wiki/page-${pathSequence - 1}.md`
    await render(path)
    await act(async () => api!.markLoaded(path, "disk"))
    await act(async () => api!.handleSave("last edit"))

    const mountedRoot = root!
    root = null
    await act(async () => mountedRoot.unmount())
    await settle()

    expect(writeFileMock).toHaveBeenCalledWith(path, "last edit")
  })

  it("publishes only the newest draft when an older write completes", async () => {
    const first = createDeferred()
    writeFileMock.mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const path = `/wiki/page-${pathSequence - 1}.md`
    const onSaved = await render(path)
    await act(async () => api!.markLoaded(path, "disk"))
    await act(async () => {
      void api!.handleSave("one", { immediate: true })
      await flushMicrotasks()
    })
    await act(async () => api!.handleSave("new draft"))

    first.resolve()
    await settle()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(path, "new draft")
    expect(api!.status).toBe("saved")

    await act(async () => api!.handleSave("new draft", { immediate: true }))
    await settle()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(path, "new draft")
    expect(api!.status).toBe("saved")
  })

  it("ignores completion for a page that is no longer active", async () => {
    const first = createDeferred()
    writeFileMock.mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const pathA = `/wiki/page-${pathSequence - 1}.md`
    const onSaved = await render(pathA)
    await act(async () => api!.markLoaded(pathA, "A disk"))
    await act(async () => {
      void api!.handleSave("A draft", { immediate: true })
      await flushMicrotasks()
    })

    const pathB = `/wiki/page-${pathSequence++}.md`
    await render(pathB, onSaved)
    await act(async () => api!.markLoaded(pathB, "B disk"))
    first.resolve()
    await settle()

    expect(onSaved).not.toHaveBeenCalledWith(pathA, "A draft")
    expect(api!.status).toBe("idle")
  })

  it("restores an unsaved draft after a failed write and retries it", async () => {
    writeFileMock.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined)
    const path = `/wiki/page-${pathSequence - 1}.md`
    const onSaved = await render(path)
    await act(async () => api!.markLoaded(path, "disk"))
    await act(async () => {
      const saving = api!.handleSave("recover me", { immediate: true })
      const rejected = expect(saving).rejects.toThrow("disk full")
      await flushMicrotasks(10)
      await rejected
    })
    expect(api!.status).toBe("error")

    let restored = ""
    await act(async () => {
      restored = api!.markLoaded(path, "old disk")
    })
    expect(restored).toBe("recover me")

    await act(async () => api!.retry())
    await settle()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(path, "recover me")
    expect(api!.status).toBe("saved")
  })
})
