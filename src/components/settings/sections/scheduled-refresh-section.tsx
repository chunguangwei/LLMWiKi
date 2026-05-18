import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { RefreshCw, Play, Loader2 } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  scanProject,
  startScheduledRefresh,
  stopScheduledRefresh,
  type ScheduledRefreshConfig,
} from "@/lib/scheduled-refresh"

/**
 * Settings section for the page-level web refresh scheduler.
 * Persists the on/off + scan interval to localStorage (UI-only, no
 * project metadata bloat) so a user choice carries across launches.
 */
const STORAGE_KEY = "scheduledRefreshConfig"
const DEFAULT_CONFIG: ScheduledRefreshConfig = {
  enabled: false,
  scanIntervalMin: 30,
}

function loadCfg(): ScheduledRefreshConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw) as Partial<ScheduledRefreshConfig>
    return {
      enabled: !!parsed.enabled,
      scanIntervalMin: Math.max(
        1,
        Math.min(1440, Number(parsed.scanIntervalMin) || DEFAULT_CONFIG.scanIntervalMin),
      ),
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

function saveCfg(cfg: ScheduledRefreshConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* ignore */
  }
}

export function ScheduledRefreshSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const searchProvider = useWikiStore((s) => s.searchApiConfig.provider)

  const [cfg, setCfg] = useState<ScheduledRefreshConfig>(() => loadCfg())
  const [running, setRunning] = useState(false)
  const [lastStatus, setLastStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!project) return
    if (cfg.enabled) startScheduledRefresh(project, cfg)
    else stopScheduledRefresh()
    saveCfg(cfg)
  }, [project, cfg])

  const handleRunNow = useCallback(async () => {
    if (!project || running) return
    setRunning(true)
    setLastStatus(null)
    try {
      const result = await scanProject(project)
      setLastStatus(
        t("settings.sections.scheduledRefresh.runResult", {
          defaultValue:
            "Refreshed {{ran}} pages, skipped {{skipped}} (not due yet), {{errored}} errors.",
          ran: result.ran,
          skipped: result.skipped,
          errored: result.errored,
        }),
      )
    } catch (err) {
      setLastStatus(String(err))
    } finally {
      setRunning(false)
    }
  }, [project, running, t])

  const searchConfigured = searchProvider !== "none"

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.scheduledRefresh.title", {
            defaultValue: "Scheduled Web Refresh",
          })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.scheduledRefresh.description", {
            defaultValue:
              "Periodically asks the LLM whether wiki pages flagged with `refresh-enabled: true` in their frontmatter are stale. Stale pages produce a suggestion in the Review queue.",
          })}
        </p>
      </div>

      {!searchConfigured && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t("settings.sections.scheduledRefresh.needSearch", {
            defaultValue:
              "Configure a web search provider under Settings → Web Search first.",
          })}
        </div>
      )}

      <div className="space-y-3 rounded-lg border p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            disabled={!project || !searchConfigured}
          />
          {t("settings.sections.scheduledRefresh.enable", {
            defaultValue: "Enable background scheduler",
          })}
        </label>

        <div className="space-y-1">
          <Label htmlFor="scanInterval">
            {t("settings.sections.scheduledRefresh.scanInterval", {
              defaultValue: "Check interval (minutes)",
            })}
          </Label>
          <Input
            id="scanInterval"
            type="number"
            min={1}
            max={1440}
            value={cfg.scanIntervalMin}
            onChange={(e) =>
              setCfg({
                ...cfg,
                scanIntervalMin: Math.max(1, Math.min(1440, Number(e.target.value) || 30)),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.scheduledRefresh.scanIntervalHint", {
              defaultValue:
                "How often to scan the wiki for due pages. Per-page interval is set in each page's frontmatter via `refresh-interval-days`.",
            })}
          </p>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.scheduledRefresh.runNowHeader", {
              defaultValue: "Run now",
            })}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledRefresh.runNowHint", {
            defaultValue:
              "Bypasses the scheduler and immediately refreshes every page that is currently due.",
          })}
        </p>
        <Button onClick={handleRunNow} disabled={!project || !searchConfigured || running}>
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.scheduledRefresh.running", { defaultValue: "Scanning…" })}
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t("settings.sections.scheduledRefresh.runNow", { defaultValue: "Refresh due pages" })}
            </>
          )}
        </Button>
        {lastStatus && (
          <div className="rounded bg-muted/40 p-2 text-xs">{lastStatus}</div>
        )}
      </div>

      <div className="rounded-lg border p-4 text-xs text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">
          {t("settings.sections.scheduledRefresh.frontmatterHowTo", {
            defaultValue: "How to mark a page for refresh",
          })}
        </p>
        <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-xs">
{`---
type: concept
title: Mixture-of-Experts
refresh-enabled: true
refresh-interval-days: 7
refresh-queries:
  - "mixture of experts 2026"
  - "MoE benchmarks recent"
---`}
        </pre>
      </div>
    </div>
  )
}
