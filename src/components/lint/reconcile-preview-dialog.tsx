/**
 * Preview-before-apply UI for the mechanical reconcile pass.
 *
 * Replaces the old `window.confirm()` of pure totals — that dialog
 * showed "12 broken wikilinks · 3 missing index entries" but never
 * the actual changes. Users had to apply blind and trust the count.
 *
 * The new preview shows per-file unified-style diffs so the user can
 * see what's about to change line-by-line before clicking Apply.
 */
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, ChevronDown, ChevronRight } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { diffLines, type DiffLine } from "@/lib/text-diff"

export interface PreviewChange {
  slug: string
  brokenWikilinksReplaced: number
  relatedEntriesRemoved: number
  indexRowsDropped: number
  indexRowsAdded: number
  diffPreview?: { before: string; after: string }
}

export interface ReconcilePreviewDialogProps {
  open: boolean
  changes: PreviewChange[]
  totals: {
    files: number
    brokenLinks: number
    relatedDropped: number
    indexDropped: number
    indexAdded: number
  }
  onApply: () => void
  onCancel: () => void
}

export function ReconcilePreviewDialog({
  open,
  changes,
  totals,
  onApply,
  onCancel,
}: ReconcilePreviewDialogProps) {
  const { t } = useTranslation()
  // Expand all by default when there are few changes; collapse when
  // many — the user wanting to skim a big run shouldn't have to
  // scroll past N expanded diffs. Threshold matches lint-view's
  // auto-fold heuristic for consistency.
  const initialExpanded = useMemo<Record<string, boolean>>(() => {
    if (changes.length <= 3) {
      return Object.fromEntries(changes.map((c) => [c.slug, true]))
    }
    return {}
  }, [changes])
  const [expanded, setExpanded] = useState(initialExpanded)

  function toggle(slug: string) {
    setExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-h-[80vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("lint.reconcilePreviewTitle", {
              defaultValue: "Preview cleanup changes",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("lint.reconcilePreviewSummary", {
              defaultValue:
                `${totals.files} file(s) will be rewritten · ` +
                `${totals.brokenLinks} broken [[X]] → plain text · ` +
                `${totals.relatedDropped} dangling related: entries removed · ` +
                `${totals.indexDropped} index rows dropped · ` +
                `${totals.indexAdded} missing index entries added`,
              ...totals,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[55vh] overflow-y-auto px-2">
          {changes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("lint.reconcileNoChanges", {
                defaultValue: "No changes to apply.",
              })}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {changes.map((c) => (
                <li key={c.slug} className="rounded-md border">
                  <button
                    type="button"
                    onClick={() => toggle(c.slug)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
                  >
                    {expanded[c.slug] ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate font-mono text-xs">{c.slug}</span>
                    <ChangeBadges c={c} />
                  </button>
                  {expanded[c.slug] && c.diffPreview && (
                    <DiffPane before={c.diffPreview.before} after={c.diffPreview.after} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("lint.reconcileCancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={onApply} disabled={changes.length === 0}>
            {t("lint.reconcileApply", {
              defaultValue: "Apply changes",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangeBadges({ c }: { c: PreviewChange }) {
  const badges: Array<{ label: string; key: string }> = []
  if (c.brokenWikilinksReplaced > 0) badges.push({ label: `🔗 ${c.brokenWikilinksReplaced}`, key: "links" })
  if (c.relatedEntriesRemoved > 0) badges.push({ label: `🧹 ${c.relatedEntriesRemoved}`, key: "related" })
  if (c.indexRowsDropped > 0) badges.push({ label: `−${c.indexRowsDropped}`, key: "dropped" })
  if (c.indexRowsAdded > 0) badges.push({ label: `+${c.indexRowsAdded}`, key: "added" })
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
      {badges.map((b) => (
        <span key={b.key} className="rounded-full bg-muted px-1.5 py-0.5">
          {b.label}
        </span>
      ))}
    </span>
  )
}

/**
 * Unified-diff style render. Each line carries a `+` / `-` / ` `
 * marker and is colour-coded. Long files stay in this scroll area —
 * not the outer one — so the user can scroll the diff without
 * losing the file header above.
 */
function DiffPane({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after])
  // Diffs of identical text shouldn't render an empty pane — show a
  // hint instead so the user knows nothing meaningful changed (this
  // shouldn't happen since reconcile filters unchanged files, but
  // belt-and-braces).
  if (!lines.some((l) => l.type !== "ctx")) {
    return (
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        No textual changes.
      </p>
    )
  }
  return (
    <div className="max-h-64 overflow-y-auto border-t bg-muted/30 font-mono text-[11px]">
      {lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </div>
  )
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bg =
    line.type === "add"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : line.type === "del"
        ? "bg-red-500/10 text-red-700 dark:text-red-300"
        : "text-muted-foreground"
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " "
  return (
    <div className={`flex items-start gap-2 whitespace-pre-wrap px-3 ${bg}`}>
      <span className="select-none opacity-60">{marker}</span>
      <span className="flex-1 break-all">{line.text}</span>
    </div>
  )
}
