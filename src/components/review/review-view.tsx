import { useCallback } from "react"
import { queueResearch } from "@/lib/deep-research"
import {
  AlertTriangle,
  Copy,
  FileQuestion,
  CheckCircle2,
  Lightbulb,
  MessageSquare,
  X,
  Check,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { writeFile, readFile, listDirectory, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { hasConfiguredSearchProvider } from "@/lib/web-search"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { createReviewPageDrafts } from "@/lib/review-create-page"
import { cleanAssistantContentForWikiSave, titleFromCleanAssistantContent } from "@/lib/chat-save-to-wiki"

const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; label: string; color: string }> = {
  contradiction: { icon: AlertTriangle, label: "Contradiction", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "Possible Duplicate", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "Missing Page", color: "text-purple-500" },
  confirm: { icon: MessageSquare, label: "Needs Confirmation", color: "text-foreground" },
  suggestion: { icon: Lightbulb, label: "Suggestion", color: "text-emerald-500" },
}

export function ReviewView() {
  const items = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const handleResolve = useCallback(async (id: string, action: string) => {
    const pp = project ? normalizePath(project.path) : ""
    const item = items.find((i) => i.id === id)

    // Dismissal — Skip / 跳过 / Dismiss / Ignore / Approve — short-circuit
    // BEFORE the create-page heuristic. The prompt locks the LLM to
    // OPTIONS: "Create Page | Skip", but models occasionally produce
    // localized or padded variants ("Skip this contradiction", "跳过 - 忽略",
    // "Skip and confirm"). Those used to slip through actionIsDismissal
    // (exact equality) and silently triggered the create-page branch,
    // which from the user's POV looked like "Skip did nothing" because
    // the page write happens in the background with no immediate UI shift.
    if (actionIsDismissal(action)) {
      resolveItem(id, action)
      return
    }

    // Deep Research — must be checked FIRST before any fuzzy matching
    if (action === "__deep_research__" && project) {
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (!hasConfiguredSearchProvider(searchConfig)) {
        window.alert("Web Search not configured. Go to Settings → Web Search to configure a provider first.")
        return
      }
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        // Use pre-generated search queries if available, otherwise fall back to title
        const topic = item.title.replace(/^(Save to Wiki|Create|Research)[:\s]*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig, item.searchQueries)
        resolveItem(id, "Queued for research")
      } else {
        resolveItem(id, action)
      }
      return
    }

    if (action.startsWith("save:") && project) {
      // Decode and save the content to wiki
      try {
        const encoded = action.slice(5)
        const content = decodeURIComponent(atob(encoded))

        // Strip hidden comments / thinking blocks and derive the title from the
        // first VISIBLE line — shared with the chat "Save to Wiki" button so a
        // Q&A saved from either entry point gets the same title/slug.
        const cleanContent = cleanAssistantContentForWikiSave(content)
        const title = titleFromCleanAssistantContent(cleanContent)
        // Unicode-aware slug + HHMMSS timestamp suffix so same-day / CJK saves
        // stay distinct (see src/lib/wiki-filename.ts).
        const { date, fileName } = makeQueryFileName(title)
        const filePath = `${pp}/wiki/queries/${fileName}`

        const frontmatter = `---\ntype: query\ntitle: "${title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\n---\n\n`
        const pageContent = frontmatter + cleanContent
        await writeFile(filePath, pageContent)

        // Update index
        const indexPath = `${pp}/wiki/index.md`
        let indexContent = ""
        try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
        const linkTarget = fileName.replace(/\.md$/, "")
        const entry = `- [[queries/${linkTarget}|${title}]]`
        if (indexContent.includes("## Queries")) {
          // Use a replacer FN so $-sequences in the entry (e.g. a `$1` that
          // slipped into a title) are inserted literally, not interpreted.
          indexContent = indexContent.replace(/(## Queries\n)/, (match) => `${match}${entry}\n`)
        } else {
          indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n"
        }
        await writeFile(indexPath, indexContent)

        // Append log
        const logPath = `${pp}/wiki/log.md`
        let logContent = ""
        try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
        await writeFile(logPath, logContent.trimEnd() + `\n- ${date}: Saved query page \`${fileName}\`\n`)

        // Refresh tree
        const tree = await listDirectory(pp)
        setFileTree(tree)
        // Open the freshly created page in the center preview (switches
        // to the wiki view) and invalidate cached graphs/views so the
        // new page shows up immediately.
        useWikiStore.getState().openFileInPreview(filePath, pageContent)
        useWikiStore.getState().bumpDataVersion()

        resolveItem(id, "Saved to Wiki")
      } catch (err) {
        console.error("Failed to save to wiki from review:", err)
        resolveItem(id, "Save failed")
      }
    } else if ((action.startsWith("open:") || actionLooksLikeOpen(action)) && project) {
      // Open a page in the center wiki preview without resolving the
      // review item. Viewing is not the same as accepting / fixing it.
      const page = action.startsWith("open:")
        ? action.slice(5)
        : item?.affectedPages?.[0] ?? item?.sourcePath ?? ""
      if (!page) return
      const normalizedPage = normalizePath(page)
      const candidates = normalizedPage.startsWith(pp)
        ? [normalizedPage]
        : normalizedPage.startsWith("wiki/") || normalizedPage.startsWith("raw/")
          ? [`${pp}/${normalizedPage}`, `${pp}/${normalizedPage}.md`]
          : [`${pp}/wiki/${normalizedPage}`, `${pp}/wiki/${normalizedPage}.md`]
      for (const path of candidates) {
        try {
          const content = await readFile(path)
          useWikiStore.getState().openFileInPreview(path, content)
          return
        } catch {
          // try next
        }
      }
    } else if (action.startsWith("delete:") && project) {
      // Delete a file
      const filePath = action.slice(7)
      try {
        await deleteFile(filePath)
        const tree = await listDirectory(pp)
        setFileTree(tree)
        resolveItem(id, "Deleted")
      } catch (err) {
        console.error("Failed to delete:", err)
        resolveItem(id, "Delete failed")
      }
    } else if (actionLooksLikeResearch(action) && project) {
      // Actions with "research" trigger deep research, not just page creation
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (!hasConfiguredSearchProvider(searchConfig)) {
        // No search API — fall through to create a page instead
        if (item) {
          handleResolve(id, "__create_page__:" + action)
        }
        return
      }
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        const topic = action.replace(/^research\s*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig)
        resolveItem(id, "Queued for deep research")
      } else {
        resolveItem(id, action)
      }
    } else if (
      (action.startsWith("__create_page__:") || actionLooksLikeCreate(action))
      && project
    ) {
      // Create a wiki page from the review item's content. Accepts both
      // the `__create_page__:` sentinel (forced via the "no search API"
      // fallback branch above) and actions that heuristically look like
      // a create instruction.
      const realAction = action.startsWith("__create_page__:")
        ? action.slice("__create_page__:".length)
        : action
      if (item) {
        try {
          // A single missing-page review can name several missing pages
          // ("缺少 X、Y 页面" / "missing pages A and B"). createReviewPageDrafts
          // splits those into one draft per page (with its detected page type +
          // target dir); non-missing-page reviews yield exactly one draft.
          const drafts = createReviewPageDrafts(item, realAction)
          const created: Array<{
            title: string
            dir: string
            fileName: string
            filePath: string
            pageContent: string
            pageType: string
            date: string
          }> = []

          for (const draft of drafts) {
            const { date, fileName } = makeQueryFileName(draft.title)
            const filePath = `${pp}/wiki/${draft.dir}/${fileName}`
            const frontmatter = `---\ntype: ${draft.pageType}\ntitle: "${draft.title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\nrelated: []\n---\n\n`
            const body = `# ${draft.title}\n\n${item.description}\n`
            const pageContent = frontmatter + body
            await writeFile(filePath, pageContent)
            created.push({ title: draft.title, dir: draft.dir, fileName, filePath, pageContent, pageType: draft.pageType, date })
          }

          // Update index — one wikilink per created page.
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
          for (const createdPage of created) {
            const sectionHeader = `## ${createdPage.dir.charAt(0).toUpperCase() + createdPage.dir.slice(1)}`
            const linkTarget = createdPage.fileName.replace(/\.md$/, "")
            const entry = `- [[${createdPage.dir}/${linkTarget}|${createdPage.title}]]`
            if (indexContent.includes(sectionHeader)) {
              // Replacer FN so $-sequences in the entry are inserted literally.
              indexContent = indexContent.replace(new RegExp(`(${sectionHeader}\n)`), (match) => `${match}${entry}\n`)
            } else {
              indexContent = indexContent.trimEnd() + `\n\n${sectionHeader}\n${entry}\n`
            }
          }
          await writeFile(indexPath, indexContent)

          // Log
          const logPath = `${pp}/wiki/log.md`
          let logContent = ""
          try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
          const createdNames = created.map((p) => `\`${p.fileName}\``).join(", ")
          const logDate = created[0]?.date ?? makeQueryFileName("review").date
          await writeFile(logPath, logContent.trimEnd() + `\n- ${logDate}: Created ${created.length} page${created.length === 1 ? "" : "s"} from review: ${createdNames}\n`)

          // Refresh + open the first created page in the center preview
          // (openFileInPreview switches to the wiki view). Fork note: this
          // path creates MULTIPLE pages from one review draft (see
          // createReviewPageDrafts) — we surface the first one.
          const tree = await listDirectory(pp)
          setFileTree(tree)
          const first = created[0]
          if (first) {
            useWikiStore.getState().openFileInPreview(first.filePath, first.pageContent)
          }
          useWikiStore.getState().bumpDataVersion()

          resolveItem(id, created.length === 1
            ? `Created: wiki/${created[0].dir}/${created[0].fileName}`
            : `Created ${created.length} pages`)
        } catch (err) {
          console.error("Failed to create page from review:", err)
          resolveItem(id, "Create failed")
        }
      } else {
        resolveItem(id, action)
      }
    } else {
      resolveItem(id, action)
    }
  }, [project, items, resolveItem, setFileTree])

  const pending = items.filter((i) => !i.resolved)
  const resolved = items.filter((i) => i.resolved)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          Review
          {pending.length > 0 && (
            <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
              {pending.length}
            </span>
          )}
        </h2>
        {resolved.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearResolved} className="text-xs">
            <Trash2 className="mr-1 h-3 w-3" />
            Clear resolved
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>All clear — nothing to review</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {pending.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={handleResolve}
                onDismiss={dismissItem}
              />
            ))}
            {resolved.length > 0 && pending.length > 0 && (
              <div className="my-2 text-center text-xs text-muted-foreground">
                — Resolved —
              </div>
            )}
            {resolved.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={handleResolve}
                onDismiss={dismissItem}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewCard({
  item,
  onResolve,
  onDismiss,
}: {
  item: ReviewItem
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
}) {
  const config = typeConfig[item.type]
  const Icon = config.icon

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-opacity ${
        item.resolved ? "opacity-50" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
          <span className="font-medium">{item.title}</span>
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">{item.description}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-3 text-xs text-muted-foreground">
          Pages: {item.affectedPages.join(", ")}
        </div>
      )}

      {!item.resolved ? (
        <div className="flex flex-wrap gap-1.5">
          {(item.type === "suggestion" || item.type === "missing-page") && (
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => onResolve(item.id, "__deep_research__")}
            >
              🔍 Deep Research
            </Button>
          )}
          {item.options.map((opt) => (
            <Button
              key={opt.action}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onResolve(item.id, opt.action)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}

/** Detect if an action implies deep research (web search + LLM synthesis) */
function actionLooksLikeResearch(action: string): boolean {
  // Skip internal action identifiers
  if (action.startsWith("__")) return false
  const lower = action.toLowerCase()
  return (
    lower.includes("research") ||
    lower.includes("investigate") ||
    lower.includes("explore") ||
    lower.includes("look into") ||
    lower.includes("研究") ||
    lower.includes("调研") ||
    lower.includes("探索")
  )
}

function actionLooksLikeOpen(action: string): boolean {
  // Prefix match — the OPTIONS-line prompt asks for short labels but the
  // LLM still emits localized / padded forms ("Open in editor", "Open page",
  // "打开编辑", "查看页面", "Edit"). Exact equality silently dropped these
  // and the click looked like a no-op.
  const lower = action.trim().toLowerCase()
  if (!lower) return false
  const prefixes = [
    "open",
    "view",
    "edit",
    "打开",
    "查看",
    "编辑",
  ]
  return prefixes.some((p) => lower.startsWith(p))
}

/** Detect if an action is a dismissal (no-op) or should create a page.
 *
 * Match policy: STARTSWITH (prefix) rather than equality. The OPTIONS-line
 * prompt locks the LLM to the literal "Skip" label, but live models
 * occasionally produce localized or padded forms ("Skip this", "Skip —
 * keep as is", "跳过 - 忽略此项"). Exact-equality matching missed those
 * and silently dropped the click into the create-page branch, which
 * created a wiki page from the review's description text — the opposite
 * of what the user clicked Skip to do.
 *
 * "approve" / "no" / "keep existing" intentionally stay as equality
 * matches: substring would over-trigger ("approve and document fully"
 * is a create-page intent, not a dismissal). */
function actionIsDismissal(action: string): boolean {
  const lower = action.trim().toLowerCase()
  if (
    lower.startsWith("skip") ||
    lower.startsWith("dismiss") ||
    lower.startsWith("ignore") ||
    lower.startsWith("跳过") ||
    lower.startsWith("忽略")
  ) {
    return true
  }
  return (
    lower === "approve" ||
    lower === "keep existing" ||
    lower === "no"
  )
}

function actionLooksLikeCreate(action: string): boolean {
  // Anything that isn't a dismissal should create a page
  return !actionIsDismissal(action)
}
