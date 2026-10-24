import { AlertCircle, Check, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { MarkdownSaveStatus } from "@/hooks/use-markdown-auto-save"

export function MarkdownSaveStatusIndicator({
  status,
  error,
  onRetry,
}: {
  status: MarkdownSaveStatus
  error: string | null
  onRetry: () => void
}) {
  const { t } = useTranslation()
  if (status === "idle") return null
  if (status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={error ?? t("preview.saveFailed", { defaultValue: "Save failed. Retry." })}
      >
        <AlertCircle className="h-3.5 w-3.5" />
        {t("preview.saveFailed", { defaultValue: "Save failed. Retry." })}
      </button>
    )
  }

  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
    >
      {status === "saving" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === "saved" && <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
      {status === "dirty" && t("preview.unsaved", { defaultValue: "Unsaved" })}
      {status === "saving" && t("preview.saving", { defaultValue: "Saving..." })}
      {status === "saved" && t("preview.saved", { defaultValue: "Saved" })}
    </span>
  )
}
