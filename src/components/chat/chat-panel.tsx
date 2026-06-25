import { useRef, useEffect, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, Plus, Trash2, MessageSquare, Pencil, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles, type ChatReferencePreview } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { isReasoningOnlyResponseError, streamChat } from "@/lib/llm-client"
import { buildChatAgentMessages, type ChatAgentEvent } from "@/lib/chat-agent"
import { hasConfiguredAnyTxt } from "@/lib/anytxt-search"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory } from "@/commands/fs"
import { deleteChatConversation } from "@/lib/persist"
import { normalizePath, getFileName } from "@/lib/path-utils"
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
// Reference-preview side-panel building blocks (ported from upstream).
// The panel reuses the editor's existing file/markdown renderers so a
// cited reference previews identically to how it'd look in the wiki view.
import { FilePreview } from "@/components/editor/file-preview"
import { WikiReader } from "@/components/editor/wiki-reader"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileCategory } from "@/lib/file-types"

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
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  // Chat-agent search toggles (ported from upstream cea0029). Lifted into
  // the store so they persist per project; passed down to ChatInput as
  // controlled props and read in handleSend to gate web/anytxt tools.
  const useWebSearch = useChatStore((s) => s.useWebSearch)
  const useAnyTxtSearch = useChatStore((s) => s.useAnyTxtSearch)
  // v0.5.1: agent routing mode (fast/standard/deep/local_first). Also lifted
  // into the store so it persists per device and is read in handleSend to
  // pick how aggressively the agent loop retrieves.
  const agentMode = useChatStore((s) => s.agentMode)
  const setUseWebSearch = useChatStore((s) => s.setUseWebSearch)
  const setUseAnyTxtSearch = useChatStore((s) => s.setUseAnyTxtSearch)
  const setAgentMode = useChatStore((s) => s.setAgentMode)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  // Monotonic id for the active send. Bumped on stop / new send so a
  // stale agent run can detect it's no longer current and skip committing.
  const runIdRef = useRef(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dropTargetRef = useRef<HTMLDivElement>(null)
  // Live chat-agent activity feed shown above the streaming reply.
  const [agentEvents, setAgentEvents] = useState<ChatAgentEvent[]>([])

  // Chat-internal reference-preview side panel (ported from upstream).
  // Clicking a citation sets `referencePreview`; the panel renders as a
  // resizable right pane INSIDE the chat view (sibling of the message
  // column, NOT the app-wide wiki view), so it coexists with our
  // standalone-view layout. `null` = closed. Width persists for the
  // session only.
  const [referencePreview, setReferencePreview] = useState<ChatReferencePreview | null>(null)
  const [referencePreviewWidth, setReferencePreviewWidth] = useState(420)

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
  // AnyTXT desktop search is only offered when a usable AnyTXT config
  // exists. The fork ships no AnyTXT settings UI yet, so this stays false
  // and the toggle renders disabled — the plumbing is here for parity with
  // upstream and a future settings panel.
  const anyTxtAvailable = hasConfiguredAnyTxt(searchApiConfig.anyTxt)

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
      // ── Chat-agent routing (ported from upstream cea0029) ────────
      // Every chat turn now flows through the multi-tool chat agent
      // (`buildChatAgentMessages`): it does query understanding, decides
      // which tools to call (wiki / graph / web / anytxt), runs them,
      // assembles the context, and hands back the final LLM message list
      // which we then stream. This REPLACES the fork's old experimental
      // chat-agent + the classic graph-retrieval system-prompt assembly
      // — "stop ours, use theirs". The web/anytxt toggles come from the
      // chat-store (persisted per project).
      const sendOptions = {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        // v0.5.1: feed the chosen agent mode into the routing loop so it can
        // pick its round budget (deep = more rounds) and tool preferences.
        mode: useChatStore.getState().agentMode,
      }
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      addMessage("user", text)
      setStreaming(true)
      setAgentEvents([])
      let finalized = false
      // runId guards against a stale agent run committing tokens after the
      // user has hit Stop or fired a newer send (handleStop bumps runId).
      const runId = ++runIdRef.current

      try {
        const controller = new AbortController()
        abortRef.current = controller
        const isCurrentRun = () => runIdRef.current === runId && !controller.signal.aborted

        // ── Conversation history with count limit ────────────────
        // Only include messages from the active conversation, last N
        // messages. The agent uses this for follow-up understanding and
        // to thread retrieval history across turns.
        const activeConvMessages = useChatStore.getState().getActiveMessages()
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-maxHistoryMessages)
        const historyMessages = chatMessagesToLLM(activeConvMessages)
        const retrievalHistory = collectRecentRetrievalHistory(activeConvMessages)

        const agentResult = await buildChatAgentMessages({
          project: project ? { name: project.name, path: project.path } : null,
          llmConfig,
          searchApiConfig,
          text,
          historyMessages,
          retrievalHistory,
          dataVersion: useWikiStore.getState().dataVersion,
          options: sendOptions,
          signal: controller.signal,
          onEvent: (event) => {
            if (!isCurrentRun()) return
            // Keep only the most recent handful so the activity feed
            // doesn't grow unbounded on a long multi-round retrieval.
            setAgentEvents((prev) => [...prev, event].slice(-6))
          },
        })
        if (!isCurrentRun()) return
        // Expose the cited pages for SourceFilesBar (legacy module global).
        lastQueryPages = agentResult.queryPages

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

        // ── Final-answer stream w/ reasoning-only recovery (v0.5.1) ──
        // Some "thinking" endpoints (DeepSeek-R1-style, Qwen reasoning
        // deployments) occasionally stream a large chain-of-thought and
        // then end the response with NO actual answer content. streamChat
        // detects that and surfaces it as an isReasoningOnlyResponseError.
        // When that happens we discard the half-baked thinking we showed,
        // and re-run the SAME assembled message list once with reasoning
        // forced OFF — which reliably coaxes a plain answer out. We no
        // longer commit inside onDone/onError; instead each attempt either
        // completes normally or rethrows a captured stream error, and we
        // finalize once after the (possibly retried) attempt succeeds.
        const streamFinalAnswer = async (reasoningOff: boolean) => {
          let streamError: Error | null = null
          await streamChat(
            llmConfig,
            agentResult.messages,
            {
              onToken: (token) => {
                if (!isCurrentRun()) return
                closeReasoning()
                accumulated += token
                appendStreamToken(token)
              },
              onReasoningToken: (token) => {
                if (!isCurrentRun()) return
                // On the reasoning-off retry, drop any stray reasoning
                // tokens so we don't re-open a <think> block.
                if (reasoningOff) return
                appendReasoning(token)
              },
              onDone: () => {},
              onError: (err) => {
                streamError = err
              },
            },
            controller.signal,
            reasoningOff ? { reasoning: { mode: "off" } } : undefined,
          )
          if (streamError) throw streamError
        }

        try {
          await streamFinalAnswer(false)
        } catch (err) {
          if (!isCurrentRun()) return
          if (isReasoningOnlyResponseError(err)) {
            // Reset the visible/accumulated buffer and retry once with
            // reasoning disabled.
            accumulated = ""
            thinkingOpen = false
            useChatStore.setState({ streamingContent: "" })
            await streamFinalAnswer(true)
          } else {
            throw err
          }
        }

        if (!isCurrentRun()) return
        closeReasoning()
        finalized = true
        // Persist the agent's tool/routing steps alongside the reply so
        // the chat-message renderer can show the agent-activity trail.
        finalizeStream(accumulated, agentResult.references, { steps: agentResult.steps })
        setAgentEvents([])
        abortRef.current = null
        // save-worthy detection removed — user has direct "Save to Wiki" button on each message
      } catch (err) {
        if (!finalized) {
          if (isAbortLikeError(err) || runIdRef.current !== runId) {
            setStreaming(false)
            setAgentEvents([])
            abortRef.current = null
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          finalizeStream(`Error: ${message}`, undefined)
          setAgentEvents([])
        }
        abortRef.current = null
      }
    },
    [project, llmConfig, searchApiConfig, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages],
  )

  const handleStop = useCallback(() => {
    // Bump runId first so any in-flight agent run / stream callback that
    // fires after this is treated as stale (isCurrentRun() → false).
    runIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setAgentEvents([])
  }, [setStreaming])

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
                      onOpenReferencePreview={setReferencePreview}
                    />
                  )
                })}
                {isStreaming && <StreamingMessage content={streamingContent} agentEvents={agentEvents} />}
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
          useWebSearch={useWebSearch}
          useAnyTxtSearch={useAnyTxtSearch}
          agentMode={agentMode}
          onUseWebSearchChange={setUseWebSearch}
          onUseAnyTxtSearchChange={setUseAnyTxtSearch}
          onAgentModeChange={setAgentMode}
          anyTxtAvailable={anyTxtAvailable}
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

      {/*
        Reference-preview side panel (ported from upstream). Rendered as a
        third flex column to the RIGHT of the message column, inside the
        chat view's own `flex-row` — so it's scoped to chat and never
        replaces our standalone wiki view. Citation clicks set the
        preview; FILE cards / "open page" buttons still go through
        `openFileInPreview` (the full wiki view) unchanged.
      */}
      {referencePreview && (
        <ChatReferencePreviewPanel
          preview={referencePreview}
          width={referencePreviewWidth}
          onResize={setReferencePreviewWidth}
          onClose={() => setReferencePreview(null)}
        />
      )}
    </div>
  )
}

/**
 * Resizable right-side panel that previews a clicked chat citation
 * (ported from upstream). Reuses the editor's FilePreview / WikiReader /
 * FrontmatterPanel so a reference renders identically to the wiki view,
 * but stays contained within the chat panel. The left edge is a
 * pointer-drag separator (also keyboard-resizable for a11y).
 */
function ChatReferencePreviewPanel({
  preview,
  width,
  onResize,
  onClose,
}: {
  preview: ChatReferencePreview
  width: number
  onResize: (width: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const displayTitle = preview.title || getFileName(preview.path)
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [width])

  const handleResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    const delta = dragStartRef.current.x - event.clientX
    onResize(clampReferencePreviewWidth(dragStartRef.current.width + delta))
  }, [onResize])

  const stopResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <aside
      className="relative flex h-full min-w-[320px] max-w-[56%] shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resizeReferencePreview")}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={handleResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width + 32))
          } else if (event.key === "ArrowRight") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width - 32))
          }
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize outline-none transition-colors hover:bg-primary/15 focus-visible:bg-primary/20"
      />
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" title={displayTitle}>
            {displayTitle}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={preview.path}>
            {preview.source ?? t("chat.referencePreview")} · {preview.path}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chat.closeReferencePreview")}
          aria-label={t("chat.closeReferencePreview")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {preview.external ? (
          <ExternalReferencePreview preview={preview} />
        ) : getFileCategory(preview.path) === "markdown" ? (
          <ChatMarkdownReferencePreview preview={preview} />
        ) : (
          <FilePreview
            key={preview.path}
            filePath={preview.path}
            textContent={preview.content}
          />
        )}
      </div>
    </aside>
  )
}

// Clamp the side-panel width to a sane on-screen range (matches upstream).
function clampReferencePreviewWidth(width: number): number {
  return Math.min(760, Math.max(320, Math.round(width)))
}

// Markdown reference preview: frontmatter card + rendered wiki body,
// mirroring the wiki view's markdown layout (ported from upstream).
function ChatMarkdownReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { frontmatter, body } = parseFrontmatter(preview.content)
  return (
    <div className="h-full overflow-auto px-6 py-6">
      {frontmatter && <FrontmatterPanel data={frontmatter} />}
      <WikiReader body={body} filePath={preview.path} />
    </div>
  )
}

// External / AnyTXT reference preview: shows the source label, locator,
// and returned snippet text (ported from upstream). Used when the cited
// reference isn't an on-disk file.
function ExternalReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          {preview.source && (
            <span className="rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              {preview.source}
            </span>
          )}
          <h3 className="truncate text-sm font-medium" title={preview.title}>{preview.title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {preview.path.replace(/^[a-z]+-preview:\/\//, "")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {preview.snippet?.trim() || t("chat.noReferencePreviewFragment")}
        </pre>
      </div>
    </div>
  )
}

/**
 * Treat user-Stop aborts (and AbortController cancellations) as benign so
 * we silence them instead of surfacing "Error: aborted" in the chat.
 * Ported from upstream cea0029's chat-agent routing.
 */
function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (!(err instanceof Error)) return false
  return err.name === "AbortError" || /abort|cancel/i.test(err.message)
}

/**
 * Thread retrieval context across turns: gather the references the
 * assistant cited in recent replies (most-recent-first, deduped by
 * kind+url/path) so the agent's follow-up understanding can reuse what
 * was already found instead of re-searching from scratch. Capped at 10.
 * Ported from upstream cea0029.
 */
function collectRecentRetrievalHistory(
  messages: ReturnType<typeof useChatStore.getState>["messages"],
): MessageReference[] {
  const refs: MessageReference[] = []
  const seen = new Set<string>()
  for (const msg of [...messages].reverse()) {
    if (msg.role !== "assistant" || !msg.references) continue
    for (const ref of msg.references) {
      const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
      if (refs.length >= 10) return refs
    }
  }
  return refs
}
