import { useRef, useState, useCallback, useEffect } from "react"
import { Send, Square, X, Paperclip, Link as LinkIcon, Search, Image as ImageIcon, Globe, FileSearch } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { isImeComposing } from "@/lib/keyboard-utils"
import { getFileName } from "@/lib/path-utils"
import { isLikelyUrl } from "@/lib/web-fetch"
import { looksLikeSearchTrigger } from "@/lib/search-trigger"

/** Display-only shape for image chips. Full base64 / path lives in the parent. */
export interface StagedImageChip {
  id: string
  displayName: string
  /** "clipboard" | "file" — drives icon + tooltip label only. */
  source: "clipboard" | "file"
}

interface ChatInputProps {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  /**
   * Chat-agent search toggles (ported from upstream cea0029). Controlled
   * by the chat-store (persisted per project) — the buttons here just
   * flip the store value via the change callbacks. `anyTxtAvailable`
   * gates the AnyTXT toggle: when no AnyTXT config exists it renders
   * disabled (the fork has no AnyTXT settings UI yet, so it's effectively
   * always off, but the control is wired for parity + future use).
   */
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  onUseWebSearchChange: (enabled: boolean) => void
  onUseAnyTxtSearchChange: (enabled: boolean) => void
  anyTxtAvailable?: boolean
  placeholder?: string
  stagedFiles?: string[]
  onRemoveFile?: (path: string) => void
  stagedUrls?: string[]
  onAddUrl?: (url: string) => void
  onRemoveUrl?: (url: string) => void
  /**
   * Image inputs (clipboard paste / drag-drop / picker). Display
   * chips with an image icon. Removal callback removes the
   * corresponding full payload in the parent's state.
   */
  stagedImages?: StagedImageChip[]
  onAddImage?: (base64: string, mediaType: string, displayName?: string) => void
  onRemoveImage?: (id: string) => void
  /**
   * When supplied, the 🔍 button is rendered. Click pre-fills the
   * textarea with `/search ` so the user can type the query and press
   * Enter — same code path as if they had typed it manually, which
   * keeps `onSend` the single funnel for search triggers.
   */
  onSearchClick?: () => void
  /**
   * After search confirm, the original query lingers as the wiki
   * Context "intent" — rendered above the URL chips with a 🔍 icon
   * so the user can see / remove what'll be recorded as the search
   * angle. On send, chat-panel folds it into the Context block.
   */
  searchIntent?: string | null
  onClearSearchIntent?: () => void
}

/**
 * Encode an ArrayBuffer to base64 without blowing the stack on large
 * pastes. `String.fromCharCode(...arr)` apply-spreads the entire array
 * onto the stack, which throws RangeError above ~120k elements — a
 * 1MB screenshot easily blows past that. Chunked 32KB-at-a-time
 * conversion keeps us safe up to multi-MB images.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    )
  }
  return btoa(binary)
}

/** Pill styling for the chat-agent search toggles, on vs off. */
function searchToggleClass(active: boolean): string {
  return [
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
    active
      ? "border-primary/40 bg-primary/10 text-primary"
      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
  ].join(" ")
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  useWebSearch,
  useAnyTxtSearch,
  onUseWebSearchChange,
  onUseAnyTxtSearchChange,
  anyTxtAvailable = true,
  placeholder,
  stagedFiles,
  onRemoveFile,
  stagedUrls,
  onAddUrl,
  onRemoveUrl,
  stagedImages,
  onAddImage,
  onRemoveImage,
  onSearchClick,
  searchIntent,
  onClearSearchIntent,
}: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // If AnyTXT becomes unavailable while its toggle is on, switch it back
  // off (ported from upstream cea0029) so we never ask the agent to use a
  // tool that isn't configured.
  useEffect(() => {
    if (!anyTxtAvailable && useAnyTxtSearch) onUseAnyTxtSearchChange(false)
  }, [anyTxtAvailable, onUseAnyTxtSearchChange, useAnyTxtSearch])

  const isSearching = looksLikeSearchTrigger(value)
  const hasSearchIntent = Boolean(searchIntent && searchIntent.length > 0)

  const handleSearchClick = useCallback(() => {
    if (!onSearchClick) return
    onSearchClick()
    // Prefill with `/search ` so the user can type the query. If they
    // already had text, prepend; if it already starts with `/search`
    // just focus.
    setValue((prev) => {
      const trimmed = prev.trim()
      if (/^\/search/i.test(trimmed)) return prev
      return `/search ${prev}`.trimEnd() + (prev.trim() ? "" : "")
    })
    // Focus + place caret at the end so typing the query is immediate.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const len = ta.value.length
        ta.setSelectionRange(len, len)
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
      }
    })
  }, [onSearchClick])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const hasFiles = (stagedFiles?.length ?? 0) > 0
  const hasUrls = (stagedUrls?.length ?? 0) > 0
  const hasImages = (stagedImages?.length ?? 0) > 0
  const hasStaged = hasFiles || hasUrls || hasImages
  const hasAnyContext = hasStaged || hasSearchIntent
  const canSend = !isStreaming && (value.trim().length > 0 || hasStaged)

  const handleSend = useCallback(() => {
    if (!canSend) return
    onSend(value.trim())
    setValue("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [canSend, value, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit on the Enter that commits an IME candidate —
      // the user is mid-composition (Chinese / Japanese / Korean
      // input method picking an English word or phrase) and would
      // see the message fire before they finished typing.
      if (isImeComposing(e)) return
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // Paste-detection: image bytes win over URL detection. Order matters
  // because a clipboard with both image data AND text (e.g. macOS
  // Preview "Copy Image" can carry both) should route to the image
  // chip, not a stringified URL.
  //
  //   1. Look for `image/*` items first → read as ArrayBuffer → base64
  //      → onAddImage. This covers Cmd+Shift+4 screenshots, "Copy
  //      Image" from browsers, and clipboard tools like Snipaste.
  //   2. Otherwise fall back to the existing URL paste fast-path.
  //   3. Otherwise let the textarea handle the paste natively.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Image branch
      if (onAddImage) {
        const items = Array.from(e.clipboardData.items ?? [])
        const imageItems = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        if (imageItems.length > 0) {
          e.preventDefault()
          for (const it of imageItems) {
            const file = it.getAsFile()
            if (!file) continue
            // Async read; UI shows the chip the moment readAsArrayBuffer
            // resolves. We don't await here because handlePaste itself
            // can't be async (React synthetic events would be pooled).
            file.arrayBuffer().then((buf) => {
              const b64 = arrayBufferToBase64(buf)
              const displayName = file.name && file.name !== "image.png"
                ? file.name
                : `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${file.type === "image/png" ? "png" : "img"}`
              onAddImage(b64, file.type || "image/png", displayName)
            }).catch((err) => {
              console.warn("[chat-input] failed to read pasted image:", err)
            })
          }
          return
        }
      }
      // URL branch (existing behaviour)
      if (onAddUrl) {
        const txt = e.clipboardData.getData("text/plain")
        if (txt && isLikelyUrl(txt)) {
          e.preventDefault()
          onAddUrl(txt.trim())
        }
      }
    },
    [onAddImage, onAddUrl],
  )

  return (
    <div className="flex flex-col border-t">
      {hasAnyContext && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
          {hasSearchIntent && (
            <div
              key={`search-intent:${searchIntent}`}
              className="flex max-w-[320px] items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs"
              title={`Search query — recorded as wiki Context: ${searchIntent}`}
            >
              <Search className="h-3 w-3 shrink-0 text-primary" />
              <span className="truncate text-primary">{searchIntent}</span>
              {onClearSearchIntent && (
                <button
                  type="button"
                  onClick={onClearSearchIntent}
                  className="shrink-0 rounded p-0.5 text-primary/70 hover:bg-background hover:text-primary"
                  title="Remove search intent"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          {stagedImages?.map((img) => (
            <div
              key={`image:${img.id}`}
              className="flex max-w-[240px] items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs"
              title={`${img.source === "clipboard" ? "Pasted image" : "Image file"}: ${img.displayName}`}
            >
              <ImageIcon className="h-3 w-3 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <span className="truncate text-emerald-700 dark:text-emerald-300">{img.displayName}</span>
              {onRemoveImage && (
                <button
                  type="button"
                  onClick={() => onRemoveImage(img.id)}
                  className="shrink-0 rounded p-0.5 text-emerald-700 dark:text-emerald-300/70 hover:bg-background hover:text-emerald-700 dark:text-emerald-400/70 dark:hover:text-emerald-300"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {stagedFiles?.map((path) => (
            <div
              key={`file:${path}`}
              className="flex max-w-[240px] items-center gap-1 rounded-md border bg-muted/60 px-2 py-1 text-xs"
              title={path}
            >
              <Paperclip className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{getFileName(path)}</span>
              {onRemoveFile && (
                <button
                  type="button"
                  onClick={() => onRemoveFile(path)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {stagedUrls?.map((url) => (
            <div
              key={`url:${url}`}
              className="flex max-w-[280px] items-center gap-1 rounded-md border bg-muted/60 px-2 py-1 text-xs"
              title={url}
            >
              <LinkIcon className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{hostnameOf(url)}</span>
              {onRemoveUrl && (
                <button
                  type="button"
                  onClick={() => onRemoveUrl(url)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {/*
        Chat-agent search toggles (ported from upstream cea0029). When on,
        the agent is allowed to call the corresponding tool (web / AnyTXT)
        while building context. State is owned by the chat-store and
        persisted per project; these buttons just flip it.
      */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
        <button
          type="button"
          aria-pressed={useWebSearch}
          onClick={() => onUseWebSearchChange(!useWebSearch)}
          disabled={isStreaming}
          className={searchToggleClass(useWebSearch)}
        >
          <Globe className="h-3 w-3" />
          {t("chat.searchToggle.web")}
        </button>
        {anyTxtAvailable && (
          <button
            type="button"
            aria-pressed={useAnyTxtSearch}
            onClick={() => onUseAnyTxtSearchChange(!useAnyTxtSearch)}
            disabled={isStreaming || !anyTxtAvailable}
            className={searchToggleClass(useAnyTxtSearch)}
          >
            <FileSearch className="h-3 w-3" />
            {t("chat.searchToggle.anytxt")}
          </button>
        )}
      </div>
      <div className="flex items-end gap-2 p-3 pt-2">
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isSearching
              ? "Type your search query. Enter to run."
              : hasStaged
              ? "Optional: describe these (becomes wiki context). Enter to add."
              : placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline. Paste a URL to fetch it. /search <q> to search the web.)"
          }
          disabled={isStreaming}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
        {!isStreaming && onSearchClick && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSearchClick}
            className="shrink-0"
            title="Search the web (/search)"
          >
            <Search className="h-4 w-4" />
          </Button>
        )}
        {isStreaming ? (
          <Button
            variant="destructive"
            size="icon"
            onClick={onStop}
            className="shrink-0"
            title="Stop generation"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!canSend}
            className="shrink-0"
            title={isSearching ? "Search" : hasStaged ? "Add to wiki" : "Send message"}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
