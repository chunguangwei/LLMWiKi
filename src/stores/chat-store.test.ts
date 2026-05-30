import { describe, it, expect, beforeEach } from "vitest"
import { useChatStore } from "./chat-store"

/**
 * Focused unit coverage for the rename action that backs the sidebar
 * pencil button and the in-chat header rename. The store has lived
 * without a test file because the chat surface is exercised end-to-end
 * via integration tests; rename is small + load-bearing enough to be
 * worth a dedicated check.
 */
function resetStore() {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingContent: "",
  })
}

describe("chat-store renameConversation", () => {
  beforeEach(() => {
    resetStore()
  })

  it("rewrites the title for an existing conversation and bumps updatedAt", async () => {
    const id = useChatStore.getState().createConversation()
    const created = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)!
    const originalUpdatedAt = created.updatedAt

    // Wait a tick so Date.now() advances; on fast machines the
    // createConversation() and rename() can land in the same ms.
    await new Promise((r) => setTimeout(r, 2))
    useChatStore.getState().renameConversation(id, "Wiki questions")

    const after = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)!
    expect(after.title).toBe("Wiki questions")
    expect(after.updatedAt).toBeGreaterThan(originalUpdatedAt)
  })

  it("ignores rename for an unknown conversation id (no throw, no insert)", () => {
    const before = useChatStore.getState().conversations.length
    useChatStore.getState().renameConversation("missing-id", "doesn't matter")
    expect(useChatStore.getState().conversations).toHaveLength(before)
  })

  it("preserves createdAt across rename (only updatedAt moves)", async () => {
    const id = useChatStore.getState().createConversation()
    const created = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)!
    const createdAtBefore = created.createdAt

    await new Promise((r) => setTimeout(r, 2))
    useChatStore.getState().renameConversation(id, "Fresh title")

    const after = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)!
    expect(after.createdAt).toBe(createdAtBefore)
  })

  it("accepts an empty title at the store layer (UI is what guards against this)", () => {
    // The sidebar / header UIs trim and reject empty strings before
    // calling renameConversation, but the store itself doesn't
    // enforce — keep the action thin and let presentation own the
    // policy. This test pins that contract so a future "should it
    // reject?" refactor is conscious.
    const id = useChatStore.getState().createConversation()
    useChatStore.getState().renameConversation(id, "")
    const after = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)!
    expect(after.title).toBe("")
  })
})

describe("chat-store markMessageSavedToWiki", () => {
  beforeEach(() => {
    resetStore()
  })

  it("sets savedToWiki on the matching message", async () => {
    const id = useChatStore.getState().createConversation()
    useChatStore.getState().addMessage("user", "hi")
    useChatStore.getState().addAssistantTurn("answer")
    const before = useChatStore
      .getState()
      .messages.filter((m) => m.conversationId === id)
    const assistant = before.find((m) => m.role === "assistant")!
    expect(assistant.savedToWiki).toBeUndefined()

    useChatStore.getState().markMessageSavedToWiki(
      assistant.id,
      "/p/wiki/queries/foo.md",
    )

    const after = useChatStore.getState().messages.find((m) => m.id === assistant.id)!
    expect(after.savedToWiki?.path).toBe("/p/wiki/queries/foo.md")
    expect(after.savedToWiki?.savedAt).toBeGreaterThan(0)
  })

  it("survives a setMessages round-trip (persistence boundary)", () => {
    // Simulates the auto-save → reload loop: messages are written to
    // disk and then re-hydrated. The savedToWiki field must round-trip.
    useChatStore.getState().createConversation()
    useChatStore.getState().addMessage("user", "hi")
    useChatStore.getState().addAssistantTurn("answer")
    const assistant = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant")!
    useChatStore.getState().markMessageSavedToWiki(assistant.id, "/p/wiki/queries/x.md")

    const dump = useChatStore.getState().messages.slice()
    // Clone+restore — what persist would do.
    useChatStore.getState().setMessages(JSON.parse(JSON.stringify(dump)))

    const after = useChatStore.getState().messages.find((m) => m.id === assistant.id)!
    expect(after.savedToWiki?.path).toBe("/p/wiki/queries/x.md")
  })

  it("ignores an unknown message id (no throw, no insert)", () => {
    const before = useChatStore.getState().messages.length
    useChatStore.getState().markMessageSavedToWiki("ghost-id", "/x")
    expect(useChatStore.getState().messages.length).toBe(before)
  })
})
