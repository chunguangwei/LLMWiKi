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
  ChevronDown,
  ChevronRight,
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
import { ReconcilePreviewDialog } from "./reconcile-preview-dialog"

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

/**
 * Group items by their type so the lint view can render one fold per
 * type ("Broken links · 12", "Orphans · 3", …). Within each fold the
 * existing per-item cards keep their full detail.
 *
 * Sorted by descending count then by canonical type order so the
 * largest pile floats to the top. Display order matches the toolbar:
 * broken-link → orphan → no-outlinks → semantic.
 */
const LINT_TYPE_ORDER: Record<LintItem["type"], number> = {
  "broken-link": 0,
  orphan: 1,
  "no-outlinks": 2,
  semantic: 3,
}

export function groupByType(items: readonly LintItem[]): Array<{
  type: LintItem["type"]
  items: LintItem[]
}> {
  const byType = new Map<LintItem["type"], LintItem[]>()
  for (const item of items) {
    const arr = byType.get(item.type) ?? []
    arr.push(item)
    byType.set(item.type, arr)
  }
  return Array.from(byType.entries())
    .map(([type, items]) => ({ type, items }))
    .sort((a, b) => {
      // Largest pile first.
      if (a.items.length !== b.items.length) return b.items.length - a.items.length
      return LINT_TYPE_ORDER[a.type] - LINT_TYPE_ORDER[b.type]
    })
}

/** Auto-fold threshold — keep groups with ≤ this many rows expanded
 *  by default. Larger piles start collapsed so the page isn't a wall
 *  of identical-looking cards. */
const AUTO_FOLD_THRESHOLD = 3

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

// Rate-limit detection + backoff are shared with agent-llm's postJson
// (which also retries 429s for free) — `@/lib/rate-limit` is the
// single source. Re-exported here so the existing lint-view tests
// keep working without import churn.
import {
  isRateLimitError as sharedIsRateLimitError,
  rateLimitBackoffMs as sharedRateLimitBackoffMs,
} from "@/lib/rate-limit"
export const isRateLimitError = sharedIsRateLimitError
export const rateLimitBackoffMs = sharedRateLimitBackoffMs

/** After ANY 429 in a bulk run, pace each subsequent item by this
 *  much so we don't keep tripping the same per-account ceiling. */
const THROTTLE_AFTER_429_MS = 2_000

/** Max retry attempts before giving up on an item and moving on. */
const MAX_BULK_RETRY_ATTEMPTS = 3

/**
 * Polls the bulk-run abort ref every 200ms while waiting `ms` total.
 * The shared rate-limit module's variant takes an AbortSignal; bulk-fix
 * uses a mutable ref instead so the Stop button can flip a flag without
 * threading a controller through. We could refactor to a controller
 * later, but keeping this local helper for now is the smallest diff
 * that gives Stop responsiveness during 429 backoff.
 */
async function sleepRespectingAbortRef(
  ms: number,
  abortRef: { aborted: boolean } | null,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (abortRef?.aborted) return
    await new Promise((r) => setTimeout(r, Math.min(200, ms - (Date.now() - start))))
  }
}

/**
 * Wrap runLintFix with rate-limit aware retries. On 429-shaped errors
 * we wait per `rateLimitBackoffMs` and try again up to N times. On
 * any other error we surface immediately — non-rate-limit failures
 * are usually deterministic (wrong slug, schema mismatch) and retry
 * just wastes tokens. `onBackoff` lets the caller surface progress.
 *
 * As of the postJson backoff layer, single-call 429s are usually
 * absorbed BELOW runLintFix — this wrapper is now a second line of
 * defense catching multi-call cascades and non-postJson rate-limit
 * shapes (tool-execution-side limits, classifier wrappers, etc).
 */
async function runLintFixWithBackoff(
  opts: Parameters<typeof runLintFix>[0],
  abortRef: { aborted: boolean } | null,
  onBackoff: (waitMs: number, attempt: number) => void,
): Promise<Awaited<ReturnType<typeof runLintFix>>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_BULK_RETRY_ATTEMPTS; attempt += 1) {
    if (abortRef?.aborted) throw new Error("aborted")
    try {
      return await runLintFix(opts)
    } catch (err) {
      lastErr = err
      if (!sharedIsRateLimitError(err)) throw err
      if (attempt >= MAX_BULK_RETRY_ATTEMPTS) break
      const waitMs = sharedRateLimitBackoffMs(attempt)
      onBackoff(waitMs, attempt)
      await sleepRespectingAbortRef(waitMs, abortRef)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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
  // Reconcile (mechanical cleanup) state. Runs a dry-run first to
  // collect counts, asks the user to confirm, then applies.
  const [reconciling, setReconciling] = useState(false)
  // Count of findings the last lint run filtered out as "already
  // attempted". Surfaced as a small pill in the toolbar so the user
  // knows nothing got silently lost — click to show / clear.
  const [suppressedCount, setSuppressedCount] = useState(0)
  // Reconcile preview state — null when the dialog is closed; when
  // set, the dialog renders with the dry-run results so the user
  // can review the actual diffs before clicking Apply.
  const [previewState, setPreviewState] = useState<{
    changes: import("./reconcile-preview-dialog").PreviewChange[]
    totals: {
      files: number
      brokenLinks: number
      relatedDropped: number
      indexDropped: number
      indexAdded: number
    }
  } | null>(null)
  // Per-type fold state. Maps "warning:broken-link" / "info:orphan"
  // to "expanded?". A missing key falls back to the auto-fold rule
  // (expanded when count ≤ AUTO_FOLD_THRESHOLD). User clicks the
  // type header chevron to toggle and override the auto rule.
  const [foldOverrides, setFoldOverrides] = useState<Record<string, boolean>>({})

  function toggleFold(key: string, currentlyOpen: boolean) {
    setFoldOverrides((prev) => ({ ...prev, [key]: !currentlyOpen }))
  }

  function isFoldOpen(key: string, count: number): boolean {
    const override = foldOverrides[key]
    if (override !== undefined) return override
    return count <= AUTO_FOLD_THRESHOLD
  }

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

      // Filter against already-attempted findings — items the user
      // (or bulk-fix) tried before don't get re-surfaced unless they
      // click "Show suppressed" or clear suppressions. See
      // `lib/lint-suppressions.ts` for the rationale.
      const { loadSuppressions, partitionBySuppression } = await import(
        "@/lib/lint-suppressions"
      )
      const suppressions = await loadSuppressions(pp)
      const { visible, hidden } = partitionBySuppression(all, suppressions)
      addLintItems(visible)
      setSuppressedCount(hidden.length)
      setHasRun(true)
    } catch (err) {
      console.error("Lint failed:", err)
    } finally {
      setRunning(false)
    }
  }, [project, llmConfig, running, runSemantic, addLintItems, clearLintItems])

  /**
   * Clear all suppressions for the project and re-run lint so the
   * previously-hidden items reappear. Confirms first because this
   * un-hides EVERY finding the user has dismissed across all past
   * fix attempts — not a per-row action.
   */
  async function handleShowSuppressed() {
    if (!project || running) return
    const pp = normalizePath(project.path)
    const confirmed = window.confirm(
      t("lint.suppressedConfirm", {
        defaultValue:
          `Clear ${suppressedCount} already-attempted suppressions and re-run lint? ` +
          `Previously hidden findings will appear in the list again.`,
        count: suppressedCount,
      }),
    )
    if (!confirmed) return
    try {
      const { clearSuppressions } = await import("@/lib/lint-suppressions")
      await clearSuppressions(pp)
      setSuppressedCount(0)
      // Re-run lint so the unhidden items show up immediately. The
      // store will be replaced by the fresh findings — no manual
      // clear needed.
      handleRunLint()
    } catch (err) {
      console.error("[lint] failed to clear suppressions:", err)
    }
  }

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
        // Record the fix attempt — even if the underlying problem
        // wasn't actually resolved (the agent reported success but
        // the broken-link target STILL doesn't exist), suppressing
        // this finding from future lint runs is the right call. The
        // user said "已修过的就别再来烦了"; the only way out is
        // explicit "show suppressed" / "clear suppressions".
        try {
          const { recordAttempt } = await import("@/lib/lint-suppressions")
          await recordAttempt(pp, item)
        } catch (e) {
          console.warn("[lint] failed to record fix attempt:", e)
        }
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
        // Even on AI failure, record the attempt — the user clicked
        // Fix, the system tried, and re-surfacing the same finding
        // on the next lint creates the exact loop we're trying to
        // break. They can manually un-suppress later if they want
        // to retry.
        try {
          const { recordAttempt } = await import("@/lib/lint-suppressions")
          await recordAttempt(pp, item)
        } catch (e) {
          console.warn("[lint] failed to record fix attempt:", e)
        }
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

      // Classic fix path completed — record so the finding is
      // suppressed on the next lint run. Same intent as the AI path
      // above: the user took action; don't re-surface unless they
      // ask.
      try {
        const { recordAttempt } = await import("@/lib/lint-suppressions")
        await recordAttempt(pp, item)
      } catch (e) {
        console.warn("[lint] failed to record fix attempt:", e)
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
    // Items the agent attempted (success OR failure). Recorded as
    // suppressions when the run finishes so the next lint pass
    // doesn't re-surface the same set. The user's intent on Bulk
    // Fix is "try them all and don't bug me about the ones that
    // can't be auto-resolved" — anything else creates the
    // fix→fail→re-show→fix loop they complained about.
    const attempted: LintItem[] = []
    let done = 0
    let succeeded = 0
    let failed = 0
    let rateLimitHits = 0
    // After the first 429 in this run, throttle each subsequent item
    // by THROTTLE_AFTER_429_MS so we don't immediately re-trip the
    // provider's per-account rate limit. The first hit is usually
    // surprising; sustained polite pacing prevents a second wall.
    let throttled = false
    try {
      for (const item of broken) {
        if (bulkAbortRef.current?.aborted) break
        if (throttled) await sleepRespectingAbortRef(THROTTLE_AFTER_429_MS, bulkAbortRef.current)
        if (bulkAbortRef.current?.aborted) break
        setFixingId(item.id)
        try {
          const result = await runLintFixWithBackoff(
            { item, project, llmConfig },
            bulkAbortRef.current,
            (waitMs, attempt) => {
              throttled = true
              rateLimitHits += 1
              activity.updateItem(activityId, {
                detail:
                  `${done} / ${broken.length} (${succeeded} ok · ${failed} failed) · ` +
                  `⏳ rate-limited, retrying in ${Math.round(waitMs / 1000)}s ` +
                  `(attempt ${attempt})`,
              })
            },
          )
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
          attempted.push(item)
        } catch (err) {
          failed += 1
          attempted.push(item)
          console.error("[bulk-fix] item failed", item.id, err)
        }
        done += 1
        activity.updateItem(activityId, {
          detail:
            `${done} / ${broken.length} (${succeeded} ok · ${failed} failed)` +
            (rateLimitHits > 0 ? ` · ${rateLimitHits} retries after rate-limit` : ""),
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
      // Persist suppressions for every attempted item — one round
      // trip, not N. Future lint runs hide these unless the user
      // explicitly clears or shows them.
      if (attempted.length > 0) {
        try {
          const { recordAttempts } = await import("@/lib/lint-suppressions")
          await recordAttempts(pp, attempted)
        } catch (e) {
          console.warn("[bulk-fix] failed to record attempts:", e)
        }
      }
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

  /**
   * Mechanical cleanup, step 1 of 2: dry-run the reconciler, then
   * open the per-file preview dialog. The user reviews the actual
   * diff before clicking Apply, which calls `handleApplyReconcile`
   * below to run the real (non-dry) pass + annotation + activity
   * logging.
   *
   * Why a dialog instead of `window.confirm()`: the old flow only
   * showed totals ("3 broken wikilinks · 1 index row dropped"),
   * which made the user trust the count blind. Showing the actual
   * diff per file turns the cleanup into an informed action.
   */
  async function handleReconcile() {
    if (!project || reconciling) return
    const pp = normalizePath(project.path)
    setReconciling(true)
    try {
      const { reconcileWiki } = await import("@/lib/wiki-reconcile")
      const dry = await reconcileWiki(pp, { dryRun: true })
      if (
        dry.totalBrokenWikilinksReplaced === 0 &&
        dry.totalRelatedEntriesRemoved === 0 &&
        dry.totalIndexRowsDropped === 0 &&
        dry.totalIndexRowsAdded === 0
      ) {
        window.alert(
          t("lint.reconcileNoOp", {
            defaultValue: "No broken references found — nothing to clean.",
          }),
        )
        return
      }
      setPreviewState({
        changes: dry.changes,
        totals: {
          files: dry.changes.length,
          brokenLinks: dry.totalBrokenWikilinksReplaced,
          relatedDropped: dry.totalRelatedEntriesRemoved,
          indexDropped: dry.totalIndexRowsDropped,
          indexAdded: dry.totalIndexRowsAdded,
        },
      })
    } catch (err) {
      console.error("[reconcile] dry-run failed:", err)
      window.alert(
        t("lint.reconcileFailed", {
          defaultValue: `Cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setReconciling(false)
    }
  }

  /**
   * Step 2 of 2: user clicked Apply in the preview dialog. Run the
   * real reconcile + optional LLM annotation + activity logging,
   * then re-run lint so the cleaned-up state is reflected in the
   * findings list.
   */
  async function handleApplyReconcile() {
    if (!project) return
    const pp = normalizePath(project.path)
    setPreviewState(null)
    setReconciling(true)
    try {
      const { reconcileWiki } = await import("@/lib/wiki-reconcile")
      const real = await reconcileWiki(pp)
      // Optional LLM annotation pass — Labs flag. Runs after the
      // mechanical reconcile so freshly-added bullets get their
      // one-line descriptions filled in this same click.
      let annotateSummary = ""
      const wikiState = useWikiStore.getState()
      if (wikiState.experimentalIndexAnnotations && hasUsableLlm(wikiState.llmConfig)) {
        try {
          const { annotateIndex } = await import("@/lib/wiki-index-annotate")
          const ann = await annotateIndex({
            projectPath: pp,
            llmConfig: wikiState.llmConfig,
          })
          if (ann.attempted > 0) {
            annotateSummary =
              ` · ${ann.produced} new + ${ann.cached} cached descriptions` +
              (ann.llmError ? " (LLM error mid-run)" : "")
          }
        } catch (err) {
          console.warn("[reconcile] index-annotate failed:", err)
          annotateSummary = " · annotate failed (see console)"
        }
      }
      const activity = useActivityStore.getState()
      activity.addItem({
        type: "lint",
        title: "🧹 Cleanup broken references",
        status: "done",
        detail:
          `Rewrote ${real.changes.length} files · ` +
          `${real.totalBrokenWikilinksReplaced} broken wikilinks · ` +
          `${real.totalRelatedEntriesRemoved} dangling related: · ` +
          `${real.totalIndexRowsDropped} index rows dropped · ` +
          `${real.totalIndexRowsAdded} missing index entries added` +
          annotateSummary,
        filesWritten: real.changes.map((c) => c.slug),
      })
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
      // Auto-re-run lint so the user immediately sees the drop.
      handleRunLint()
    } catch (err) {
      console.error("[reconcile] failed:", err)
      window.alert(
        t("lint.reconcileFailed", {
          defaultValue: `Cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setReconciling(false)
    }
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
          {showResults && suppressedCount > 0 && (
            <button
              type="button"
              onClick={handleShowSuppressed}
              disabled={running}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:cursor-default disabled:opacity-60"
              title={t("lint.suppressedTooltip", {
                defaultValue:
                  "Findings already attempted in a previous fix. Click to clear and re-run lint so they show up again.",
              })}
            >
              {t("lint.suppressedCount", {
                defaultValue: `${suppressedCount} already attempted`,
                count: suppressedCount,
              })}
            </button>
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
          {/* Reconcile button — mechanical cleanup of broken refs +
              dangling related: + index drift. No LLM needed; runs in
              dry-run first to preview the change set, then a confirm
              dialog applies. queries/ + sources/ + .llm-wiki* trees
              are preserved as raw sources, so re-ingest can recover
              any over-eager cleanup. */}
          <Button
            size="sm"
            variant="outline"
            onClick={handleReconcile}
            disabled={running || reconciling || !project}
            title={t("lint.reconcileTitle", {
              defaultValue:
                "Mechanical cleanup: replace broken [[X]] with plain text, drop dangling related: entries, scrub index.md. No LLM. Dry-run preview first.",
            })}
          >
            <Wrench className={`mr-1.5 h-3.5 w-3.5 ${reconciling ? "animate-spin" : ""}`} />
            {reconciling
              ? t("lint.reconciling", { defaultValue: "Cleaning…" })
              : t("lint.reconcile", { defaultValue: "Cleanup refs" })}
          </Button>
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
            {groupByType(warnings).map((group) => {
              const key = `warning:${group.type}`
              const open = isFoldOpen(key, group.items.length)
              return (
                <TypeFoldGroup
                  key={key}
                  group={group}
                  open={open}
                  onToggle={() => toggleFold(key, open)}
                  typeConfig={typeConfig}
                  fixingId={fixingId}
                  onOpenPage={handleOpenPage}
                  onFix={handleFix}
                  onDelete={handleDeleteOrphan}
                  t={t}
                />
              )
            })}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label={t("lint.info")} count={infos.length} color="text-blue-500" t={t} />
            )}
            {groupByType(infos).map((group) => {
              const key = `info:${group.type}`
              const open = isFoldOpen(key, group.items.length)
              return (
                <TypeFoldGroup
                  key={key}
                  group={group}
                  open={open}
                  onToggle={() => toggleFold(key, open)}
                  typeConfig={typeConfig}
                  fixingId={fixingId}
                  onOpenPage={handleOpenPage}
                  onFix={handleFix}
                  onDelete={handleDeleteOrphan}
                  t={t}
                />
              )
            })}
          </div>
        )}
      </div>

      <ReconcilePreviewDialog
        open={previewState !== null}
        changes={previewState?.changes ?? []}
        totals={
          previewState?.totals ?? {
            files: 0,
            brokenLinks: 0,
            relatedDropped: 0,
            indexDropped: 0,
            indexAdded: 0,
          }
        }
        onApply={handleApplyReconcile}
        onCancel={() => setPreviewState(null)}
      />
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

/**
 * Foldable group of lint items that share a type. Header shows the
 * type icon, localised label, and count; clicking toggles expansion.
 * Default expansion follows the AUTO_FOLD_THRESHOLD rule (small piles
 * stay open), but users can click to override either direction.
 */
function TypeFoldGroup({
  group,
  open,
  onToggle,
  typeConfig,
  fixingId,
  onOpenPage,
  onFix,
  onDelete,
  t,
}: {
  group: { type: LintItem["type"]; items: LintItem[] }
  open: boolean
  onToggle: () => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  fixingId: string | null
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete: (item: LintItem) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const cfg = typeConfig[group.type] ?? typeConfig.semantic
  const TypeIcon = cfg.icon
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="rounded-lg border bg-muted/20">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40 rounded-lg"
        aria-expanded={open}
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <TypeIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{cfg.label}</span>
        <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
          {group.items.length}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t p-2">
          {group.items.map((item) => (
            <LintCard
              key={item.id}
              item={item}
              fixing={fixingId === item.id}
              onOpenPage={onOpenPage}
              onFix={onFix}
              onDelete={item.type === "orphan" ? onDelete : undefined}
              typeConfig={typeConfig}
              t={t}
            />
          ))}
        </div>
      )}
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
