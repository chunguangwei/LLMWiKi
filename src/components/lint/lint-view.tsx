import { useState, useCallback, useMemo, useRef } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { runStructuralLintWithStats, runSemanticLint, type LintStats } from "@/lib/lint"
import { runLintFix } from "@/lib/agent-lint-fix"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useActivityStore } from "@/stores/activity-store"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  warnings: LintItem[]
  infos: LintItem[]
} {
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  return { warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
  }), [t])

  const items = useLintStore((s) => s.items)
  const addLintItems = useLintStore((s) => s.addItems)
  const clearLintItems = useLintStore((s) => s.clearItems)

  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  // Lint-pass stats — populated by the most recent Run check; used
  // by the header to surface "skipped N raw-source items" so the
  // user sees the dedup-vs-filter signal explicitly. Null when no
  // pass has run yet OR when the previous pass errored.
  const [lintStats, setLintStats] = useState<LintStats | null>(null)
  // Bulk fix mode — when set, runs runLintFix in sequence over every
  // matching lint item. Holds the item id currently being processed
  // so the row can show the same spinner the per-row Fix uses. Null
  // when no bulk run is active.
  const [bulkRunning, setBulkRunning] = useState(false)
  const bulkAbortRef = useRef<{ aborted: boolean } | null>(null)

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    clearLintItems()
    try {
      const { findings: structural, stats } = await runStructuralLintWithStats(pp)
      setLintStats(stats)
      let all = structural

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig)
        all = [...structural, ...semantic]
      }

      addLintItems(all)
      setHasRun(true)
    } catch (err) {
      console.error("Lint failed:", err)
    } finally {
      setRunning(false)
    }
  }, [project, llmConfig, running, runSemantic, addLintItems, clearLintItems])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    setActiveView("wiki")
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        return
      } catch {
        // try next
      }
    }
    setSelectedFile(candidates[0])
    setFileContent(`Unable to load: ${page}`)
  }

  async function handleFix(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)

    // AI lint-fix path. Gated on the Labs flag + a usable LLM config —
    // missing config silently falls through to the classic per-type
    // handler below so the button stays useful in offline mode. We
    // also fall through on any runLintFix error so a flaky model
    // doesn't strand the user with a broken Fix button.
    const aiEnabled = useWikiStore.getState().experimentalAiLintFix
    if (aiEnabled && hasUsableLlm(llmConfig) && item.type !== "semantic") {
      const activity = useActivityStore.getState()
      const activityId = activity.addItem({
        type: "lint",
        title: `🤖 AI fix: ${item.page} (${item.type})`,
        status: "running",
        detail: item.detail,
        filesWritten: [],
      })
      try {
        const result = await runLintFix({
          item,
          project,
          llmConfig,
          onTurn: (turn, tokens) =>
            activity.updateItem(activityId, {
              detail: `Turn ${turn + 1} · ${Math.round(tokens / 1000)}k tokens`,
            }),
        })
        const lines = [
          result.reason,
          `Turns: ${result.turnsUsed} · tokens: ${Math.round(result.tokensSpent / 1000)}k`,
          result.pagesUpdated.length > 0
            ? `Updated: ${result.pagesUpdated.map((p) => p.slug).join(", ")}`
            : "",
          result.pagesCreated.length > 0
            ? `Created: ${result.pagesCreated.map((p) => p.slug).join(", ")}`
            : "",
          result.pagesDeleted.length > 0
            ? `Deleted: ${result.pagesDeleted.map((p) => `${p.slug} (${p.reason})`).join(", ")}`
            : "",
          result.gapsSurfaced.length > 0
            ? `Surfaced gaps: ${result.gapsSurfaced.length} (see Review)`
            : "",
        ].filter(Boolean)
        activity.updateItem(activityId, {
          status: "done",
          detail: lines.join("\n"),
          filesWritten: [
            ...result.pagesUpdated.map((p) => p.slug),
            ...result.pagesCreated.map((p) => p.slug),
          ],
        })
        // Push gaps to Review so the user can decide on each. Each gap
        // gets both "Open page" (so the user can act on it manually
        // — the agent's surface_gap is a "needs human attention"
        // signal, not a dead end) and "Skip" (dismiss). The page
        // path is the original lint item's page since that's the
        // thing the agent was investigating; if the gap is about a
        // related page, the user can still open it from the file
        // tree.
        for (const g of result.gapsSurfaced) {
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: g.topic,
            description: g.reason ?? "",
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("review.skip", { defaultValue: "Skip" }), action: "Skip" },
            ],
          })
        }
        useLintStore.getState().removeItem(item.id)
        // Refresh tree + bump data version.
        const tree = await listDirectory(pp)
        setFileTree(tree)
        bumpDataVersion()
        // Release the per-item "fixing" lock before the early return.
        // The outer `finally { setFixingId(null) }` below ONLY fires
        // when we fall through to the classic handler; bailing here
        // without resetting would leave the button stuck disabled
        // after a successful AI fix until the next render reseeds the
        // state. Discovered during self-review.
        setFixingId(null)
        return
      } catch (err) {
        activity.updateItem(activityId, {
          status: "error",
          detail: `AI fix failed (falling back to classic): ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
        // Fall through to the classic handler below.
      }
    }

    try {
      switch (item.type) {
        case "orphan": {
          // Add a link to this page from index.md
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

          const pageName = item.page.replace(".md", "").replace(/^.*\//, "")
          const entry = `- [[${pageName}]]`
          if (!indexContent.includes(entry)) {
            indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
            await writeFile(indexPath, indexContent)
          }
          // Remove from store
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          // Option: remove the broken link from the page, or send to Review for manual fix
          const pagePath = `${pp}/wiki/${item.page}`
          useReviewStore.getState().addItem({
            type: "confirm",
            title: t("lint.fixBrokenLink", { page: item.page }),
            description: item.detail,
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.deletePage"), action: `delete:${pagePath}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          // Send to Review — user should add links manually
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: t("lint.addCrossRefs", { page: item.page }),
            description: t("lint.addCrossRefsDescription"),
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          useReviewStore.getState().addItem({
            type: "confirm",
            title: item.detail.slice(0, 80),
            description: item.detail,
            affectedPages: item.affectedPages ?? [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }
      }

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Fix failed:", err)
    } finally {
      setFixingId(null)
    }
  }

  /**
   * Bulk-fix runner. Iterates the current broken-link items in
   * sequence and calls runLintFix on each. Sequential (not parallel)
   * so concurrent agent runs don't race on the same wiki pages or
   * burn N× the LLM budget at once. Aborts on stop or LLM-config
   * loss; surfaces aggregate progress in one activity item.
   */
  async function handleBulkFixBroken() {
    if (!project) return
    if (!hasUsableLlm(llmConfig)) return
    if (bulkRunning) return
    const broken = items.filter((i) => i.type === "broken-link")
    if (broken.length === 0) return
    const confirmed = window.confirm(
      t("lint.bulkFixConfirm", {
        defaultValue: `Run AI fix on all ${broken.length} broken-link items? Each will dispatch a separate agent run; you can Stop mid-batch.`,
        count: broken.length,
      }),
    )
    if (!confirmed) return

    const activity = useActivityStore.getState()
    const activityId = activity.addItem({
      type: "lint",
      title: `🤖 Bulk AI fix: ${broken.length} broken-link items`,
      status: "running",
      detail: `0 / ${broken.length}`,
      filesWritten: [],
    })

    bulkAbortRef.current = { aborted: false }
    setBulkRunning(true)
    const writtenAll: string[] = []
    let done = 0
    let succeeded = 0
    let failed = 0
    try {
      for (const item of broken) {
        if (bulkAbortRef.current?.aborted) break
        setFixingId(item.id)
        try {
          const result = await runLintFix({
            item,
            project,
            llmConfig,
          })
          for (const p of result.pagesUpdated) writtenAll.push(p.slug)
          for (const p of result.pagesCreated) writtenAll.push(p.slug)
          for (const g of result.gapsSurfaced) {
            useReviewStore.getState().addItem({
              type: "suggestion",
              title: g.topic,
              description: g.reason ?? "",
              affectedPages: [item.page],
              options: [
                { label: t("lint.openEdit"), action: `open:${item.page}` },
                { label: t("review.skip", { defaultValue: "Skip" }), action: "Skip" },
              ],
            })
          }
          useLintStore.getState().removeItem(item.id)
          succeeded += 1
        } catch (err) {
          failed += 1
          console.error("[bulk-fix] item failed", item.id, err)
        }
        done += 1
        activity.updateItem(activityId, {
          detail: `${done} / ${broken.length} (${succeeded} ok · ${failed} failed)`,
        })
      }
      activity.updateItem(activityId, {
        status: "done",
        detail:
          `Done. ${succeeded}/${broken.length} succeeded, ${failed} failed` +
          (bulkAbortRef.current?.aborted ? " (stopped)" : ""),
        filesWritten: writtenAll,
      })
      const pp = normalizePath(project.path)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setFixingId(null)
      setBulkRunning(false)
      bulkAbortRef.current = null
    }
  }

  function stopBulkFix() {
    if (bulkAbortRef.current) bulkAbortRef.current.aborted = true
  }

  async function handleDeleteOrphan(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${item.page}`
    const confirmed = window.confirm(t("lint.deleteOrphanConfirm", { page: item.page }))
    if (!confirmed) return

    try {
      // Full cascade: file + embedding chunks + every reference to
      // the page across the wiki (body wikilinks, index.md listing,
      // `related:` frontmatter arrays). Even though "orphan" by lint
      // means no incoming wikilinks were detected, `related:` slugs
      // and index.md entries can still point at it — the orphan
      // detector only walks body refs.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
      useLintStore.getState().removeItem(item.id)
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const { warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(items),
    [items],
  )
  const showResults = shouldShowLintResults(hasRun, items.length)

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("lint.title")}</h2>
          {showResults && items.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {items.length === 1 ? t("lint.issues", { count: items.length }) : t("lint.issues_plural", { count: items.length })}
            </span>
          )}
          {/* Skipped-pages hint. Surfaces "skipped N items in sources/"
              so the user can see that lint filtered noise rather than
              missed pages — and so the dropped count after enabling
              the dedup PR is auditable, not magical. */}
          {showResults && lintStats && lintStats.skipped > 0 && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              title={Array.from(lintStats.skippedByPathPrefix.entries())
                .map(([prefix, n]) => `${prefix} ${n}`)
                .join("  ·  ")}
            >
              {t("lint.skipped", {
                defaultValue: `skipped ${lintStats.skipped}`,
                count: lintStats.skipped,
              })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => setRunSemantic(e.target.checked)}
            />
            {t("lint.semantic")}
          </label>
          <Button
            size="sm"
            onClick={handleRunLint}
            disabled={running || !project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? t("lint.running") : t("lint.runLint")}
          </Button>
          {/* Bulk-fix button. Shown only when the AI lint-fix Labs flag
              is on, an LLM is configured, and at least one broken-link
              row exists. Sequential runs so concurrent agents don't
              clobber the same wiki pages — and so the user can Stop
              mid-batch from the same control. */}
          {useWikiStore.getState().experimentalAiLintFix &&
            hasUsableLlm(llmConfig) &&
            items.some((i) => i.type === "broken-link") && (
              <Button
                size="sm"
                variant={bulkRunning ? "destructive" : "outline"}
                onClick={bulkRunning ? stopBulkFix : handleBulkFixBroken}
                disabled={running || !project}
                title={t("lint.bulkFixBrokenTitle", {
                  defaultValue:
                    "Run AI fix on all broken-link items in sequence. Click again to stop.",
                })}
              >
                {bulkRunning
                  ? t("lint.bulkFixStop", { defaultValue: "Stop bulk fix" })
                  : t("lint.bulkFixBroken", {
                      defaultValue: `🤖 Fix all broken links (${
                        items.filter((i) => i.type === "broken-link").length
                      })`,
                      count: items.filter((i) => i.type === "broken-link").length,
                    })}
              </Button>
            )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!showResults ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("lint.runLintHint")}</p>
            <p className="text-xs">{t("lint.runLintDescription")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">{t("lint.allClear")}</p>
            <p className="text-xs">{t("lint.noIssues")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label={t("lint.warnings")} count={warnings.length} color="text-amber-500" t={t} />
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label={t("lint.info")} count={infos.length} color="text-blue-500" t={t} />
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  color,
  t,
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {t("lint.sectionCount", { label, count })}
    </div>
  )
}

function LintCard({
  item,
  fixing,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete?: (item: LintItem) => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = typeConfig[item.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            item.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{item.page}</span>
            {/* Quick-scan badge for dedup-grouped findings. The full
                source list shows below as clickable chips; this badge
                just makes the "N rows collapsed to 1" signal visible
                at a glance from the row header. */}
            {item.affectedPages && item.affectedPages.length > 1 && (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                × {item.affectedPages.length}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(item.page)}
        >
          {t("lint.open")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(item)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? t("lint.fixing") : t("lint.fix")}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="h-3 w-3" />
            {t("lint.delete")}
          </Button>
        )}
      </div>
    </div>
  )
}
