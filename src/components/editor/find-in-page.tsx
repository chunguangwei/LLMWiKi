import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Search, ChevronUp, ChevronDown, X } from "lucide-react"
import { isImeComposing } from "@/lib/keyboard-utils"

/**
 * In-page find (Cmd/Ctrl+F) for the page viewer.
 *
 * Highlighting uses the CSS Custom Highlight API: matches are expressed as
 * DOM Ranges painted via `CSS.highlights`, with ZERO DOM mutation. That's
 * what makes it safe over the Milkdown editor — wrapping matches in <mark>
 * spans would corrupt ProseMirror's view. The same path covers read-mode
 * react-markdown too, so there's one implementation for both modes.
 *
 * Matching is a case-insensitive substring scan over text nodes inside
 * `containerRef`. Limitation: a query that straddles element boundaries
 * (e.g. across a bold span) won't match — acceptable for a find bar.
 *
 * A MutationObserver re-runs the search when the container's DOM changes,
 * so toggling read/edit mode or typing in the editor keeps highlights in
 * sync rather than leaving stale (and now-invalid) ranges behind.
 */

const HL_ALL = "find-in-page"
const HL_CURRENT = "find-in-page-current"
const MAX_MATCHES = 2000

/**
 * Collect DOM Ranges for every case-insensitive occurrence of `needle`
 * within `container`'s text nodes, capped at `max`. Pure (no highlighting,
 * no scrolling) so the matching is unit-testable without the CSS Highlight
 * API. Matches are confined to a single text node — a query spanning
 * element boundaries won't match.
 */
export function collectMatchRanges(container: Node, needle: string, max = MAX_MATCHES): Range[] {
  const ranges: Range[] = []
  const q = needle.toLowerCase()
  if (!q) return ranges
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue
    if (text) {
      const hay = text.toLowerCase()
      let from = hay.indexOf(q)
      while (from !== -1) {
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, from + q.length)
        ranges.push(range)
        if (ranges.length >= max) return ranges
        from = hay.indexOf(q, from + q.length)
      }
    }
    node = walker.nextNode()
  }
  return ranges
}

// The CSS Custom Highlight API isn't in every TS DOM lib version yet, so
// reach it through narrowly-typed locals instead of sprinkling `any`.
type HighlightLike = { priority: number }
type HighlightCtor = new (...ranges: Range[]) => HighlightLike
const HighlightImpl = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
// `CSS` itself can be undefined under jsdom, so reach it off globalThis
// rather than the bare identifier (which would throw at module load).
const highlightRegistry = (globalThis as unknown as { CSS?: { highlights?: Map<string, HighlightLike> } })
  .CSS?.highlights
const supportsHighlightApi = !!HighlightImpl && !!highlightRegistry

export function FindInPage({
  containerRef,
  resetKey,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  /** Changes when the open page changes — re-runs the search against the
   * new DOM and discards ranges from the old one. */
  resetKey?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(0) // 1-based position of the active match
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  const activeRef = useRef(0) // 0-based index into rangesRef

  const clearHighlights = useCallback(() => {
    if (supportsHighlightApi) {
      highlightRegistry!.delete(HL_ALL)
      highlightRegistry!.delete(HL_CURRENT)
    }
    rangesRef.current = []
    setCount(0)
    setCurrent(0)
    activeRef.current = 0
  }, [])

  const scrollToActive = useCallback(() => {
    const r = rangesRef.current[activeRef.current]
    r?.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" })
  }, [])

  const paint = useCallback(() => {
    if (!supportsHighlightApi) return
    const ranges = rangesRef.current
    if (ranges.length === 0) {
      highlightRegistry!.delete(HL_ALL)
      highlightRegistry!.delete(HL_CURRENT)
      return
    }
    highlightRegistry!.set(HL_ALL, new HighlightImpl!(...ranges))
    const active = ranges[activeRef.current]
    if (active) {
      const cur = new HighlightImpl!(active)
      cur.priority = 1 // render the active match on top of the dimmer "all" layer
      highlightRegistry!.set(HL_CURRENT, cur)
    }
  }, [])

  const runSearch = useCallback(
    (q: string) => {
      const container = containerRef.current
      if (!container || !q) {
        clearHighlights()
        return
      }
      const ranges = collectMatchRanges(container, q)
      rangesRef.current = ranges
      activeRef.current = ranges.length ? Math.min(activeRef.current, ranges.length - 1) : 0
      setCount(ranges.length)
      setCurrent(ranges.length ? activeRef.current + 1 : 0)
      paint()
      if (ranges.length) scrollToActive()
    },
    [containerRef, clearHighlights, paint, scrollToActive],
  )

  const go = useCallback(
    (dir: 1 | -1) => {
      const n = rangesRef.current.length
      if (!n) return
      activeRef.current = (activeRef.current + dir + n) % n
      setCurrent(activeRef.current + 1)
      paint()
      scrollToActive()
    },
    [paint, scrollToActive],
  )

  const close = useCallback(() => {
    setOpen(false)
    clearHighlights()
  }, [clearHighlights])

  // Cmd/Ctrl+F opens the bar (or refocuses it if already open). Capture
  // phase so we beat the editor/webview's own find before it swallows the
  // keystroke. Only active while mounted — and this component is only
  // mounted when a page is open — so Cmd+F is a no-op with no page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (isMeta && (e.key === "f" || e.key === "F") && !e.altKey) {
        if (!containerRef.current) return
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [containerRef])

  // Re-run when the query changes, the bar opens, or the page changes.
  useEffect(() => {
    if (!open) return
    runSearch(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, resetKey, runSearch])

  // Keep matches fresh as the viewer's DOM changes (read/edit toggle, live
  // typing, async image loads). Debounced to one rAF per burst.
  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => runSearch(query))
    })
    obs.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      obs.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [open, query, containerRef, runSearch])

  // Drop highlights if the component unmounts (e.g. the page is closed).
  useEffect(() => () => clearHighlights(), [clearHighlights])

  if (!open) return null

  const hasQuery = query.length > 0
  return (
    <div className="absolute right-3 top-2 z-30 flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-1 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Search className="ml-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            close()
            return
          }
          if (isImeComposing(e)) return
          if (e.key === "Enter") {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder={t("find.placeholder", { defaultValue: "Find in page" })}
        aria-label={t("find.placeholder", { defaultValue: "Find in page" })}
        className="w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <span
        className={`w-10 shrink-0 select-none text-right text-xs tabular-nums ${
          hasQuery && count === 0 ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {hasQuery ? `${current}/${count}` : ""}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => go(-1)}
        disabled={count === 0}
        title={t("find.previous", { defaultValue: "Previous match" })}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => go(1)}
        disabled={count === 0}
        title={t("find.next", { defaultValue: "Next match" })}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={close}
        title={t("find.close", { defaultValue: "Close (Esc)" })}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
