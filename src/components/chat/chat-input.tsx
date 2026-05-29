import { useRef, useState, useCallback } from "react"
import { Send, Square, X, Paperclip, Link as LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isImeComposing } from "@/lib/keyboard-utils"
import { getFileName } from "@/lib/path-utils"
import { isLikelyUrl } from "@/lib/web-fetch"

interface ChatInputProps {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  placeholder?: string
  stagedFiles?: string[]
  onRemoveFile?: (path: string) => void
  stagedUrls?: string[]
  onAddUrl?: (url: string) => void
  onRemoveUrl?: (url: string) => void
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
  placeholder,
  stagedFiles,
  onRemoveFile,
  stagedUrls,
  onAddUrl,
  onRemoveUrl,
}: ChatInputProps) {
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const hasFiles = (stagedFiles?.length ?? 0) > 0
  const hasUrls = (stagedUrls?.length ?? 0) > 0
  const hasStaged = hasFiles || hasUrls
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

  // Paste-detection for URLs: if the user pastes a single URL with nothing
  // else in the clipboard text, intercept it and route to staged URLs so
  // it becomes a chip — much faster than typing into the box and asking
  // the model to "fetch this". Anything else (multi-line, URL inside a
  // sentence, plain text) is left alone.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onAddUrl) return
      const txt = e.clipboardData.getData("text/plain")
      if (txt && isLikelyUrl(txt)) {
        e.preventDefault()
        onAddUrl(txt.trim())
      }
    },
    [onAddUrl],
  )

  return (
    <div className="flex flex-col border-t">
      {hasStaged && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
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
      <div className="flex items-end gap-2 p-3 pt-2">
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            hasStaged
              ? "Optional: describe these (becomes wiki context). Enter to add."
              : placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline. Paste a URL to fetch it.)"
          }
          disabled={isStreaming}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
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
            title={hasStaged ? "Add to wiki" : "Send message"}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
