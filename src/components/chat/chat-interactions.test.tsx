// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import type { WikiProject } from "@/types/wiki"

const {
  openUrlMock,
  deleteChatConversationMock,
  readFileMock,
  getFileSizeMock,
  readFileAsBase64Mock,
  nativeDropMock,
} = vi.hoisted(() => ({
  openUrlMock: vi.fn(),
  deleteChatConversationMock: vi.fn(),
  readFileMock: vi.fn(),
  getFileSizeMock: vi.fn(),
  readFileAsBase64Mock: vi.fn(),
  nativeDropMock: { options: null as null | { enabled: boolean; onDrop: (paths: string[]) => void } },
}))

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }))
vi.mock("@/components/chat/reference-knowledge-graph", () => ({ ReferenceKnowledgeGraph: () => null }))
vi.mock("@/lib/persist", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/persist")>(),
  deleteChatConversation: deleteChatConversationMock,
}))
vi.mock("@/commands/fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/commands/fs")>(),
  readFile: readFileMock,
  getFileSize: getFileSizeMock,
  readFileAsBase64: readFileAsBase64Mock,
}))
vi.mock("@/hooks/use-native-file-drop", () => ({
  useNativeFileDrop: (options: { enabled: boolean; onDrop: (paths: string[]) => void }) => {
    nativeDropMock.options = options
    return false
  },
}))
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
import { ChatInput } from "./chat-input"
import { flushIO, flushMicrotasks } from "@/test-helpers/deferred"

import { ConversationSidebar } from "./chat-panel"
import { ChatMessage, MarkdownContent } from "./chat-message"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  openUrlMock.mockReset().mockResolvedValue(undefined)
  deleteChatConversationMock.mockReset().mockResolvedValue(undefined)
  readFileMock.mockReset().mockRejectedValue(new Error("not found"))
  getFileSizeMock.mockReset().mockResolvedValue(3)
  readFileAsBase64Mock.mockReset().mockResolvedValue({ base64: "aW1n", mimeType: "image/png" })
  nativeDropMock.options = null
  useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] })
  useWikiStore.setState({ project: null })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
}

function conversation(id: string, title: string, updatedAt: number): Conversation {
  return { id, title, createdAt: updatedAt, updatedAt }
}

function message(id: string, conversationId: string, role: DisplayMessage["role"] = "user"): DisplayMessage {
  return { id, conversationId, role, content: `${id} content`, timestamp: 1 }
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button containing ${text} not found in ${container.innerHTML}`)
  return button
}

describe("ConversationSidebar interactions", () => {
  it("uses native selection buttons, keeps delete controls mounted, and preserves sorted counts", async () => {
    useChatStore.setState({
      conversations: [conversation("old", "Older", 10), conversation("new", "Newer", 20)],
      activeConversationId: "old",
      messages: [message("m1", "old"), message("m2", "old"), message("m3", "new")],
    })

    await render(<ConversationSidebar />)

    const newer = findButton("Newer")
    const older = findButton("Older")
    expect(newer.tagName).toBe("BUTTON")
    expect(older.getAttribute("aria-current")).toBe("page")
    expect(older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(older.textContent).toContain("2 chat.msgCount")
    expect(newer.textContent).toContain("1 chat.msgCount")

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.deleteConversationTooltip: Older"]',
    )
    expect(deleteButton).not.toBeNull()
    expect(deleteButton?.className).toContain("group-hover:opacity-100")
    expect(deleteButton?.className).toContain("group-focus-within:opacity-100")
    expect(deleteButton?.className).toContain("focus-visible:opacity-100")

    await act(async () => older.click())
    expect(useChatStore.getState().activeConversationId).toBe("old")

    await act(async () => newer.click())
    expect(useChatStore.getState().activeConversationId).toBe("new")
  })

  it("deletes through the store and existing persistence path from a focusable button", async () => {
    useChatStore.setState({
      conversations: [conversation("keep", "Keep", 20), conversation("remove", "Remove", 10)],
      activeConversationId: "keep",
    })
    useWikiStore.setState({ project: { path: "/project" } as WikiProject })
    await render(<ConversationSidebar />)

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.deleteConversationTooltip: Remove"]',
    )
    expect(deleteButton).not.toBeNull()
    deleteButton?.focus()
    expect(document.activeElement).toBe(deleteButton)

    await act(async () => deleteButton?.click())

    expect(useChatStore.getState().conversations.map((item) => item.id)).toEqual(["keep"])
    expect(useChatStore.getState().activeConversationId).toBe("keep")
    expect(deleteChatConversationMock).toHaveBeenCalledWith("/project", "remove")
  })
})

describe("ChatMessage actions", () => {
  it("mounts copy, save, and regenerate without hover and keeps them focusable", async () => {
    const onRegenerate = vi.fn()

    await render(
      <ChatMessage
        message={message("answer", "conversation", "assistant")}
        isLastAssistant
        onRegenerate={onRegenerate}
      />,
    )

    const copy = container.querySelector<HTMLButtonElement>('button[title="chat.copyToClipboard"]')
    const save = container.querySelector<HTMLButtonElement>('button[title="chat.saveToWiki"]')
    const regenerate = container.querySelector<HTMLButtonElement>('button[title="chat.regenerateResponse"]')
    expect(copy).not.toBeNull()
    expect(save).not.toBeNull()
    expect(regenerate).not.toBeNull()
    expect(copy?.parentElement?.className).toContain("group-hover/message:opacity-100")
    expect(copy?.parentElement?.className).toContain("group-focus-within/message:opacity-100")

    copy?.focus()
    expect(document.activeElement).toBe(copy)
    await act(async () => copy?.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("answer content")

    save?.focus()
    expect(document.activeElement).toBe(save)
    regenerate?.focus()
    expect(document.activeElement).toBe(regenerate)
    await act(async () => regenerate?.click())
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })
})

describe("MarkdownContent links", () => {
  it.each(["https://example.com/docs?q=1", "http://example.com/guide"])(
    "opens %s through the Tauri opener without webview navigation",
    async (href) => {
      await render(<MarkdownContent content={`[External](${href})`} />)
      const link = container.querySelector<HTMLAnchorElement>("a")
      expect(link).not.toBeNull()
      expect(link?.getAttribute("href")).toBe(href)

      const event = new MouseEvent("click", { bubbles: true, cancelable: true })
      await act(async () => {
        link?.dispatchEvent(event)
        await Promise.resolve()
      })

      expect(event.defaultPrevented).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(href)
    },
  )

  it("keeps an empty href as a non-link fallback", async () => {
    await render(<MarkdownContent content="[Empty]()" />)

    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("Empty")
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})

async function renderChatInput(options: { imageInputAvailable?: boolean; isStreaming?: boolean } = {}) {
  const { imageInputAvailable = true, isStreaming = false } = options
  const onSend = vi.fn()
  await render(
    <ChatInput
      onSend={onSend}
      onStop={vi.fn()}
      isStreaming={isStreaming}
      useWebSearch={false}
      useAnyTxtSearch={false}
      agentMode="standard"
      retrievalMode="standard"
      availableSkills={[]}
      selectedSkills={[]}
      availableContextFiles={[]}
      selectedContextFiles={[]}
      onUseWebSearchChange={vi.fn()}
      onUseAnyTxtSearchChange={vi.fn()}
      onAgentModeChange={vi.fn()}
      onRetrievalModeChange={vi.fn()}
      onSelectedSkillsChange={vi.fn()}
      onSelectedContextFilesChange={vi.fn()}
      anyTxtAvailable={false}
      imageInputAvailable={imageInputAvailable}
    />,
  )
  return onSend
}

async function dropNative(paths: string[]) {
  const onDrop = nativeDropMock.options?.onDrop
  if (!onDrop) throw new Error("Native drop handler is not registered")
  await act(async () => {
    onDrop(paths)
    await flushMicrotasks(25)
  })
}

async function fireBrowserFileEvent(type: "dragover" | "drop", files: File[]) {
  const textarea = container.querySelector("textarea")
  if (!textarea) throw new Error("Chat textarea is missing")
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { dataTransfer: { files, types: ["Files"] } })
  await act(async () => {
    textarea.dispatchEvent(event)
    await flushMicrotasks(5)
    await flushIO(5)
    await flushMicrotasks(5)
  })
  return event
}

describe("ChatInput image drops", () => {
  it("reads a browser image file directly", async () => {
    const { fileToMessageImage } = await import("@/lib/chat-image-utils")
    const file = new File(["image"], "browser.png", { type: "image/png" })
    expect(file.type).toBe("image/png")
    await expect(fileToMessageImage(file)).resolves.toEqual({
      mediaType: "image/png",
      dataBase64: "aW1hZ2U=",
    })
  })

  it("puts a native image path into the preview and outgoing message", async () => {
    const onSend = await renderChatInput()
    await dropNative(["/tmp/note.png"])

    expect(readFileAsBase64Mock).toHaveBeenCalledExactlyOnceWith("/tmp/note.png")
    const preview = container.querySelector<HTMLImageElement>('img[src="data:image/png;base64,aW1n"]')
    expect(preview).not.toBeNull()
    await act(async () => findButton("chat.sendMessage").click())
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      "",
      [{ mediaType: "image/png", dataBase64: "aW1n" }],
      expect.objectContaining({ agentMode: "standard", retrievalMode: "standard" }),
    )
    expect(container.querySelector('img[src^="data:image/"]')).toBeNull()
  })

  it("accepts a browser image drop and removes it without native path reads", async () => {
    await renderChatInput()
    const file = new File(["image"], "browser.png", { type: "image/png" })
    await fireBrowserFileEvent("dragover", [file])
    expect(container.querySelector('[data-testid="chat-image-drop-overlay"]')).not.toBeNull()

    await fireBrowserFileEvent("drop", [file])
    expect(container.querySelector('[data-testid="chat-image-drop-overlay"]')).toBeNull()
    await vi.waitFor(() => {
      expect(container.querySelector('img[src^="data:image/png;base64,"]'), container.innerHTML).not.toBeNull()
    })
    expect(getFileSizeMock).not.toHaveBeenCalled()
    expect(readFileAsBase64Mock).not.toHaveBeenCalled()

    const remove = container.querySelector<HTMLButtonElement>('button[title="chat.removeImage"]')
    expect(remove).not.toBeNull()
    await act(async () => remove!.click())
    expect(container.querySelector('img[src^="data:image/"]')).toBeNull()
  })

  it("serializes consecutive drops and keeps only five images", async () => {
    await renderChatInput()
    await dropNative(["/tmp/1.png", "/tmp/2.png", "/tmp/3.png"])
    await dropNative(["/tmp/4.png", "/tmp/5.png", "/tmp/6.png"])

    expect(container.querySelectorAll('img[src^="data:image/"]')).toHaveLength(5)
    expect(readFileAsBase64Mock).toHaveBeenCalledTimes(5)
    expect(readFileAsBase64Mock).not.toHaveBeenCalledWith("/tmp/6.png")
    expect(container.textContent).toContain("chat.tooManyImages")
  })

  it("does not read files when the provider cannot accept images", async () => {
    await renderChatInput({ imageInputAvailable: false })
    expect(nativeDropMock.options?.enabled).toBe(false)
    await dropNative(["/tmp/private.png"])

    expect(getFileSizeMock).not.toHaveBeenCalled()
    expect(readFileAsBase64Mock).not.toHaveBeenCalled()
    expect(container.textContent).toContain("chat.imageInputUnavailable")
  })

  it("shows an oversized-image error without reading the image bytes", async () => {
    getFileSizeMock.mockResolvedValue(5 * 1024 * 1024 + 1)
    await renderChatInput()
    await dropNative(["/tmp/large.png"])

    expect(readFileAsBase64Mock).not.toHaveBeenCalled()
    expect(container.textContent).toContain("chat.imageTooLarge")
    expect(container.querySelector('img[src^="data:image/"]')).toBeNull()
  })
})
