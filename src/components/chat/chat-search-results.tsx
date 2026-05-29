import { useState, useMemo, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Search, X, Plus, ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { WebSearchResult } from "@/lib/web-search"

interface ChatSearchResultsProps {
  query: string
  /** null = still loading, [] = no results, otherwise the results to render */
  results: WebSearchResult[] | null
  error: string | null
  /** Called with the URLs the user wants to stage as URL chips. */
  onConfirm: (selectedUrls: string[]) => void
  onDismiss: () => void
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function ChatSearchResults({
  query,
  results,
  error,
  onConfirm,
  onDismiss,
}: ChatSearchResultsProps) {
  const { t } = useTranslation()

  // Per the design: default all results checked. The user's "minimal
  // keypress" path is "search → click Add" → everything goes in.
  // Dedupe on URL (Tavily/SerpApi occasionally return the same URL
  // twice with different snippets — checking it twice would double-
  // stage the same chip).
  const dedupedResults = useMemo(() => {
    if (!results) return null
    const seen = new Set<string>()
    return results.filter((r) => {
      if (seen.has(r.url)) return false
      seen.add(r.url)
      return true
    })
  }, [results])

  const [selected, setSelected] = useState<Set<string>>(new Set())

  const allUrls = useMemo(
    () => (dedupedResults ? dedupedResults.map((r) => r.url) : []),
    [dedupedResults],
  )

  // When results transition from null (loading) → populated, default
  // every row to checked — the user's "minimal keypress" path is
  // "search → click Add" → everything goes in. Re-runs only when the
  // identity of `allUrls` changes (memoized), so toggling a row
  // doesn't reset the user's selection.
  useEffect(() => {
    setSelected(new Set(allUrls))
  }, [allUrls])

  const selectedCount = selected.size

  const toggle = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  const toggleAll = () => {
    setSelected((prev) => {
      if (prev.size === allUrls.length) return new Set()
      return new Set(allUrls)
    })
  }

  const handleConfirm = () => {
    const urls = allUrls.filter((u) => selected.has(u))
    if (urls.length === 0) return
    onConfirm(urls)
  }

  return (
    <div className="border-b bg-muted/30">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            {t("chatSearch.headerPrefix", { defaultValue: "Search:" })}
          </span>
          <span className="truncate font-medium" title={query}>
            {query}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          title={t("chatSearch.dismiss", { defaultValue: "Dismiss" })}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Loading state */}
      {dedupedResults === null && !error && (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("chatSearch.loading", { defaultValue: "Searching the web..." })}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="px-3 py-3 text-xs text-destructive">{error}</div>
      )}

      {/* Empty results */}
      {dedupedResults !== null && dedupedResults.length === 0 && !error && (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          {t("chatSearch.noResults", { defaultValue: "No results." })}
        </div>
      )}

      {/* Results list */}
      {dedupedResults !== null && dedupedResults.length > 0 && (
        <>
          <div className="max-h-[280px] overflow-y-auto">
            <ul className="divide-y">
              {dedupedResults.map((r) => {
                const checked = selected.has(r.url)
                return (
                  <li key={r.url} className="px-3 py-2">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(r.url)}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="truncate text-sm font-medium" title={r.title}>
                            {r.title || hostnameOf(r.url)}
                          </span>
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            title={r.url}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground" title={r.url}>
                          {hostnameOf(r.url)}
                        </div>
                        {r.snippet && (
                          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {r.snippet}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {selectedCount === allUrls.length
                ? t("chatSearch.deselectAll", { defaultValue: "Deselect all" })
                : t("chatSearch.selectAll", { defaultValue: "Select all" })}
            </button>
            <Button size="sm" onClick={handleConfirm} disabled={selectedCount === 0}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("chatSearch.addSelected", {
                defaultValue: "Add {{count}} to raw",
                count: selectedCount,
              })}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
