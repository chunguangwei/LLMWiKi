import { useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { runPageRefresh, readRefreshConfig } from "@/lib/refresh-runner"
import type { FrontmatterValue } from "@/lib/frontmatter"

/**
 * In-editor sidebar widget. Reads the page's `refresh-*` frontmatter
 * fields and offers a one-click "refresh now" button. Hidden when
 * the page has no refresh config — keeps the editor clean.
 */
export function RefreshControls({
  frontmatter,
}: {
  frontmatter: Record<string, FrontmatterValue>
}) {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [running, setRunning] = useState(false)
  const [lastMsg, setLastMsg] = useState<string | null>(null)

  const cfg = readRefreshConfig(frontmatter as Record<string, unknown>)
  if (!cfg.enabled) return null

  const lastInfo = cfg.lastRefreshed
    ? `${cfg.lastResult ?? "-"} · ${new Date(cfg.lastRefreshed).toLocaleString()}`
    : t("editor.refresh.never", { defaultValue: "Never refreshed" })

  const handleClick = async () => {
    if (!selectedFile || running) return
    setRunning(true)
    setLastMsg(null)
    try {
      const result = await runPageRefresh(selectedFile)
      setLastMsg(
        t(`editor.refresh.result.${result}`, {
          defaultValue: result,
        }),
      )
    } catch (err) {
      setLastMsg(String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-col">
        <span className="font-medium text-foreground">
          {t("editor.refresh.title", { defaultValue: "Web refresh" })} ·
          {" "}
          {t("editor.refresh.intervalLabel", {
            defaultValue: "every {{n}}d",
            n: cfg.intervalDays,
          })}
        </span>
        <span className="text-muted-foreground">{lastMsg ?? lastInfo}</span>
      </div>
      <Button size="sm" variant="outline" onClick={handleClick} disabled={running}>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}
