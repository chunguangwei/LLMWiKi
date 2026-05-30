import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Plus, FileText, RefreshCw, Trash2, Folder, ChevronRight, ChevronDown, Wand2, Image as ImageIcon, Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { normalizePath } from "@/lib/path-utils"
import { decideDeleteClick } from "@/lib/sources-tree-delete"
import { rescanProjectFileSync } from "@/lib/project-file-sync"
import {
  deleteSourceFile,
  deleteSourceFolder,
  enqueueSourceIngest,
  importSourceFiles,
  importSourceFolder,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"
import { addImagesToRawWithContext } from "@/lib/raw-from-chat"
import { runAgentIngest } from "@/lib/agent-ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"

const SOURCE_TREE_INITIAL_ROWS = 160
const SOURCE_TREE_LOAD_BATCH = 160

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [importingImages, setImportingImages] = useState(false)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)
  const [agentRunningPath, setAgentRunningPath] = useState<string | null>(null)
  const [reingestingAll, setReingestingAll] = useState(false)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const experimentalAgentIngest = useWikiStore((s) => s.experimentalAgentIngest)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  /**
   * Path of the source-tree node currently in "click again to
   * confirm delete" state. Lifted up here (rather than living
   * inside SourceTree) for two reasons:
   *   1. Only one button can be armed at a time across the whole
   *      tree — clicking another delete disarms the prior one.
   *      Lifting state to the common ancestor makes that natural.
   *   2. The auto-disarm timer (5s) needs to survive across re-
   *      renders triggered by tree mutation; useEffect cleanup
   *      anchored here is the right scope.
   */
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null)

  // Auto-disarm: 5 seconds without a second click resets the
  // pending state. Prevents a stale armed button from firing if
  // the user walked away and came back. Cleared whenever the
  // pending path changes (so a fresh arm restarts the clock).
  useEffect(() => {
    if (!pendingDeletePath) return
    const t = setTimeout(() => setPendingDeletePath(null), 5000)
    return () => clearTimeout(t)
  }, [pendingDeletePath])

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`)
      // Filter out hidden files/dirs and cache
      const filtered = filterTree(tree)
      setSources(filtered)
      setRefreshError(null)
    } catch (err) {
      setRefreshError(String(err))
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources, dataVersion])

  async function handleRefreshSources() {
    if (!project || refreshing) return
    setRefreshing(true)
    try {
      await rescanProjectFileSync(project, useWikiStore.getState().sourceWatchConfig)
      setRefreshError(null)
    } catch (err) {
      console.warn("[sources] failed to rescan project files:", err)
      setRefreshError(String(err))
    } finally {
      await loadSources()
      setRefreshing(false)
    }
  }

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: t("sources.importSourceFiles"),
      filters: [
        {
          name: "Documents",
          extensions: [
            "md", "mdx", "txt", "rtf", "pdf",
            "html", "htm", "xml",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "odt", "ods", "odp", "epub", "pages", "numbers", "key",
          ],
        },
        {
          name: "Data",
          extensions: ["json", "jsonl", "csv", "tsv", "yaml", "yml", "ndjson"],
        },
        {
          name: "Code",
          extensions: [
            "py", "js", "ts", "jsx", "tsx", "rs", "go", "java",
            "c", "cpp", "h", "rb", "php", "swift", "sql", "sh",
          ],
        },
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"],
        },
        {
          name: "Media",
          extensions: ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    })

    if (!selected || selected.length === 0) return

    setImporting(true)
    const paths = Array.isArray(selected) ? selected : [selected]
    try {
      await importSourceFiles(project, paths, llmConfig)
      await loadSources()
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFolder() {
    if (!project) return

    const selected = await open({
      directory: true,
      title: t("sources.importSourceFolder"),
    })

    if (!selected || typeof selected !== "string") return

    setImporting(true)
    try {
      await importSourceFolder(project, selected, llmConfig)
      await loadSources()
    } catch (err) {
      console.error(`Failed to import folder:`, err)
    } finally {
      setImporting(false)
    }
  }

  /**
   * Image import — separate from handleImport because images don't go
   * through `importSourceFiles` (their extensions aren't in
   * INGESTABLE_SOURCE_EXTENSIONS — vision-LLM extracts markdown into
   * a sibling `.md`, and the `.md` is what gets ingested).
   */
  async function handleImportImages() {
    if (!project || importingImages) return
    const selected = await open({
      multiple: true,
      title: t("sources.importImages", { defaultValue: "Import images" }),
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg"],
        },
      ],
    })
    if (!selected || (Array.isArray(selected) && selected.length === 0)) return
    const paths = Array.isArray(selected) ? selected : [selected]
    setImportingImages(true)
    try {
      const result = await addImagesToRawWithContext(
        project,
        paths.map((p) => ({ sourcePath: p })),
        "",
        llmConfig,
      )
      if (result.visionRefusals > 0) {
        const where = result.usedDedicatedVisionLlm
          ? t("sources.visionRefusedDedicated", {
              defaultValue:
                "The vision model configured in Settings → Multimodal ({{model}}) doesn't appear to support image input.",
              model: result.attemptedVisionModel,
            })
          : t("sources.visionRefusedMainLlm", {
              defaultValue:
                "The current chat LLM ({{model}}) is text-only — it can't process images.",
              model: result.attemptedVisionModel,
            })
        const fix = t("sources.visionRefusedFix", {
          defaultValue:
            "Open Settings → Multimodal and configure a vision-capable model (Gemini 2.5 Flash / Claude Haiku / GPT-4o), then re-ingest the images.",
        })
        window.alert(
          `${where}\n\n${fix}\n\n(${result.visionRefusals}/${paths.length} images affected)`,
        )
      }
      await loadSources()
    } catch (err) {
      console.error("Failed to import images:", err)
      window.alert(
        t("sources.importImagesFailed", {
          defaultValue: "Failed to import images: {{error}}",
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setImportingImages(false)
    }
  }

  async function handleOpenSource(node: FileNode) {
    setSelectedFile(node.path)
    try {
      const content = await readFile(node.path)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    // Confirmation now lives in the SourceTree component as a
    // two-stage button (click once = "Confirm", click again =
    // delete). Reaching this handler means the user has already
    // confirmed via the inline UI, so we proceed unconditionally.
    try {
      const result = await deleteSourceFile(pp, node.path)
      // Step 8: Refresh everything (UI side — must run with parent
      // context, hence kept here rather than inside the helper).
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile === node.path ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
    }
  }

  /**
   * Recursive folder delete. Walks the folder tree, runs the
   * wiki-cascade for every individual file inside (so any
   * derived wiki pages, embeddings, log entries get cleaned up
   * the same way as a single-file delete), then removes the
   * folder itself with `deleteFile` — which dispatches to
   * `remove_dir_all` Rust-side, taking the now-empty (or near-
   * empty) directory tree with it including any leftover dotdir
   * cache files we didn't explicitly target.
   *
   * Errors on individual files are logged and skipped; the batch
   * keeps going so partial cleanup is preferred over an all-or-
   * nothing failure that leaves the tree half-deleted.
   */
  async function handleDeleteFolder(folder: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const result = await deleteSourceFolder(pp, folder)
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile?.startsWith(folder.path + "/") ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete folder:", err)
      window.alert(`Failed to delete folder: ${err}`)
    }
  }

  async function handleIngest(node: FileNode) {
    if (!project || ingestingPath) return
    // Re-ingest goes through the same automated queue path as a fresh
    // import (`handleImport` above). Earlier this used `startIngest`,
    // which opens an interactive chat → user clicks "Save to Wiki" →
    // `executeIngestWrites`. That had two problems: (a) it duplicated
    // the auto-pipeline so features like image cascade had to be
    // wired in twice, and (b) the interactive flow surprised users
    // who expected a fresh-import re-run. One button, one path now.
    setIngestingPath(node.path)
    try {
      await enqueueSourceIngest(project, [node.path], llmConfig)
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  /**
   * Run the experimental agent-ingest pipeline on a single source.
   *
   * Bypasses the classic queue entirely — `runAgentIngest()` is a
   * single direct call that drives a multi-turn agent conversation
   * over the tool catalogue defined in `lib/agent-ingest/tools/`.
   * The user-facing experience is "click the 🤖 button on a source,
   * watch the activity panel update turn-by-turn, end up with new
   * wiki pages (or gaps surfaced as review items) when the agent
   * calls `done`".
   *
   * Caveats called out in the tooltip + activity detail so users
   * with budget concerns can opt out:
   *
   *   - Costs more LLM tokens than the classic pipeline (multi-turn
   *     tool calling vs single-shot analysis + generate).
   *   - Quality is currently UNVALIDATED — Phase F has yet to run
   *     it on real long sources and tune the prompts. Use on
   *     low-stakes documents first.
   *   - No checkpoint persistence yet (Phase E). A network hiccup
   *     mid-loop loses the partial state; just retry.
   */
  async function handleAgentIngest(node: FileNode) {
    if (!project || agentRunningPath) return
    setAgentRunningPath(node.path)
    const activity = useActivityStore.getState()
    const sourceName = node.path.split("/").pop() ?? node.path
    const activityId = activity.addItem({
      type: "ingest",
      title: `🤖 Agent ingest: ${sourceName}`,
      status: "running",
      detail: "Starting agent loop…",
      filesWritten: [],
    })
    try {
      const result = await runAgentIngest({
        sourcePath: node.path,
        project,
        llmConfig,
        onTurn: (turnIndex, tokensSoFar) => {
          activity.updateItem(activityId, {
            detail: `Turn ${turnIndex + 1} · ${Math.round(tokensSoFar / 1000)}k tokens`,
          })
        },
      })
      const writtenPaths = [
        ...result.pagesCreated.map((p) => p.slug),
        ...result.pagesUpdated.map((p) => p.slug),
      ]
      // Surface each gap from the tracker (which includes the
      // verify pass's findings) as a Review item so the user can
      // act on it — "Create page" (next agent run will pick this
      // up via the Review queue) or "Skip" (dismiss). The Review
      // tab is where uncovered topics live until the user decides.
      if (result.reviewItemsCreated.length > 0) {
        const review = useReviewStore.getState()
        for (const gap of result.reviewItemsCreated) {
          review.addItem({
            type: "missing-page",
            title: gap.topic,
            description:
              (gap.reason ?? "Agent flagged this topic as uncovered.") +
              `\n\nFrom source: \`${node.path.split("/").pop()}\``,
            sourcePath: node.path,
            ...(gap.chunks && gap.chunks.length > 0
              ? { affectedPages: gap.chunks }  // chunk ids — informational, not actual page paths
              : {}),
            options: [
              { label: t("review.createPage", { defaultValue: "Create Page" }), action: "Create Page" },
              { label: t("review.skip", { defaultValue: "Skip" }), action: "Skip" },
            ],
          })
        }
      }
      const lines = [
        result.reason,
        `Turns: ${result.turnsUsed} · tokens: ${Math.round(result.tokensSpent / 1000)}k`,
        `Coverage: ${Math.round(result.coverage * 100)}%`,
        result.pagesCreated.length > 0
          ? `Created: ${result.pagesCreated.map((p) => p.slug).join(", ")}`
          : "",
        result.pagesUpdated.length > 0
          ? `Updated: ${result.pagesUpdated.map((p) => p.slug).join(", ")}`
          : "",
        result.reviewItemsCreated.length > 0
          ? `Gaps surfaced: ${result.reviewItemsCreated.length} (see Review)`
          : "",
      ].filter(Boolean)
      activity.updateItem(activityId, {
        status: "done",
        detail: lines.join("\n"),
        filesWritten: writtenPaths,
      })
      // Wiki pages changed → file tree + knowledge tree need to refresh.
      bumpDataVersion()
      try {
        const tree = await listDirectory(normalizePath(project.path))
        setFileTree(tree)
      } catch {
        // non-fatal — the next refresh will catch it
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[agent-ingest] failed:", err)
      activity.updateItem(activityId, {
        status: "error",
        detail: `Agent ingest failed: ${message}`,
      })
    } finally {
      setAgentRunningPath(null)
    }
  }

  function collectIngestableLeaves(nodes: FileNode[]): string[] {
    const out: string[] = []
    const walk = (ns: FileNode[]) => {
      for (const n of ns) {
        if (n.is_dir) {
          if (n.children) walk(n.children)
        } else if (isIngestableSourcePath(n.path)) {
          out.push(n.path)
        }
      }
    }
    walk(nodes)
    return out
  }

  async function handleReingestAll() {
    if (!project || reingestingAll) return
    const paths = collectIngestableLeaves(sources)
    if (paths.length === 0) {
      window.alert(
        t("sources.reingestAllEmpty", {
          defaultValue: "No ingestable sources found in raw/sources/.",
        }),
      )
      return
    }
    // Confirm before firing — this can spend a non-trivial amount of
    // LLM tokens (one ingest pipeline per source). The dialog also
    // surfaces the exact count so the user can sanity-check that
    // `raw/sources/` isn't accidentally empty / huge.
    const ok = window.confirm(
      t("sources.reingestAllConfirm", {
        defaultValue:
          "Re-run ingest on {{count}} source file(s)? This will rebuild the wiki and consumes LLM tokens.",
        count: paths.length,
      }),
    )
    if (!ok) return

    setReingestingAll(true)
    try {
      await enqueueSourceIngest(project, paths, llmConfig)
    } catch (err) {
      console.error("Failed to enqueue bulk re-ingest:", err)
      window.alert(`Failed to enqueue bulk re-ingest: ${err}`)
    } finally {
      setReingestingAll(false)
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRefreshSources}
                  disabled={refreshing}
                  aria-label={t("sources.refreshFolder")}
                />
              }
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-80 whitespace-normal leading-relaxed">
              {t("sources.refreshFolderTooltip")}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.import")}
          </Button>
          <Button size="sm" onClick={handleImportFolder} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {t("sources.importFolder", "Folder")}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleImportImages}
                  disabled={importingImages}
                  aria-label={t("sources.importImages", { defaultValue: "Import images" })}
                />
              }
            >
              <ImageIcon className={`mr-1 h-4 w-4 ${importingImages ? "animate-pulse" : ""}`} />
              {importingImages
                ? t("sources.importingImages", { defaultValue: "Extracting..." })
                : t("sources.importImages", { defaultValue: "Image" })}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-80 whitespace-normal leading-relaxed">
              {t("sources.importImagesTooltip", {
                defaultValue:
                  "Pick image files. A vision-capable LLM extracts each image's content as markdown, then ingest runs on the extracted markdown.",
              })}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReingestAll}
                  disabled={reingestingAll || sources.length === 0}
                  aria-label={t("sources.reingestAll", { defaultValue: "Re-ingest all" })}
                />
              }
            >
              <Wand2 className={`mr-1 h-4 w-4 ${reingestingAll ? "animate-pulse" : ""}`} />
              {reingestingAll
                ? t("sources.reingestingAll", { defaultValue: "Queuing..." })
                : t("sources.reingestAll", { defaultValue: "Re-ingest all" })}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-80 whitespace-normal leading-relaxed">
              {t("sources.reingestAllTooltip", {
                defaultValue:
                  "Re-run ingest on every file in raw/sources/ to rebuild the wiki. Confirms before firing — uses LLM tokens.",
              })}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {refreshError && (
          <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t("sources.refreshFailed", {
              defaultValue: "Failed to refresh sources: {{error}}",
              error: refreshError,
            })}
          </div>
        )}
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>{t("sources.noSources")}</p>
            <p>{t("sources.importHint")}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleImport}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFiles")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportFolder}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFolder")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={sources}
              onOpen={handleOpenSource}
              onIngest={handleIngest}
              onAgentIngest={experimentalAgentIngest ? handleAgentIngest : undefined}
              agentRunningPath={agentRunningPath}
              onDelete={handleDelete}
              onDeleteFolder={handleDeleteFolder}
              pendingDeletePath={pendingDeletePath}
              setPendingDeletePath={setPendingDeletePath}
              ingestingPath={ingestingPath}
            />
          </div>
        )}
      </ScrollArea>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>{t("sources.sourceCount", { count: countFiles(sources) })}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefreshSources}
                disabled={!project || refreshing}
                className="h-7 px-2 text-xs"
              />
            }
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? t("sources.refreshingFolder") : t("sources.refreshFolder")}
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-80 whitespace-normal leading-relaxed">
            {t("sources.refreshFolderTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>
      </div>
    </TooltipProvider>
  )
}

interface SourceTreeRow {
  node: FileNode
  depth: number
}

function filterTree(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((n) => !n.name.startsWith("."))
    .map((n) => {
      if (n.is_dir && n.children) {
        return { ...n, children: filterTree(n.children) }
      }
      return n
    })
    .filter((n) => !n.is_dir || (n.children && n.children.length > 0))
}

function countFiles(nodes: FileNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      count += countFiles(node.children)
    } else if (!node.is_dir) {
      count++
    }
  }
  return count
}

function sortSourceNodes(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.localeCompare(b.name)
  })
}

function flattenVisibleRows(
  nodes: readonly FileNode[],
  collapsed: Record<string, boolean>,
  depth = 0,
): SourceTreeRow[] {
  const rows: SourceTreeRow[] = []
  for (const node of sortSourceNodes(nodes)) {
    rows.push({ node, depth })
    if (node.is_dir && node.children && !(collapsed[node.path] ?? false)) {
      rows.push(...flattenVisibleRows(node.children, collapsed, depth + 1))
    }
  }
  return rows
}

function SourceTree({
  nodes,
  onOpen,
  onIngest,
  onAgentIngest,
  onDelete,
  onDeleteFolder,
  pendingDeletePath,
  setPendingDeletePath,
  ingestingPath,
  agentRunningPath,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  /** Optional — when undefined the 🤖 button is hidden. Gated behind
   *  the Labs `experimentalAgentIngest` flag in v0.4.23. */
  onAgentIngest?: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onDeleteFolder: (node: FileNode) => void
  /** Path of the node currently in "click again to confirm" state.
   *  Lifted to the parent so only ONE button is armed at a time
   *  across the whole tree — clicking another delete arms that one
   *  and disarms the previous. */
  pendingDeletePath: string | null
  setPendingDeletePath: (path: string | null) => void
  ingestingPath: string | null
  agentRunningPath: string | null
}) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleLimit, setVisibleLimit] = useState(SOURCE_TREE_INITIAL_ROWS)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => flattenVisibleRows(nodes, collapsed), [nodes, collapsed])
  const visibleRows = rows.slice(0, visibleLimit)
  const hasMore = visibleLimit < rows.length

  useEffect(() => {
    setVisibleLimit(SOURCE_TREE_INITIAL_ROWS)
  }, [nodes])

  useEffect(() => {
    if (!hasMore) return
    const target = loadMoreRef.current
    if (!target) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisibleLimit((current) => Math.min(current + SOURCE_TREE_LOAD_BATCH, rows.length))
    }, { rootMargin: "240px 0px" })

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, rows.length])

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  /**
   * Two-stage delete handler. Decision logic lives in
   * `decideDeleteClick` (pure, unit-tested in
   * `sources-tree-delete.test.ts`); this wrapper just dispatches
   * the resulting action onto the React state + handler props.
   */
  const handleDeleteClick = (node: FileNode) => {
    const action = decideDeleteClick(pendingDeletePath, node)
    switch (action.kind) {
      case "arm":
        setPendingDeletePath(action.path)
        return
      case "fire-file":
        setPendingDeletePath(null)
        onDelete(action.node)
        return
      case "fire-folder":
        setPendingDeletePath(null)
        onDeleteFolder(action.node)
        return
    }
  }

  return (
    <>
      {visibleRows.map(({ node, depth }) => {
        const isPendingDelete = pendingDeletePath === node.path
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                <button
                  onClick={() => toggle(node.path)}
                  className="flex flex-1 items-center gap-1.5 px-1 py-1 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="truncate font-medium">{node.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
                    {countFiles(node.children)}
                  </span>
                </button>
                <DeleteButton
                  isPending={isPendingDelete}
                  onClick={() => handleDeleteClick(node)}
                  hint={
                    isPendingDelete
                      ? t("sources.deleteFolderConfirm", { name: node.name })
                      : t("sources.deleteFolder", { name: node.name })
                  }
                />
              </div>
            </div>
          )
        }

        return (
          <div
            key={node.path}
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <button
              onClick={() => onOpen(node)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={t("sources.reingestOne", {
                defaultValue: "Re-ingest this file",
              })}
              disabled={ingestingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <Wand2 className={`h-4 w-4 ${ingestingPath === node.path ? "animate-pulse" : ""}`} />
            </Button>
            {onAgentIngest && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                title={t("sources.agentIngest", {
                  defaultValue:
                    "🤖 Agent ingest (experimental) — multi-turn LLM agent reads the source and writes wiki pages. Uses more tokens than classic ingest; quality not yet validated on real long docs.",
                })}
                disabled={agentRunningPath === node.path || agentRunningPath !== null}
                onClick={() => onAgentIngest(node)}
              >
                <Bot
                  className={`h-4 w-4 ${
                    agentRunningPath === node.path
                      ? "animate-pulse text-emerald-600 dark:text-emerald-400"
                      : "text-emerald-600/70 dark:text-emerald-400/70"
                  }`}
                />
              </Button>
            )}
            <DeleteButton
              isPending={isPendingDelete}
              onClick={() => handleDeleteClick(node)}
              hint={
                isPendingDelete
                  ? t("sources.deleteFileConfirm", { name: node.name })
                  : t("sources.deleteFile", { name: node.name })
              }
            />
          </div>
        )
      })}
      {hasMore && (
        <div
          ref={loadMoreRef}
          className="px-3 py-2 text-center text-[11px] text-muted-foreground"
        >
          {t("sources.loadingMore")}
        </div>
      )}
    </>
  )
}

/**
 * Two-stage delete button. Default = ghost trash icon (subtle).
 * Armed = solid red "Confirm" pill with the icon — visually
 * unmistakable, so the user can't miss the second-click warning.
 *
 * Same component is used for both files and folders; the parent
 * decides which delete handler to call from the click. The pending
 * state is owned by SourceTree (lifted to its parent SourcesView)
 * so only one button is armed across the entire tree at a time.
 */
function DeleteButton({
  isPending,
  onClick,
  hint,
}: {
  isPending: boolean
  onClick: () => void
  hint: string
}) {
  const { t } = useTranslation()
  if (isPending) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className="h-7 shrink-0 px-2 text-[11px] font-semibold animate-pulse"
        title={hint}
        onClick={onClick}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        {t("sources.confirm")}
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={hint}
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  )
}
