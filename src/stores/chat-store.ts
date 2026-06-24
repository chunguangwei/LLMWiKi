import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import i18n from "@/i18n"

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageReference {
  title: string
  path: string
  /**
   * Origin of this reference (ported from upstream cea0029's chat-agent
   * routing). "wiki" = a local wiki page (default when omitted, for
   * backward-compat with references saved before this field existed);
   * "external" = a web / AnyTXT result. Drives icon + preview routing
   * and dedup keys when threading retrieval history across turns.
   */
  kind?: "wiki" | "external"
  /** For external refs: provider label (e.g. "Tavily", "AnyTXT", "Web"). */
  source?: string
  /** For external refs: the source URL (used as the dedup key + open target). */
  url?: string
  /** For external refs: the matched fragment shown in the reference preview. */
  snippet?: string
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
  /**
   * How this assistant reply was produced. "classic" tags answers that
   * came from classic (toolless) retrieval while the user had agent mode
   * ON — either the provider can't run the agent loop, or the agent
   * attempt was unsatisfactory and we fell back. The chat-message
   * renderer shows a small "Classic search" badge so the user knows
   * agent search wasn't (or couldn't be) used. Undefined = no badge
   * (a normal agent answer, or agent mode was off entirely).
   */
  retrieval?: "classic"
  /**
   * Tool calls that produced this assistant response. Populated by the
   * chat-agent path (Phase G2.2); undefined / empty for classic-chat
   * messages. The chat-message renderer shows them as a foldable block
   * above the body so the user can audit what the agent looked at.
   */
  toolCalls?: Array<{
    name: string
    /** JSON-stringified summary of the tool's input args (truncated). */
    inputSummary: string
    /** Short one-line description of the result: "ok", "skipped", "error: X", etc. */
    resultSummary: string
  }>
  /**
   * Raw markdown of every successful web_fetch the chat-agent ran
   * during this turn. SaveToWiki uses these to spill primary sources
   * into raw/sources/web/ so the wiki page has a paper-trail back to
   * the original article — without this the user only has the LLM's
   * summary and can't audit / re-ingest from source.
   *
   * Stored on the message so it auto-saves with chat history. Size
   * is already bounded by web_fetch's per-call cap (20K default,
   * 80K with full:true).
   */
  fetchedSources?: Array<{
    url: string
    title: string
    markdown: string
    fetchedAt: string
  }>
  /**
   * Set when the user already saved this assistant reply to the wiki
   * via SaveToWikiButton. Stored on the message itself (not in local
   * React state) so the "saved" indicator survives re-renders,
   * conversation switches, tab toggles, and app restarts (auto-save
   * persists messages to disk). Without this, the Save button comes
   * back enabled and the user can create duplicate query pages.
   */
  savedToWiki?: {
    /** Absolute path of the file that was created. */
    path: string
    /** ms epoch when the save happened — for "Saved 3m ago" tooltips. */
    savedAt: number
    /**
     * Post-save autoIngest progress. Surfaces the smart-split / page
     * generation outcome inline next to the Save button so the user
     * sees what landed where without having to dig through the
     * Activity panel.
     *
     *   - "running": autoIngest is in flight; button shows "ingesting…"
     *   - "done":    autoIngest finished; `pages` is the list of
     *                wiki-relative paths that were written (empty
     *                array is valid — means autoIngest ran but
     *                produced no new pages).
     *   - "failed":  autoIngest threw; user sees the error in tooltip
     *                + can re-trigger via a different path (e.g.
     *                manual re-ingest). The saved query page itself
     *                is untouched.
     */
    ingest?:
      | { state: "running" }
      | { state: "done"; pages: string[] }
      | { state: "failed"; error: string }
  }
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingContent: string
  mode: "chat" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number
  /**
   * Whether the chat-agent is allowed to reach out to the web search
   * tool this turn. Ported from upstream's chat-agent routing (cea0029).
   * Lifted out of chat-input's local state so it can be persisted per
   * project (chat-preferences.json) and restored on reopen.
   */
  useWebSearch: boolean
  /**
   * Whether the chat-agent is allowed to query the local AnyTXT index
   * this turn. Same persistence story as `useWebSearch`. Only meaningful
   * when AnyTXT is actually available on this machine.
   */
  useAnyTxtSearch: boolean

  // Conversation management
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string) => void
  /**
   * Append a finalised assistant message that already carries its
   * full content + (optional) tool call summaries. Used by the
   * chat-agent path which doesn't stream tokens — the LLM completes
   * its loop, then this action commits the result in one go.
   */
  addAssistantTurn: (
    content: string,
    opts?: {
      references?: MessageReference[]
      toolCalls?: DisplayMessage["toolCalls"]
      fetchedSources?: DisplayMessage["fetchedSources"]
    },
  ) => void
  /**
   * Record that a given assistant message was saved to the wiki at
   * `path`. Idempotent — re-marking already-saved messages just
   * refreshes the timestamp. No-op for unknown ids.
   */
  markMessageSavedToWiki: (messageId: string, path: string) => void
  /**
   * Update the post-save autoIngest state for a message that's
   * already been saved. No-op if the message isn't marked saved.
   * `state` accepts the discriminated union from
   * DisplayMessage.savedToWiki.ingest.
   */
  setMessageIngestState: (
    messageId: string,
    state:
      | { state: "running" }
      | { state: "done"; pages: string[] }
      | { state: "failed"; error: string },
  ) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (
    content: string,
    references?: MessageReference[],
    opts?: { retrieval?: "classic" },
  ) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  setUseWebSearch: (enabled: boolean) => void
  setUseAnyTxtSearch: (enabled: boolean) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}

let messageCounter = 0

/**
 * Globally-unique message id.
 *
 * History (and why we don't just `String(messageCounter++)`):
 *   The old impl returned bare "1"/"2"/"3"… seeded from a module-level
 *   counter. On app start `loadChatHistory` restored persisted messages
 *   whose ids were ALREADY "1"/"2"/"3"…, but the in-process counter
 *   stayed at 0. The very first new message minted "1" — duplicating
 *   an existing message id and triggering React's "two children with
 *   the same key" warning on every render of the conversation
 *   (chat-panel.tsx renders with `key={msg.id}`).
 *
 * Fix: prefix with the load-time epoch so we can't collide with stored
 * ids from a previous run, and add a tiny random suffix so two messages
 * written in the same millisecond (assistant + user in the same tick)
 * stay distinct. The counter is kept for readable ordering within one
 * session — ids look like `m_<ts>_<rand>_<n>`.
 */
const MESSAGE_ID_SESSION = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

function nextId(): string {
  messageCounter += 1
  return `m_${MESSAGE_ID_SESSION}_${messageCounter}`
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  mode: "chat",
  ingestSource: null,
  maxHistoryMessages: 10,
  useWebSearch: false,
  useAnyTxtSearch: false,

  createConversation: () => {
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: i18n.t("chat.newConversation"),
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
    }))
    return id
  },

  deleteConversation: (id) =>
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      return {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
      }
    }),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    })),

  addMessage: (role, content) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state

      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
      }

      // Auto-set title from first user message (first 50 chars)
      const convMessages = state.messages.filter(
        (m) => m.conversationId === activeConversationId && m.role === "user"
      )
      const updatedConversations =
        role === "user" && convMessages.length === 0
          ? conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, title: content.slice(0, 50), updatedAt: Date.now() }
                : c
            )
          : conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, updatedAt: Date.now() }
                : c
            )

      return {
        messages: [...state.messages, newMessage],
        conversations: updatedConversations,
      }
    }),

  addAssistantTurn: (content, opts) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state
      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant",
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        ...(opts?.references ? { references: opts.references } : {}),
        ...(opts?.toolCalls && opts.toolCalls.length > 0
          ? { toolCalls: opts.toolCalls }
          : {}),
        ...(opts?.fetchedSources && opts.fetchedSources.length > 0
          ? { fetchedSources: opts.fetchedSources }
          : {}),
      }
      const updatedConversations = conversations.map((c) =>
        c.id === activeConversationId
          ? { ...c, updatedAt: Date.now() }
          : c,
      )
      return {
        messages: [...state.messages, newMessage],
        conversations: updatedConversations,
      }
    }),

  markMessageSavedToWiki: (messageId, path) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? { ...m, savedToWiki: { path, savedAt: Date.now() } }
          : m,
      ),
    })),

  setMessageIngestState: (messageId, ingestState) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId || !m.savedToWiki) return m
        return {
          ...m,
          savedToWiki: { ...m.savedToWiki, ingest: ingestState },
        }
      }),
    })),

  setMessages: (messages) => set({ messages }),

  setConversations: (conversations) => set({ conversations }),

  setStreaming: (isStreaming) => set({ isStreaming }),

  appendStreamToken: (token) =>
    set((state) => ({
      streamingContent: state.streamingContent + token,
    })),

  finalizeStream: (content, references, opts) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        references,
        retrieval: opts?.retrieval,
      }

      return {
        isStreaming: false,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    }),

  setMode: (mode) => set({ mode }),

  setIngestSource: (ingestSource) => set({ ingestSource }),

  clearMessages: () =>
    set((state) => ({
      messages: state.messages.filter(
        (m) => m.conversationId !== state.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (maxHistoryMessages) => set({ maxHistoryMessages }),

  setUseWebSearch: (useWebSearch) => set({ useWebSearch }),

  setUseAnyTxtSearch: (useAnyTxtSearch) => set({ useAnyTxtSearch }),

  removeLastAssistantMessage: () =>
    set((state) => {
      const activeId = state.activeConversationId
      if (!activeId) return state
      const activeMessages = state.messages.filter((m) => m.conversationId === activeId)
      // Find last assistant message
      const lastAssistantIdx = [...activeMessages].reverse().findIndex((m) => m.role === "assistant")
      if (lastAssistantIdx === -1) return state
      const msgToRemove = activeMessages[activeMessages.length - 1 - lastAssistantIdx]
      return {
        messages: state.messages.filter((m) => m.id !== msgToRemove.id),
      }
    }),

  getActiveMessages: () => {
    const { messages, activeConversationId } = get()
    if (!activeConversationId) return []
    return messages.filter((m) => m.conversationId === activeConversationId)
  },
}))

export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
