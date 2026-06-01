import { useState } from "react"
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
import { useIngestPreviewStore } from "@/stores/ingest-preview-store"

/**
 * Dialog rendered at app-root that watches the ingest-preview store.
 * When autoIngest pushes a pending preview, this surfaces it: file
 * list with per-row content preview the user can expand. Apply
 * commits the pending writes; Cancel skips them — autoIngest already
 * spent the LLM tokens, the cancel just avoids disk side-effects.
 */
export function IngestPreviewDialog() {
  const pending = useIngestPreviewStore((s) => s.pending)
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!pending) return null

  function apply() {
    pending!.resolve(true)
  }
  function cancel() {
    pending!.resolve(false)
  }
  function toggle(path: string) {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent className="max-h-[80vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("ingestPreview.title", { defaultValue: "Preview autoIngest plan" })}
          </DialogTitle>
          <DialogDescription>
            {t("ingestPreview.description", {
              defaultValue:
                `LLM generated ${pending.blocks.length} file(s) from "${pending.title}". Review before they land on disk.`,
              count: pending.blocks.length,
              source: pending.title,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[55vh] overflow-y-auto px-2">
          {pending.blocks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("ingestPreview.empty", {
                defaultValue: "LLM produced no files. Nothing to apply.",
              })}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.blocks.map((b) => (
                <li key={b.path} className="rounded-md border">
                  <button
                    type="button"
                    onClick={() => toggle(b.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
                  >
                    {expanded[b.path] ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate font-mono text-xs">{b.path}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {b.contentLength.toLocaleString()} chars
                    </span>
                  </button>
                  {expanded[b.path] && (
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {b.contentPreview}
                      {b.contentLength > b.contentPreview.length && (
                        <span className="text-muted-foreground/60">
                          {"\n…("}
                          {(b.contentLength - b.contentPreview.length).toLocaleString()}
                          {" more chars)"}
                        </span>
                      )}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            {t("ingestPreview.cancel", { defaultValue: "Cancel — don't write" })}
          </Button>
          <Button onClick={apply} disabled={pending.blocks.length === 0}>
            {t("ingestPreview.apply", { defaultValue: "Apply" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
