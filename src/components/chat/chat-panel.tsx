import { useRef, useEffect, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, Plus, Trash2, MessageSquare, Pencil, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { runChatAgent } from "@/lib/chat-agent"
import { hasUsableLlm, providerSupportsToolAgent } from "@/lib/has-usable-llm"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile } from "@/commands/fs"
import { deleteChatConversation } from "@/lib/persist"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import {
  addFilesToRawWithContext,
  addImagesToRawWithContext,
  addUrlsToRawWithContext,
  isImageSourcePath,
  type ChatImageItem,
} from "@/lib/raw-from-chat"
import type { StagedImageChip } from "./chat-input"
import { isLikelyUrl } from "@/lib/web-fetch"
import { detectSearchTrigger } from "@/lib/search-trigger"
import {
  webSearch,
  hasConfiguredSearchProvider,
  type WebSearchResult,
} from "@/lib/web-search"
import { ChatSearchResults } from "./chat-search-results"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ConversationSidebar() {
  const { t } = useTranslation()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // Inline-rename state. editingId is the conv being renamed (null when
  // the sidebar is in normal mode); editValue holds the in-flight title
  // string. Kept local because rename is a transient UI mode — committing
  // pushes through renameConversation and auto-save persists it.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  // 200 matches the renameConversation maxLength (and the input's
  // maxLength prop). Soft threshold for the counter — only show it when
  // the user gets close so it doesn't clutter the input most of the time.
  const TITLE_MAX = 200
  const TITLE_COUNTER_THRESHOLD = 150

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  function startEdit(convId: string, currentTitle: string) {
    setEditingId(convId)
    setEditValue(currentTitle)
    // focus + select-all on next tick — input isn't mounted yet
    setTimeout(() => {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }, 0)
  }

  // F2 globally enters rename for the active conversation, matching the
  // file-manager convention on every major OS. Skip when the user is
  // already typing somewhere (input / textarea / contenteditable) — F2
  // inside the chat composer should never hijack focus to the sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return
      }
      const activeId = useChatStore.getState().activeConversationId
      if (!activeId) return
      const conv = useChatStore.getState().conversations.find((c) => c.id === activeId)
      if (!conv) return
      e.preventDefault()
      startEdit(conv.id, conv.title)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  function commitEdit() {
    if (!editingId) return
    const trimmed = editValue.trim()
    // Empty trim → cancel (treat as "no change") rather than write a
    // blank title; the original title stays put.
    if (trimmed.length > 0) {
      renameConversation(editingId, trimmed)
    }
    setEditingId(null)
    setEditValue("")
  }

  function cancelEdit() {
    setEditingId(null)
    setEditValue("")
  }

  return (
    <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("chat.newChat")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t("chat.noConversationsYet")}
          </p>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const msgCount = getMessageCount(conv.id)
            const isEditing = editingId === conv.id
            return (
              <div
                key={conv.id}
                className={`group relative mx-1 my-0.5 flex flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isEditing ? "" : "cursor-pointer"
                } ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => {
                  if (isEditing) return
                  setActiveConversation(conv.id)
                }}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="flex items-start justify-between gap-1">
                  {isEditing ? (
                    <div className="flex flex-1 flex-col gap-0.5">
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        placeholder={t("chat.renamePlaceholder")}
                        maxLength={TITLE_MAX}
                        className="w-full rounded border bg-background px-1 py-0.5 text-xs font-medium leading-snug text-foreground outline-none focus:border-primary"
                        onChange={(e) => setEditValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            commitEdit()
                          } else if (e.key === "Escape") {
                            e.preventDefault()
                            cancelEdit()
                          }
                        }}
                        // Blur after Enter/Escape would re-fire commit/cancel; the
                        // editingId guard in commitEdit/cancelEdit makes that safe.
                        onBlur={commitEdit}
                      />
                      {editValue.length >= TITLE_COUNTER_THRESHOLD && (
                        <span
                          className={`text-[9px] tabular-nums ${
                            editValue.length >= TITLE_MAX
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          {editValue.length}/{TITLE_MAX}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span
                      className="line-clamp-2 flex-1 text-xs font-medium leading-snug"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        startEdit(conv.id, conv.title)
                      }}
                      title={t("chat.renameConversation")}
                    >
                      {conv.title}
                    </span>
                  )}
                  {isEditing ? (
                    <div className="flex flex-shrink-0 gap-0.5">
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:text-primary"
                        onMouseDown={(e) => {
                          // mouseDown not click: the input's onBlur fires
                          // before click, which would have already committed.
                          e.preventDefault()
                          e.stopPropagation()
                          commitEdit()
                        }}
                        aria-label={t("chat.renameConversation")}
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          cancelEdit()
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    hoveredId === conv.id && (
                      <div className="flex flex-shrink-0 gap-0.5">
                        <button
                          className="rounded p-0.5 text-muted-foreground hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation()
                            startEdit(conv.id, conv.title)
                          }}
                          title={t("chat.renameConversation")}
                          aria-label={t("chat.renameConversation")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteConversation(conv.id)
                            const proj = useWikiStore.getState().project
                            if (proj) {
                              deleteChatConversation(proj.path, conv.id).catch(() => {})
                            }
                          }}
                          title={t("chat.deleteConversationTooltip")}
                          aria-label={t("chat.deleteConversationTooltip")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatDate(conv.updatedAt)}</span>
                  {msgCount > 0 && (
                    <>
                      <span>·</span>
                      <span>{msgCount} {t("chat.msgCount")}</span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/**
 * Slim title bar at the top of the active conversation. Shows the
 * current title with a click-to-rename pencil — the user asked for
 * "也能在对话中修改" (also editable inside the conversation), not just
 * from the sidebar.
 */
function ConversationHeader() {
  const { t } = useTranslation()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const conv = conversations.find((c) => c.id === activeConversationId)

  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)

  const TITLE_MAX = 200
  const TITLE_COUNTER_THRESHOLD = 150

  if (!conv) return null

  function start() {
    if (!conv) return
    setValue(conv.title)
    setEditing(true)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  function commit() {
    if (!conv) return
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed !== conv.title) {
      renameConversation(conv.id, trimmed)
    }
    setEditing(false)
  }

  function cancel() {
    setEditing(false)
  }

  return (
    <div className="flex items-center gap-1.5 border-b bg-muted/20 px-3 py-1.5">
      {editing ? (
        <div className="flex flex-1 items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={t("chat.renamePlaceholder")}
            maxLength={TITLE_MAX}
            className="flex-1 rounded border bg-background px-2 py-0.5 text-xs font-medium outline-none focus:border-primary"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                cancel()
              }
            }}
            onBlur={commit}
          />
          {value.length >= TITLE_COUNTER_THRESHOLD && (
            <span
              className={`text-[10px] tabular-nums ${
                value.length >= TITLE_MAX
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {value.length}/{TITLE_MAX}
            </span>
          )}
        </div>
      ) : (
        <button
          className="flex flex-1 items-center gap-1.5 truncate text-left text-xs font-medium text-foreground hover:text-primary"
          onClick={start}
          title={t("chat.renameConversation")}
        >
          <span className="truncate">{conv.title}</span>
          <Pencil className="h-3 w-3 flex-shrink-0 opacity-50" />
        </button>
      )}
    </div>
  )
}

export function ChatPanel() {
  const { t } = useTranslation()
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const addAssistantTurn = useChatStore((s) => s.addAssistantTurn)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dropTargetRef = useRef<HTMLDivElement>(null)

  // OS files dragged into the chat — accumulate paths until the user hits
  // send, at which point we copy them to raw/sources/ with the typed message
  // as `## Context`. Tauri's webview drag-drop event delivers actual OS
  // paths (HTML5 drop in Tauri loses these — File objects, no `path`).
  const [stagedFiles, setStagedFiles] = useState<string[]>([])
  const [stagedUrls, setStagedUrls] = useState<string[]>([])
  // Images live in their own staged queue because they go through a
  // different ingest path (vision-LLM → markdown companion → ingest).
  // Each entry carries the full payload (sourcePath for drag-drop,
  // base64 for clipboard paste) plus display metadata for the chip.
  const [stagedImages, setStagedImages] = useState<
    Array<ChatImageItem & { id: string; chipName: string; chipSource: "clipboard" | "file" }>
  >([])
  const [isDropTargeted, setIsDropTargeted] = useState(false)

  // Inline web-search state. `searchQuery` non-null = the search-
  // results card is visible (loading or showing rows). `searchResults`
  // null while in-flight, [] when the provider returned nothing, and
  // populated once results land.
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<WebSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  // After the user confirms search picks, the query lingers as the
  // "intent" that gets folded into the wiki Context block on send —
  // ingest then knows WHY the user wanted these pages, not just that
  // they wanted them. Shown as a removable chip above the URL chips
  // so the user sees exactly what'll be recorded.
  const [searchIntent, setSearchIntent] = useState<string | null>(null)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)

  useEffect(() => {
    const w = getCurrentWebviewWindow()
    let unlisten: (() => void) | null = null
    let cancelled = false

    // Drop anywhere in the app window goes to the chat input. We used to
    // hit-test against the chat panel's bounding rect, but that meant
    // dropping a file onto the right-pane preview (a common reflex when
    // you're looking at a source) silently did nothing. Keeping the
    // subscription panel-scoped is still enough containment — the chat
    // panel is always mounted while you're in chat mode, and no other
    // surface in the app listens for OS file drops today.
    w.onDragDropEvent((event) => {
      const p = event.payload
      if (p.type === "drop") {
        setIsDropTargeted(false)
        if (!p.paths || p.paths.length === 0) return
        // Split images vs everything else — images go through the
        // vision-LLM extraction pipeline, other files go through
        // the existing copy-to-raw flow.
        const imagePaths: string[] = []
        const otherPaths: string[] = []
        for (const path of p.paths) {
          if (isImageSourcePath(path)) imagePaths.push(path)
          else otherPaths.push(path)
        }
        if (otherPaths.length > 0) {
          setStagedFiles((prev) => {
            const seen = new Set(prev)
            const next = [...prev]
            for (const path of otherPaths) {
              if (!seen.has(path)) {
                seen.add(path)
                next.push(path)
              }
            }
            return next
          })
        }
        if (imagePaths.length > 0) {
          setStagedImages((prev) => {
            const seenPaths = new Set(prev.filter((i) => i.sourcePath).map((i) => i.sourcePath!))
            const next = [...prev]
            for (const path of imagePaths) {
              if (seenPaths.has(path)) continue
              seenPaths.add(path)
              const name = path.split("/").pop() || path
              next.push({
                id: `img-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}-${name}`,
                sourcePath: path,
                displayName: name,
                chipName: name,
                chipSource: "file",
              })
            }
            return next
          })
        }
      } else if (p.type === "enter" || p.type === "over") {
        setIsDropTargeted(true)
      } else if (p.type === "leave") {
        setIsDropTargeted(false)
      }
    }).then((u) => {
      if (cancelled) u()
      else unlisten = u
    })

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  const removeStagedFile = useCallback((path: string) => {
    setStagedFiles((prev) => prev.filter((p) => p !== path))
  }, [])

  const addStagedUrl = useCallback((url: string) => {
    if (!isLikelyUrl(url)) return
    setStagedUrls((prev) => (prev.includes(url) ? prev : [...prev, url]))
  }, [])

  const removeStagedUrl = useCallback((url: string) => {
    setStagedUrls((prev) => prev.filter((u) => u !== url))
  }, [])

  const addStagedImage = useCallback(
    (base64: string, mediaType: string, displayName?: string) => {
      const name = displayName ?? `pasted-image-${stagedImages.length + 1}`
      setStagedImages((prev) => [
        ...prev,
        {
          id: `img-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`,
          base64,
          mediaType,
          displayName: name,
          chipName: name,
          chipSource: "clipboard",
        },
      ])
    },
    [stagedImages.length],
  )

  const removeStagedImage = useCallback((id: string) => {
    setStagedImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  // Display-only chip data passed to ChatInput. Full base64 / sourcePath
  // payloads stay in chat-panel's state — keeps the chip lightweight
  // and avoids re-rendering the input on every staged-image change.
  const imageChips: StagedImageChip[] = stagedImages.map((img) => ({
    id: img.id,
    displayName: img.chipName,
    source: img.chipSource,
  }))

  /**
   * Run a web search via the configured provider and populate the
   * inline results card. The card is rendered above the input so the
   * user can pick which results to add as URL chips (which then ride
   * the existing Phase 2 raw/sources/web pipeline on the next send).
   *
   * We surface "no provider configured" as the card's error message
   * rather than silently failing — it's a one-click hint to Settings.
   */
  const runSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query)
      setSearchResults(null)
      setSearchError(null)

      if (!hasConfiguredSearchProvider(searchApiConfig)) {
        setSearchResults([])
        setSearchError(
          "No web-search provider configured. Open Settings → Web Search and add a Tavily / SerpApi / SearXNG / Ollama key.",
        )
        return
      }

      try {
        const results = await webSearch(query, searchApiConfig, 8)
        setSearchResults(results)
      } catch (err) {
        setSearchResults([])
        setSearchError(err instanceof Error ? err.message : String(err))
      }
    },
    [searchApiConfig],
  )

  const dismissSearchResults = useCallback(() => {
    setSearchQuery(null)
    setSearchResults(null)
    setSearchError(null)
  }, [])

  const handleSearchConfirm = useCallback(
    (urls: string[]) => {
      setStagedUrls((prev) => {
        const seen = new Set(prev)
        const next = [...prev]
        for (const u of urls) {
          if (!seen.has(u)) {
            seen.add(u)
            next.push(u)
          }
        }
        return next
      })
      // Stash the query so it rides along as Context intent on the
      // eventual send. We use searchQuery (not the trimmed input) so
      // the user sees the exact phrase they typed in the chip.
      if (searchQuery) setSearchIntent(searchQuery)
      dismissSearchResults()
    },
    [dismissSearchResults, searchQuery],
  )

  const clearSearchIntent = useCallback(() => setSearchIntent(null), [])

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [activeMessages, streamingContent])

  const handleSend = useCallback(
    async (text: string) => {
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      addMessage("user", text)

      // Chat-agent path (Phase G2.2). Gated on the Labs flag + a
      // usable LLM + an open project (the agent uses wiki tools which
      // need a project root). Skips the rest of handleSend — the
      // agent loop builds its own context via tools rather than the
      // retrieval-graph + system-prompt assembly below.
      //
      // Falls through to classic streaming when:
      //   - flag is off (default)
      //   - no usable LLM (offline / unconfigured)
      //   - no project open
      //   - provider is a subprocess CLI (claude-code / codex-cli) with
      //     no tool-calling channel — the agent loop can't run on it, so
      //     we fall back to classic streaming (which DOES support these
      //     providers) instead of throwing "doesn't support provider".
      //   - agent loop throws — caller sees the error in the chat
      const chatAgentEnabled = useWikiStore.getState().experimentalChatAgent
      const agentCapable =
        chatAgentEnabled &&
        hasUsableLlm(llmConfig) &&
        providerSupportsToolAgent(llmConfig.provider) &&
        !!project

      // Badge the eventual classic answer with "Classic search" whenever the
      // user has agent mode ON but we end up answering with classic
      // retrieval — either the provider can't run the agent loop (subprocess
      // CLI), or the agent attempt below was unsatisfactory and we fell back.
      // Agent-off chats get no badge (classic is the only mode they expect).
      let markClassic =
        chatAgentEnabled &&
        hasUsableLlm(llmConfig) &&
        !!project &&
        !providerSupportsToolAgent(llmConfig.provider)

      // Agent-first: on a tool-calling provider, try the agent loop. If it
      // comes back unsatisfactory (ran out of budget, empty text, or threw)
      // we fall through to classic search below instead of committing a
      // partial reply. A clean agent answer is committed and we return.
      if (agentCapable) {
        // Lock the input + wire abort. Agent mode doesn't stream tokens, but
        // `isStreaming` also disables send + drives Stop. Same AbortController
        // shape as classic streaming so handleStop is reused unchanged.
        const controller = new AbortController()
        abortRef.current = controller
        setStreaming(true)
        let fallToClassic = false
        try {
          const searchApiConfig = useWikiStore.getState().searchApiConfig
          const outputLanguage = useWikiStore.getState().outputLanguage
          const allMessages = useChatStore.getState().messages
          const history = allMessages.filter((m) => m.conversationId === convId)
          // canWrite sub-flag: when on, runChatAgent exposes
          // write_wiki_page + update_wiki_page to the LLM. The prompt
          // teaches the agent to use those tools only when the user
          // explicitly asks for a wiki mutation.
          const canWrite = useWikiStore.getState().experimentalChatAgentCanWrite
          const result = await runChatAgent({
            userMessage: text,
            history: history.slice(0, -1),  // exclude the user message we just added
            project,
            llmConfig,
            searchApiConfig,
            outputLanguage,
            signal: controller.signal,
            canWrite,
          })
          // "Unsatisfactory" per the agreed rule: ran out of budget
          // (max_turns / max_tokens) or produced no substantive text → fall
          // back to classic search rather than commit a partial/empty reply.
          if (result.incomplete || result.text.trim().length === 0) {
            fallToClassic = true
          } else {
            addAssistantTurn(result.text, {
              toolCalls: result.toolCalls,
              fetchedSources: result.fetchedSources,
            })
          }
        } catch (err) {
          // A user Stop click is intentional — surface "(stopped)" and bail.
          // Any other error: fall back to classic rather than dead-ending on
          // "Chat-agent failed".
          if (controller.signal.aborted) {
            addMessage("assistant", `_(stopped)_`)
          } else {
            fallToClassic = true
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
        if (!fallToClassic) {
          setStreaming(false)
          return
        }
        // Fall through to the classic path below and badge its answer.
        markClassic = true
      }

      setStreaming(true)

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      let queryRefs: { title: string; path: string }[] = []
      let langReminder: string | undefined
      // Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
      // retrieval pipeline — it's slow, costs context, and drags in random
      // wiki pages the user clearly didn't ask about. Short-circuit with a
      // minimal system prompt and let the model reply conversationally.
      const greetingOnly = isGreeting(text)
      if (project && greetingOnly) {
        const outLang = getOutputLanguage(text)
        systemMessages.push({
          role: "system",
          content: [
            `You are a wiki assistant for the project "${project.name}".`,
            "The user sent a casual greeting — reply briefly and naturally, in one or two sentences.",
            "Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
            "",
            `Respond in ${outLang}.`,
          ].join("\n"),
        })
        // Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
      } else if (project) {
        const pp = normalizePath(project.path)
        const dataVersion = useWikiStore.getState().dataVersion

        // ── Budget allocation (see context-budget.ts) ─────────
        // Page budget scales with the LLM's context window; we now
        // also reserve ~15% as headroom for the response so the
        // model isn't truncated mid-sentence on a packed prompt.
        const {
          indexBudget: INDEX_BUDGET,
          pageBudget: PAGE_BUDGET,
          maxPageSize: MAX_PAGE_SIZE,
        } = computeContextBudget(llmConfig.maxContextSize)

        const [rawIndex, purpose] = await Promise.all([
          readFile(`${pp}/wiki/index.md`).catch(() => ""),
          readFile(`${pp}/purpose.md`).catch(() => ""),
        ])

        // ── Phase 1: Tokenized search → top 10 ────────────────
        const searchResults = await searchWiki(pp, text)
        const topSearchResults = searchResults.slice(0, 10)

        // ── Trim index by relevance if over budget ─────────────
        let index = rawIndex
        if (rawIndex.length > INDEX_BUDGET) {
          const { tokenizeQuery } = await import("@/lib/search")
          const tokens = tokenizeQuery(text)
          const lines = rawIndex.split("\n")
          const keptLines: string[] = []
          let keptSize = 0

          for (const line of lines) {
            const isHeader = line.startsWith("##")
            const lower = line.toLowerCase()
            const isRelevant = tokens.some((t) => lower.includes(t))

            if (isHeader || isRelevant) {
              if (keptSize + line.length + 1 <= INDEX_BUDGET) {
                keptLines.push(line)
                keptSize += line.length + 1
              }
            }
          }
          index = keptLines.join("\n")
          if (index.length < rawIndex.length) {
            index += "\n\n[...index trimmed to relevant entries...]"
          }
        }

        // ── Phase 2: Graph 1-level expansion ───────────────────
        // Note: Vector search (if enabled) is already merged into searchResults
        // by searchWiki() in search.ts — no duplicate code needed here.
        const graph = await buildRetrievalGraph(pp, dataVersion)
        const expandedIds = new Set<string>()
        const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        for (const result of topSearchResults) {
          const fileName = getFileName(result.path)
          const nodeId = fileName.replace(/\.md$/, "")
          const related = getRelatedNodes(nodeId, graph, 3)
          for (const { node, relevance } of related) {
            if (relevance < 2.0) continue
            if (searchHitPaths.has(node.path)) continue
            if (expandedIds.has(node.id)) continue
            expandedIds.add(node.id)
            graphExpansions.push({ title: node.title, path: node.path, relevance })
          }
        }
        graphExpansions.sort((a, b) => b.relevance - a.relevance)

        // ── Phase 3 & 4: Page budget control ───────────────────
        let usedChars = 0
        type PageEntry = { title: string; path: string; content: string; priority: number }
        const relevantPages: PageEntry[] = []
        const addedPaths = new Set<string>()

        const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
          if (usedChars >= PAGE_BUDGET) return false
          try {
            const raw = await readFile(filePath)
            const relativePath = getRelativePath(filePath, pp)
            if (addedPaths.has(relativePath)) return false
            const truncated = raw.length > MAX_PAGE_SIZE
              ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
              : raw
            if (usedChars + truncated.length > PAGE_BUDGET) return false
            usedChars += truncated.length
            addedPaths.add(relativePath)
            relevantPages.push({ title, path: relativePath, content: truncated, priority })
            return true
          } catch { return false }
        }

        // P-1: The page the user currently has open in the preview.
        // Injecting it (highest priority) lets "fix this page" / "correct
        // X here" work, and gives the LLM the exact target path to edit.
        let currentPageRel = ""
        const openFile = useWikiStore.getState().selectedFile
        if (openFile && /\/wiki\/.+\.md$/i.test(normalizePath(openFile))) {
          const base = getFileName(openFile)
          if (base !== "index.md" && base !== "log.md") {
            if (await tryAddPage("Currently open page", openFile, -1)) {
              currentPageRel = getRelativePath(openFile, pp)
            }
          }
        }

        // P0: Title matches
        for (const r of topSearchResults.filter((r) => r.titleMatch)) {
          await tryAddPage(r.title, r.path, 0)
        }
        // P1: Content matches
        for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
          await tryAddPage(r.title, r.path, 1)
        }
        // P2: Graph expansions
        for (const exp of graphExpansions) {
          await tryAddPage(exp.title, exp.path, 2)
        }
        // P3: Overview fallback
        if (relevantPages.length === 0) {
          await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
        }

        const pagesContext = relevantPages.length > 0
          ? relevantPages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        const pageList = relevantPages.map((p, i) =>
          `[${i + 1}] ${p.title} (${p.path})`
        ).join("\n")

        const outLang = getOutputLanguage(text)

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
            "",
            "## Rules",
            "- Answer based ONLY on the numbered wiki pages provided below.",
            "- If the provided pages don't contain enough information, say so honestly.",
            "- Use [[wikilink]] syntax to reference wiki pages.",
            "- When citing information, use the page number in brackets, e.g. [1], [2].",
            "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
            "  <!-- cited: 1, 3, 5 -->",
            "",
            "Use markdown formatting for clarity.",
            "",
            purpose ? `## Wiki Purpose\n${purpose}` : "",
            index ? `## Wiki Index\n${index}` : "",
            relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
            `## Wiki Pages\n\n${pagesContext}`,
            "",
            relevantPages.length > 0
              ? [
                  "## Editing wiki pages",
                  "If — and ONLY if — the user explicitly asks you to correct, fix, update, rewrite, or patch wiki content, propose the change as a FILE block AFTER your normal explanation:",
                  "",
                  "```",
                  "---FILE: <exact wiki/...md path from the Page List above>---",
                  "<the COMPLETE corrected page, including frontmatter>",
                  "---END FILE---",
                  "```",
                  "",
                  "Rules for the FILE block:",
                  "- Target ONE existing page by its exact `Path` shown above. Never invent a path that isn't listed.",
                  "- Output the WHOLE page, not a fragment or diff. Keep everything you are not changing; preserve the frontmatter `type`, `title`, and `created`.",
                  currentPageRel ? `- The user is currently viewing \`${currentPageRel}\` — prefer it when the request is about \"this page\".` : "",
                  "- At most ONE FILE block per response.",
                  "- If you CANNOT confidently pick one existing target page (the request is ambiguous, spans multiple pages, or no matching page exists), DO NOT emit a FILE block. Instead emit a REVIEW block so a human can decide:",
                  "  ---REVIEW: suggestion | <short title>---",
                  "  <what should change and why; name candidate pages>",
                  "  ---END REVIEW---",
                  "- For ordinary questions where no edit was requested, do NOT emit FILE or REVIEW blocks.",
                ].filter(Boolean).join("\n")
              : "",
            "",
            "---",
            "",
            `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${outLang}`,
            "",
            `You MUST write your entire response in **${outLang}**.`,
            `The wiki content above may be in a different language, but this is IRRELEVANT to your output language.`,
            `Ignore the language of the wiki content. Write in ${outLang} only.`,
            `Even proper nouns should use standard ${outLang} transliteration when appropriate.`,
            `DO NOT use any other language. This overrides all other instructions.`,
          ].filter(Boolean).join("\n"),
        })

        // Reminder injected later, right before the user's current message
        // (after history so it's the last system instruction the LLM sees).
        langReminder = buildLanguageReminder(text)

        lastQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
        queryRefs = [...lastQueryPages]
      }

      // ── Conversation history with count limit ────────────────
      // Only include messages from the active conversation, last N messages
      const activeConvMessages = useChatStore.getState().getActiveMessages()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-maxHistoryMessages)

      // Prepend the language reminder onto the final user turn rather than
      // inserting a second {role:"system"} between history and the final
      // user message. vLLM / llama.cpp / Ollama drive their chat templates
      // from HF Jinja, and Qwen3-family templates enforce "system only at
      // index 0" — a mid-conversation system message gets rejected with
      // "System message must be at the beginning." (HTTP 400). OpenAI and
      // Anthropic are more lenient, but keeping a single system at the top
      // is the safest shape across every OpenAI-compatible backend.
      const historyMessages = chatMessagesToLLM(activeConvMessages)
      let llmMessages: LLMMessage[] = [...systemMessages, ...historyMessages]
      if (langReminder && historyMessages.length > 0) {
        const lastIdx = llmMessages.length - 1
        const last = llmMessages[lastIdx]
        if (last && last.role === "user") {
          llmMessages = [
            ...llmMessages.slice(0, lastIdx),
            { role: "user", content: `[${langReminder}]\n\n${last.content}` },
          ]
        }
      }

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""
      let thinkingOpen = false

      const appendReasoning = (token: string) => {
        if (!token) return
        if (!thinkingOpen) {
          thinkingOpen = true
          accumulated += "<think>"
          appendStreamToken("<think>")
        }
        accumulated += token
        appendStreamToken(token)
      }

      const closeReasoning = () => {
        if (!thinkingOpen) return
        thinkingOpen = false
        accumulated += "</think>"
        appendStreamToken("</think>")
      }

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            closeReasoning()
            accumulated += token
            appendStreamToken(token)
          },
          onReasoningToken: appendReasoning,
          onDone: () => {
            closeReasoning()
            finalizeStream(accumulated, queryRefs, markClassic ? { retrieval: "classic" } : undefined)
            abortRef.current = null
            // save-worthy detection removed — user has direct "Save to Wiki" button on each message
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`, undefined)
            abortRef.current = null
          },
        },
        controller.signal,
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  // Drag-drop / URL-paste submit path: when the user hits send with staged
  // OS files OR staged URLs, copy them into raw/sources/ using the typed
  // text as `## Context`. We post both turns into the chat history so the
  // user sees what was added; we do NOT invoke the LLM here. The ingest
  // pipeline analyzes the new sources asynchronously.
  //
  //   - files: text-readable get inline context prepend; binaries get a
  //     sibling sidecar (see raw-from-chat.ts).
  //   - URLs: fetched via tauri-plugin-http (CORS-free), main content
  //     extracted by Readability, converted to markdown, saved under
  //     raw/sources/web/<slug>-<date>.md with the same context block.
  const handleSubmit = useCallback(
    async (text: string) => {
      // Search triggers (/search, "搜索 X", "search X") preempt the
      // normal send flow — we run the query, render results inline,
      // and let the user fold picks into staged URLs. Triggers don't
      // touch the chat history; the actual user turn happens later
      // when they confirm and send with the staged chips.
      const trig = detectSearchTrigger(text)
      if (trig) {
        // Auto-create a conversation so the search card is anchored
        // somewhere (otherwise mounting a card with no conversation
        // looks orphaned and a later send would create one anyway).
        let convId = useChatStore.getState().activeConversationId
        if (!convId) createConversation()
        runSearch(trig.query)
        return
      }

      const filesNow = stagedFiles
      const urlsNow = stagedUrls
      const imagesNow = stagedImages
      const intentNow = searchIntent
      if (filesNow.length === 0 && urlsNow.length === 0 && imagesNow.length === 0) {
        handleSend(text)
        return
      }
      if (!project) {
        addMessage("assistant", "Open a wiki project first — nothing can be added without one.")
        setStagedFiles([])
        setStagedUrls([])
        setStagedImages([])
        setSearchIntent(null)
        return
      }

      // Compose the Context note: prepend the search intent (if any)
      // so ingest knows the user's search angle, then the user's
      // typed note. Either alone is fine; both together is the rich
      // case. Stored as-is in the `## Context` block prepended to
      // each saved raw file.
      const composedContext = intentNow
        ? `🔍 Search query: ${intentNow}${text.trim() ? `\n\n${text.trim()}` : ""}`
        : text
      let convId = useChatStore.getState().activeConversationId
      if (!convId) convId = createConversation()

      const userLines: string[] = []
      if (intentNow) userLines.push(`🔍 Searched: ${intentNow}`)
      if (text.trim()) userLines.push(text.trim())
      const stagedCount = filesNow.length + urlsNow.length + imagesNow.length
      userLines.push(
        `📎 Added to wiki (${stagedCount} item${stagedCount === 1 ? "" : "s"}):`,
      )
      for (const p of filesNow) userLines.push(`- 📄 \`${getFileName(p)}\``)
      for (const u of urlsNow) userLines.push(`- 🔗 ${u}`)
      for (const img of imagesNow) userLines.push(`- 🖼️ \`${img.chipName}\``)
      addMessage("user", userLines.join("\n"))
      setStagedFiles([])
      setStagedUrls([])
      setStagedImages([])
      setSearchIntent(null)

      const lines: string[] = []

      if (filesNow.length > 0) {
        try {
          const result = await addFilesToRawWithContext(project, filesNow, composedContext, llmConfig)
          if (result.imported.length > 0) {
            lines.push(
              `Copied ${result.imported.length} file${result.imported.length === 1 ? "" : "s"} to \`raw/sources/\`${composedContext.trim() ? " with your note as `## Context`" : ""}.`,
            )
          }
          if (result.failed.length > 0) {
            lines.push(`❌ Files failed: ${result.failed.map((p) => getFileName(p)).join(", ")}`)
          }
        } catch (err) {
          lines.push(`❌ Failed to add files: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (urlsNow.length > 0) {
        try {
          const result = await addUrlsToRawWithContext(project, urlsNow, composedContext, llmConfig)
          if (result.imported.length > 0) {
            lines.push(
              `Fetched ${result.imported.length} URL${result.imported.length === 1 ? "" : "s"} into \`raw/sources/web/\`.`,
            )
          }
          if (result.failed.length > 0) {
            const detail = result.failed
              .map((f) => `\`${f.url}\` — ${f.error}`)
              .join("; ")
            lines.push(`❌ URL fetch failed: ${detail}`)
          }
        } catch (err) {
          lines.push(`❌ Failed to fetch URLs: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (imagesNow.length > 0) {
        try {
          const result = await addImagesToRawWithContext(
            project,
            imagesNow.map(({ id: _id, chipName: _cn, chipSource: _cs, ...rest }) => rest),
            composedContext,
            llmConfig,
          )
          if (result.imported.length > 0) {
            lines.push(
              `Extracted ${result.imported.length} image${result.imported.length === 1 ? "" : "s"} into \`raw/sources/images/\` via vision LLM.`,
            )
          }
          if (result.visionRefusals > 0) {
            // Heuristic detection (`looksLikeNoImageRefusal`) caught the
            // LLM saying "no image visible" etc. Surface this as a
            // prominent ⚠️ block in the assistant reply so the user
            // doesn't have to open the .md to discover the model
            // can't actually see images. The two phrasings match the
            // two failure modes — dedicated multimodal LLM is misconfigured
            // vs. user is reusing a text-only main LLM for vision.
            const where = result.usedDedicatedVisionLlm
              ? `**Settings → Multimodal** 里配置的视觉模型 \`${result.attemptedVisionModel}\` 似乎不支持图像输入`
              : `当前 chat LLM \`${result.attemptedVisionModel}\` 不支持多模态输入`
            const fix = result.usedDedicatedVisionLlm
              ? "换一个支持 vision 的模型（如 Gemini 2.5 Flash / Claude Haiku / GPT-4o），保存后对图片执行「重新提取这一个文件」"
              : "去 **Settings → Multimodal** 开启并配置一个支持 vision 的模型（如 Gemini 2.5 Flash / Claude Haiku / GPT-4o），保存后对图片执行「重新提取这一个文件」"
            lines.push(
              `⚠️ **图片识别失败** (${result.visionRefusals}/${imagesNow.length})：${where}。\n\n${fix}。`,
            )
          }
          if (result.failed.length > 0) {
            const detail = result.failed.map((f) => `\`${f.item}\` — ${f.error}`).join("; ")
            lines.push(`❌ Image import failed: ${detail}`)
          }
        } catch (err) {
          lines.push(`❌ Failed to process images: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (lines.some((l) => !l.startsWith("❌"))) {
        lines.push("Ingest queued — pages will appear in the wiki once analysis completes.")
      }

      addMessage("assistant", lines.length > 0 ? lines.join("\n\n") : "Nothing was added.")

      // Refresh the file tree so the user sees the new sources appear.
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch {
        // non-fatal
      }
    },
    [stagedFiles, stagedUrls, stagedImages, searchIntent, project, llmConfig, handleSend, addMessage, createConversation, setFileTree, runSearch],
  )

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    handleSend(lastUserMsg.content)
  }, [isStreaming, removeLastAssistantMessage, handleSend])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(pp)
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig, setFileTree])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <ConversationSidebar />

      <div
        ref={dropTargetRef}
        className={`flex flex-1 flex-col overflow-hidden ${isDropTargeted ? "ring-2 ring-inset ring-primary/40" : ""}`}
      >
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">{t("chat.startNewConversation")}</p>
              <p className="mt-1 text-xs opacity-60">{t("chat.clickNewChatToBegin")}</p>
            </div>
          </div>
        ) : (
          <>
            <ConversationHeader />
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-3 py-2"
            >
              <div className="flex flex-col gap-3">
                {activeMessages.map((msg, idx) => {
                  // Check if this is the last assistant message
                  const isLastAssistant = msg.role === "assistant" &&
                    !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                  return (
                    <ChatMessage
                      key={msg.id}
                      message={msg}
                      isLastAssistant={isLastAssistant && !isStreaming}
                      onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                    />
                  )
                })}
                {isStreaming && <StreamingMessage content={streamingContent} />}
                <div ref={bottomRef} />
              </div>
            </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  {t("chat.writeToWiki")}
                </Button>
              </div>
            )}
          </>
        )}

        {searchQuery !== null && (
          <ChatSearchResults
            query={searchQuery}
            results={searchResults}
            error={searchError}
            onConfirm={handleSearchConfirm}
            onDismiss={dismissSearchResults}
          />
        )}
        <ChatInput
          onSend={handleSubmit}
          onStop={handleStop}
          isStreaming={isStreaming}
          placeholder={
            mode === "ingest"
              ? t("chat.ingestPlaceholder")
              : t("chat.typeAMessage")
          }
          stagedFiles={stagedFiles}
          onRemoveFile={removeStagedFile}
          stagedUrls={stagedUrls}
          onAddUrl={addStagedUrl}
          onRemoveUrl={removeStagedUrl}
          stagedImages={imageChips}
          onAddImage={addStagedImage}
          onRemoveImage={removeStagedImage}
          onSearchClick={() => { /* prefill handled in ChatInput */ }}
          searchIntent={searchIntent}
          onClearSearchIntent={clearSearchIntent}
        />
      </div>
    </div>
  )
}
