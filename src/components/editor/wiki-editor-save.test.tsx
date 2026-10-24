/** @vitest-environment jsdom */
import { act } from "react"
import { useCallback, useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { createEmptyProjectPathIndex } from "@/lib/wiki-page-resolver"
import { useMarkdownAutoSave } from "@/hooks/use-markdown-auto-save"
import { useWikiStore } from "@/stores/wiki-store"
import { WikiEditor } from "./wiki-editor"
import i18n from "@/i18n"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  applyTextSelectionEdit: vi.fn(),
}))
const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  applyTextSelectionEdit: fsMocks.applyTextSelectionEdit,
}))
vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="reader">{body}</div>,
}))
vi.mock("@/components/editor/frontmatter-panel", () => ({ FrontmatterPanel: () => null }))
vi.mock("@/components/editor/page-links-panel", () => ({ PageLinksPanel: () => null }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/search", () => ({ searchWiki: vi.fn().mockResolvedValue([]) }))
vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))

let root: Root | null = null
let container: HTMLDivElement | null = null
let editorSequence = 0

function button(text: string): HTMLButtonElement {
  const match = Array.from(container!.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)
  if (!match) throw new Error(`Missing button: ${text}`)
  return match
}

async function click(text: string) {
  await act(async () => {
    button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await flushMicrotasks()
  })
}

async function input(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await flushMicrotasks()
  })
}

function ControlledEditor({ path, initial, gate }: { path: string; initial: string; gate: Promise<void> }) {
  const [content, setContent] = useState(initial)
  const onSave = useCallback(async (markdown: string, options?: { immediate?: boolean }) => {
    setContent(markdown)
    if (options?.immediate) await gate
  }, [gate])
  return <WikiEditor content={content} onSave={onSave} filePath={path} />
}

function AutoSaveEditor({ path, initial }: { path: string; initial: string }) {
  const [content, setContent] = useState(initial)
  const save = useMarkdownAutoSave(path, (_, contents) => setContent(contents))
  useEffect(() => {
    setContent(save.markLoaded(path, initial))
  }, [path, initial, save.markLoaded])
  const onSave = useCallback((markdown: string, options?: { immediate?: boolean }) => {
    setContent(markdown)
    return save.handleSave(markdown, options)
  }, [save.handleSave])
  return <WikiEditor content={content} onSave={onSave} filePath={path} />
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage("en")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  fsMocks.readFile.mockResolvedValue("")
  fsMocks.writeFile.mockResolvedValue(undefined)
  fsMocks.applyTextSelectionEdit.mockImplementation(async (input) => `${input.prefix}${input.replacement}${input.suffix}`)
  streamChatMock.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken("planet")
    callbacks.onDone()
  })
  editorSequence += 1
})

afterEach(async () => {
  if (root) {
    const mountedRoot = root
    await act(async () => mountedRoot.unmount())
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe("WikiEditor save lifecycle", () => {
  it("keeps the latest frontmatter draft across Done and a rapid return to Edit", async () => {
    const path = `/wiki/editor-${editorSequence}.md`
    const gate = createDeferred()
    const initial = "---\ntitle: Old title\ntype: entity\n---\n# Old title"
    useWikiStore.setState({ project: null, projectPathIndex: createEmptyProjectPathIndex(), selectedFile: path })
    await act(async () => root!.render(<ControlledEditor path={path} initial={initial} gate={gate.promise} />))

    await click("Edit")
    const updated = initial.replace(/Old title/g, "New title")
    await input(container!.querySelector("textarea")!, updated)
    await click("Done")
    await click("Edit")
    expect(container!.querySelector("textarea")!.value).toBe(updated)

    const second = updated.replace(/New title/g, "Second title")
    await input(container!.querySelector("textarea")!, second)
    await click("Done")
    expect(container!.querySelector('[data-testid="reader"]')?.textContent).toContain("Second title")
    gate.resolve()
    await act(async () => flushMicrotasks())
  })

  it("saves the current draft before requesting and applying a selection edit", async () => {
    const path = `/wiki/editor-${editorSequence}.md`
    const project = { id: "project", name: "Project", path: "/project" }
    const fullPath = `/project${path}`
    useWikiStore.setState({ project, projectPathIndex: createEmptyProjectPathIndex(), selectedFile: fullPath })
    await act(async () => root!.render(<AutoSaveEditor path={fullPath} initial="Hello world" />))

    await click("Edit")
    const textarea = container!.querySelector("textarea")!
    await input(textarea, "Hello world!")
    await act(async () => {
      textarea.focus()
      textarea.setSelectionRange(6, 11)
      document.dispatchEvent(new Event("selectionchange"))
      await flushMicrotasks()
    })
    const editors = container!.querySelectorAll("textarea")
    expect(editors).toHaveLength(2)
    await input(editors[1], "Replace the selected word")

    const firstWrite = createDeferred()
    fsMocks.writeFile.mockReturnValueOnce(firstWrite.promise)
    await click("Edit")
    expect(fsMocks.writeFile).toHaveBeenCalledWith(fullPath, "Hello world!")
    expect(streamChatMock).not.toHaveBeenCalled()

    firstWrite.resolve()
    await act(async () => flushMicrotasks(20))
    expect(streamChatMock).toHaveBeenCalledOnce()
    await click("Accept")

    expect(fsMocks.applyTextSelectionEdit).toHaveBeenCalledWith(expect.objectContaining({
      filePath: fullPath,
      selectedText: "world",
      replacement: "planet",
    }))
    expect(container!.querySelector('[data-testid="reader"]')?.textContent).toContain("Hello planet")
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })
})
