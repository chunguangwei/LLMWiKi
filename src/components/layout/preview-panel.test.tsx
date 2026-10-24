/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushMicrotasks } from "@/test-helpers/deferred"
import { useWikiStore } from "@/stores/wiki-store"
import { PreviewPanel } from "./preview-panel"
import i18n from "@/i18n"

const fsMocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

vi.mock("@/components/editor/wiki-editor", () => ({
  WikiEditor: ({ content }: { content: string }) => (
    <article data-testid="wiki-editor"><h1>Demo page</h1><p>{content}</p></article>
  ),
}))
vi.mock("@/components/editor/file-preview", () => ({
  FilePreview: ({ textContent }: { textContent: string }) => <pre>{textContent}</pre>,
}))
vi.mock("@/components/editor/markdown-save-status", () => ({
  MarkdownSaveStatusIndicator: () => null,
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderPreview() {
  await act(async () => {
    root!.render(<PreviewPanel />)
    await flushMicrotasks(15)
  })
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  await i18n.changeLanguage("en")
  fsMocks.readFile.mockResolvedValue("alpha searchable text")
  fsMocks.writeFile.mockResolvedValue(undefined)
  useWikiStore.setState({
    selectedFile: "/project/wiki/a.md",
    fileContent: "",
    previewContentPath: null,
    externalPreview: null,
    previewBackStack: [],
    previewForwardStack: [],
    activeView: "wiki",
  })
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
  fsMocks.readFile.mockReset()
  fsMocks.writeFile.mockReset()
  vi.unstubAllGlobals()
})

describe("PreviewPanel integration", () => {
  it("opens in-page find with Cmd/Ctrl+F without leaving the wiki view", async () => {
    await renderPreview()
    expect(container!.querySelector('[data-testid="wiki-editor"]')?.textContent).toContain("alpha searchable text")

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }))
    })
    const findInput = container!.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')
    expect(findInput).not.toBeNull()
    expect(useWikiStore.getState().activeView).toBe("wiki")

    await act(async () => {
      findInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(container!.querySelector('input[aria-label="Find in page"]')).toBeNull()
  })

  it("keeps read failures out of the editor and retries successfully", async () => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce("recovered content")
    await renderPreview()

    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("Could not load this file")
    expect(container!.querySelector('[data-testid="wiki-editor"]')).toBeNull()
    expect(useWikiStore.getState().fileContent).toBe("")

    const retry = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Retry")!
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flushMicrotasks(15)
    })

    expect(fsMocks.readFile).toHaveBeenCalledTimes(2)
    expect(container!.querySelector('[data-testid="wiki-editor"]')?.textContent).toContain("recovered content")
    expect(container!.querySelector('[role="alert"]')).toBeNull()
  })
})
