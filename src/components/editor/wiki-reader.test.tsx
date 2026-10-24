/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WikiReader } from "./wiki-reader"

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }))
vi.mock("@/components/mermaid-diagram", () => ({
  MermaidDiagram: () => null,
  unwrapMermaidPre: () => null,
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    const mountedRoot = root
    await act(async () => mountedRoot.unmount())
  }
  root = null
  container?.remove()
  container = null
  openUrlMock.mockReset()
})

describe("WikiReader links", () => {
  it("opens external links in the system browser instead of the webview", async () => {
    openUrlMock.mockResolvedValue(undefined)
    await act(async () => {
      root!.render(<WikiReader body="[Documentation](https://example.com/docs)" />)
    })
    const anchor = container!.querySelector("a")!
    let notPrevented = true
    await act(async () => {
      notPrevented = anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })

    expect(notPrevented).toBe(false)
    expect(openUrlMock).toHaveBeenCalledExactlyOnceWith("https://example.com/docs")
  })
})
