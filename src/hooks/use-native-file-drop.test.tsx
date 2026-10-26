/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Event } from "@tauri-apps/api/event"
import type { DragDropEvent } from "@tauri-apps/api/webview"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { isNativeDropInside, useNativeFileDrop } from "./use-native-file-drop"

const mocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}))

let root: Root
let container: HTMLDivElement
let target: React.RefObject<HTMLDivElement | null>
let handler: ((event: Event<DragDropEvent>) => void) | null

function Harness({ enabled, onDrop }: { enabled: boolean; onDrop: (paths: string[]) => void }) {
  const dragging = useNativeFileDrop({ target, enabled, onDrop })
  return <div ref={target} data-dragging={dragging} />
}

async function render(enabled = true, onDrop = vi.fn()) {
  await act(async () => {
    root.render(<Harness enabled={enabled} onDrop={onDrop} />)
    await flushMicrotasks(5)
  })
  return onDrop
}

async function emit(type: "enter" | "over" | "drop" | "leave", paths: string[] = [], x = 40, y = 60) {
  await act(async () => {
    handler?.({ event: `tauri://drag-${type}`, id: 1, payload: { type, paths, position: { x, y } } } as Event<DragDropEvent>)
    await flushMicrotasks(3)
  })
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
  handler = null
  target = { current: null }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.onDragDropEvent.mockImplementation(async (callback) => {
    handler = callback
    return mocks.unlisten
  })
  await render()
  target.current!.getBoundingClientRect = () => ({
    left: 10, right: 110, top: 20, bottom: 120, width: 100, height: 100, x: 10, y: 20,
    toJSON: () => ({}),
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("native drop coordinates", () => {
  it("converts physical pixels to CSS coordinates and checks the target boundary", () => {
    const rect = { left: 10, right: 110, top: 20, bottom: 120 }
    expect(isNativeDropInside({ x: 20, y: 40 }, rect, 2)).toBe(true)
    expect(isNativeDropInside({ x: 220, y: 240 }, rect, 2)).toBe(true)
    expect(isNativeDropInside({ x: 222, y: 240 }, rect, 2)).toBe(false)
    expect(isNativeDropInside({ x: 20, y: 40 }, rect, 0)).toBe(false)
  })

  it("highlights only the active target and forwards a drop once", async () => {
    const onDrop = await render()
    await emit("enter", ["/tmp/note.md"])
    expect(container.firstElementChild?.getAttribute("data-dragging")).toBe("true")
    await emit("drop", ["/tmp/note.md"], 80, 100)

    expect(onDrop).toHaveBeenCalledExactlyOnceWith(["/tmp/note.md"])
    expect(container.firstElementChild?.getAttribute("data-dragging")).toBe("false")
  })

  it("ignores outside, empty, disabled, and stale-listener drops", async () => {
    const onDrop = await render()
    await emit("over", ["/tmp/note.md"], 300, 300)
    expect(container.firstElementChild?.getAttribute("data-dragging")).toBe("false")
    await emit("drop", ["/tmp/note.md"], 300, 300)
    await emit("drop", [])
    expect(onDrop).not.toHaveBeenCalled()

    await render(false)
    expect(mocks.unlisten).toHaveBeenCalledOnce()
    await emit("drop", ["/tmp/note.md"])
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("uses the latest callback without registering another listener", async () => {
    const first = await render()
    const second = await render(true)
    expect(mocks.onDragDropEvent).toHaveBeenCalledOnce()
    await emit("drop", ["/tmp/note.md"])
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith(["/tmp/note.md"])
  })

  it("unregisters a listener that resolves after unmount", async () => {
    const registration = createDeferred<() => void>()
    mocks.onDragDropEvent.mockReturnValue(registration.promise)
    const mountedRoot = root
    await act(async () => mountedRoot.unmount())
    root = createRoot(document.createElement("div"))
    registration.resolve(mocks.unlisten)
    await act(async () => flushMicrotasks(5))
    expect(mocks.unlisten).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })
})
