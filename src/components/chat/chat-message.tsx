import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import {
  Bot, User, FileText, BookmarkPlus, ChevronDown, ChevronRight, RefreshCw, Copy, Check,
  Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, Layout, Globe,
  TrendingUp, Target, Image as ImageIcon,
} from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { lastQueryPages } from "@/components/chat/chat-panel"
import { useChatStore, type DisplayMessage } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"

import { convertLatexToUnicode } from "@/lib/latex-to-unicode"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { makeQueryFileName, makeQuerySlug } from "@/lib/wiki-filename"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { findRawSourceForImage, imageUrlToAbsolute } from "@/lib/raw-source-resolver"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import { parseFileBlocks, isSafeIngestPath } from "@/lib/ingest"
import { applyPageEdit } from "@/lib/apply-page-edit"
import { diffLines, diffStats, isUnchanged } from "@/lib/text-diff"
import { useReviewStore } from "@/stores/review-store"

// Module-level cache of source file names
let cachedSourceFiles: string[] = []

export function useSourceFiles() {
  const project = useWikiStore((s) => s.project)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => {
        cachedSourceFiles = flattenNames(tree)
      })
      .catch(() => {
        cachedSourceFiles = []
      })
  }, [project])

  return cachedSourceFiles
}

function flattenNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

interface ChatMessageProps {
  message: DisplayMessage
  isLastAssistant?: boolean
  onRegenerate?: () => void
}

function ChatMessageImpl({ message, isLastAssistant, onRegenerate }: ChatMessageProps) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isAssistant = message.role === "assistant"
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="max-w-[80%] flex flex-col gap-1.5">
        {isAssistant && message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsBlock toolCalls={message.toolCalls} />
        )}
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground"
          }`}
        >
          {isUser ? (
            <p dir="auto" className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </div>
        {isAssistant && <ProposedEdits content={message.content} />}
        {isAssistant && <CitedReferencesPanel content={message.content} savedReferences={message.references} />}
        {isAssistant && hovered && (
          <div className="flex items-center gap-1">
            <CopyButton content={message.content} />
            <SaveToWikiButton
              messageId={message.id}
              content={message.content}
              savedToWiki={message.savedToWiki}
              fetchedSources={message.fetchedSources}
              visible={true}
            />
            {isLastAssistant && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                title="Regenerate this response"
              >
                <RefreshCw className="h-3 w-3" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageImpl, (prev, next) =>
  prev.message === next.message
  && prev.isLastAssistant === next.isLastAssistant
  && prev.onRegenerate === next.onRegenerate
)

/**
 * Tool calls rendered above the assistant message body. Defaults to a
 * compact "🔧 used N tools" header that the user can click to expand
 * into per-tool name / input / result rows. Read-only — the user can
 * inspect what the agent did but can't replay it.
 *
 * One row per tool call, in the order the agent emitted them. Result
 * summaries are colour-coded loosely: gray = ok, amber = skipped or
 * structured error, never destructive.
 */
function ToolCallsBlock({
  toolCalls,
}: {
  toolCalls: NonNullable<DisplayMessage["toolCalls"]>
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span>
          🔧 {toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}:{" "}
          <span className="font-mono">
            {Array.from(new Set(toolCalls.map((t) => t.name))).join(", ")}
          </span>
        </span>
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
          {toolCalls.map((t, i) => (
            <div key={i} className="flex flex-col gap-0.5 font-mono text-[10px]">
              <div>
                <span className="text-primary">{t.name}</span>
                <span className="ml-1 text-muted-foreground/80">({t.inputSummary})</span>
              </div>
              <div
                className={`pl-3 ${
                  isAttentionResult(t.resultSummary)
                    ? "text-amber-600 dark:text-amber-400"
                    : ""
                }`}
              >
                → {t.resultSummary}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Whether a tool's result summary should render in amber (worth-a-look).
 * Covers explicit `error:`, the runner's done-batch `skipped` sentinel,
 * and the chat-agent's structured `no_provider_configured` envelope —
 * all three are "tool ran but didn't accomplish what the LLM wanted".
 * Plain `ok` results stay in the muted default color.
 */
function isAttentionResult(summary: string): boolean {
  const s = summary.toLowerCase()
  return (
    s.startsWith("error:") ||
    s.startsWith("skipped") ||
    s.includes("no_provider_configured")
  )
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    // Strip HTML comments and thinking blocks before copying
    const clean = content
      .replace(/<!--.*?-->/gs, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
      .trim()

    await navigator.clipboard.writeText(clean)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [content])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}

function SaveToWikiButton({
  messageId,
  content,
  savedToWiki,
  fetchedSources,
  visible,
}: {
  messageId: string
  content: string
  savedToWiki?: DisplayMessage["savedToWiki"]
  fetchedSources?: DisplayMessage["fetchedSources"]
  visible: boolean
}) {
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const markMessageSavedToWiki = useChatStore((s) => s.markMessageSavedToWiki)
  const setMessageIngestState = useChatStore((s) => s.setMessageIngestState)
  // Derived from the message itself, not local state: a previous
  // local-state implementation flashed "Saved!" for 2 seconds then
  // reset, which meant remounts / scroll virtualisation let the user
  // click Save again on already-saved content and create dupes. We
  // persist the saved flag on the message so it survives re-renders,
  // conversation switches, and app restarts (chat auto-save writes
  // messages including savedToWiki to disk).
  const isSaved = Boolean(savedToWiki?.path)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!project || saving || isSaved) return
    const pp = normalizePath(project.path)
    setSaving(true)
    try {
      // Generate a unique filename for this save.
      // See `src/lib/wiki-filename.ts` — the slug is Unicode-aware
      // (so CJK titles don't collapse to empty) and the HHMMSS
      // timestamp suffix guarantees same-day saves stay distinct.
      const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim()
      const title = firstLine.slice(0, 60) || "Saved Query"
      const { date, fileName } = makeQueryFileName(title)
      const filePath = `${pp}/wiki/queries/${fileName}`

      // Strip hidden sources comment and thinking blocks from content
      const stripped = content
        .replace(/<!--\s*sources:.*?-->/g, "")
        .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
        .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
        .trimEnd()

      // Wikify pass — a small LLM call that rewrites conversational
      // chat tone ("Based on the article...", "Here's a summary...",
      // "I fetched...") into clean knowledge-style markdown. Same
      // facts, no chat scaffolding. Falls back to `stripped` when
      // the LLM call fails / there's no usable LLM / content is too
      // short to bother. Lazy-imported so test code that mocks the
      // module doesn't have to mock streamChat.
      //
      // Bypassed when the Labs `experimentalRawSaveToWiki` flag is
      // ON — some users want the agent's reply verbatim (record-
      // keeping, code-heavy answers, prose where wikify over-edits).
      //
      // NOTE: llmConfig is captured ONCE here and reused for the
      // autoIngest call below — defining a second `const llmConfig`
      // in the same scope would shadow + tsc-fail.
      const llmConfig = useWikiStore.getState().llmConfig
      const rawSaveOptIn = useWikiStore.getState().experimentalRawSaveToWiki
      let cleanContent = stripped
      if (!rawSaveOptIn && hasUsableLlm(llmConfig)) {
        try {
          const { wikifyForSave } = await import("@/lib/wikify")
          cleanContent = await wikifyForSave(stripped, llmConfig)
        } catch (err) {
          console.warn("[SaveToWiki] wikify failed, using raw content:", err)
        }
      }

      // Raw-source preservation — spill every web_fetch primary
      // source the chat-agent pulled into raw/sources/web/. The
      // resulting filenames go into the query frontmatter's
      // `sources:` array so the wiki page has a paper-trail back
      // to the original article without the user having to dig
      // through the activity log.
      //
      // Failure is per-source and best-effort — if one source fails
      // to write, the others still go through and the user gets the
      // wiki page either way. Whatever DID write goes into the
      // frontmatter; the rest is logged via console.warn.
      const writtenSourcePaths: string[] = []
      if (fetchedSources && fetchedSources.length > 0) {
        const rawWebDir = `${pp}/raw/sources/web`
        try {
          // createDirectory is idempotent — re-creating is cheap and
          // avoids a "first save fails because directory missing" foot-gun.
          const { createDirectory } = await import("@/commands/fs")
          await createDirectory(rawWebDir).catch(() => {})
        } catch {
          /* fall through — writeFile below will surface a clear error */
        }
        for (let i = 0; i < fetchedSources.length; i++) {
          const src = fetchedSources[i]
          const srcSlug = makeQuerySlug(src.title || `source-${i + 1}`)
          const srcFileName = `${srcSlug || `source-${i + 1}`}-${date}-${
            // Add a 1-based suffix so multiple sources from the same
            // save can't collide if they happen to slugify to the
            // same name (rare but possible — e.g. two CNBC articles
            // with the same H1).
            String(i + 1).padStart(2, "0")
          }.md`
          const srcPath = `${rawWebDir}/${srcFileName}`
          const srcFm = [
            "---",
            "type: source",
            `title: ${JSON.stringify(src.title || srcFileName.replace(/\.md$/, ""))}`,
            `url: ${JSON.stringify(src.url)}`,
            `created: ${date}`,
            src.fetchedAt ? `fetched_at: ${JSON.stringify(src.fetchedAt)}` : "",
            "origin: chat-save-raw",
            "---",
            "",
          ].filter(Boolean).join("\n")
          try {
            await writeFile(srcPath, srcFm + src.markdown)
            writtenSourcePaths.push(`raw/sources/web/${srcFileName}`)
          } catch (err) {
            console.warn(`[SaveToWiki] failed to write raw source ${srcPath}:`, err)
          }
        }
      }

      const frontmatter = [
        "---",
        `type: query`,
        `title: "${title.replace(/"/g, '\\"')}"`,
        `created: ${date}`,
        `tags: []`,
        // sources: array of project-relative paths to the raw web
        // fetches that informed this reply. Empty array (or absent)
        // means the agent answered without external sources.
        writtenSourcePaths.length > 0
          ? `sources: ${JSON.stringify(writtenSourcePaths)}`
          : "",
        // origin marker — autoIngest reads this to decide whether
        // to run its review-suggestion stage. Chat replies are
        // already user-vetted answers; they don't need the LLM to
        // come back and "raise concerns" in the Review queue.
        `origin: chat-save`,
        "---",
        "",
      ].filter(Boolean).join("\n")

      await writeFile(filePath, frontmatter + cleanContent)

      // Update index.md — append under ## Queries section
      const indexPath = `${pp}/wiki/index.md`
      let indexContent = ""
      try {
        indexContent = await readFile(indexPath)
      } catch {
        indexContent = "# Wiki Index\n\n## Queries\n"
      }
      // The wikilink target is the filename WITHOUT the `.md`
      // extension — must match `fileName` exactly (including the
      // time suffix) or the link lands on a 404.
      const linkTarget = fileName.replace(/\.md$/, "")
      const entry = `- [[queries/${linkTarget}|${title}]]`
      if (indexContent.includes("## Queries")) {
        indexContent = indexContent.replace(
          /(## Queries\n)/,
          `$1${entry}\n`
        )
      } else {
        indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n"
      }
      await writeFile(indexPath, indexContent)

      // Append to log.md
      const logPath = `${pp}/wiki/log.md`
      let logContent = ""
      try {
        logContent = await readFile(logPath)
      } catch {
        logContent = "# Wiki Log\n\n"
      }
      const logEntry = `- ${date}: Saved query page \`${fileName}\`\n`
      await writeFile(logPath, logContent.trimEnd() + "\n" + logEntry)

      // Refresh file tree and update graph
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()

      // Commit the saved-to-wiki marker on the message itself. This
      // is what protects against duplicate clicks: the next render
      // sees savedToWiki populated and the button reads "Saved" +
      // disables.
      markMessageSavedToWiki(messageId, filePath)

      // Full auto-ingest. We DON'T await — autoIngest is heavy and
      // we want the user back to chatting immediately. State updates
      // ride through chat-store, so the button + summary card update
      // in place as ingest progresses / finishes. Reuses the
      // `llmConfig` captured at the start of this try block (above
      // wikify pass) — re-fetching the store here would double up.
      if (hasUsableLlm(llmConfig)) {
        setMessageIngestState(messageId, { state: "running" })
        const { autoIngest } = await import("@/lib/ingest")
        autoIngest(pp, filePath, llmConfig)
          .then((pages) => {
            setMessageIngestState(messageId, { state: "done", pages })
          })
          .catch((err) => {
            console.error("Failed to auto-ingest saved query:", err)
            setMessageIngestState(messageId, {
              state: "failed",
              error: err instanceof Error ? err.message : String(err),
            })
          })
      }
    } catch (err) {
      console.error("Failed to save to wiki:", err)
    } finally {
      setSaving(false)
    }
  }, [
    project,
    content,
    saving,
    isSaved,
    messageId,
    markMessageSavedToWiki,
    setMessageIngestState,
    setFileTree,
  ])

  if (!visible && !isSaved) return null

  const ingest = savedToWiki?.ingest
  const buttonLabel = !isSaved
    ? saving
      ? "Saving..."
      : "Save to Wiki"
    : !ingest
      ? "Saved"
      : ingest.state === "running"
        ? "Saved · ingesting…"
        : ingest.state === "done"
          ? `Saved · ${ingest.pages.length} page${ingest.pages.length === 1 ? "" : "s"}`
          : "Saved · ingest failed"

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || isSaved}
        className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        title={
          ingest?.state === "failed"
            ? `Save OK but ingest failed: ${ingest.error}`
            : isSaved && savedToWiki
              ? `Already saved to ${savedToWiki.path}`
              : "Save to wiki"
        }
      >
        <BookmarkPlus className="h-3 w-3" />
        {buttonLabel}
      </button>
      {isSaved && ingest?.state === "done" && ingest.pages.length > 0 && (
        <SavedIngestSummary pages={ingest.pages} />
      )}
    </div>
  )
}

/**
 * Inline summary listing the wiki pages autoIngest generated from the
 * saved chat reply. Click-to-expand keeps the bar tight by default;
 * the user clicks once to see exactly what concepts/entities landed.
 */
function SavedIngestSummary({ pages }: { pages: string[] }) {
  const [open, setOpen] = useState(false)
  if (pages.length === 0) return null
  return (
    <div className="rounded-md border border-emerald-300/60 bg-emerald-50/60 dark:border-emerald-800/60 dark:bg-emerald-950/30 px-2 py-1 text-[10px] text-emerald-700 dark:text-emerald-400">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        <span>
          ✨ {pages.length} wiki page{pages.length === 1 ? "" : "s"} created from this reply
        </span>
        <span className="text-[9px]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono">
          {pages.slice(0, 12).map((p) => (
            <li key={p} className="truncate">· {p}</li>
          ))}
          {pages.length > 12 && (
            <li className="text-emerald-600/70 dark:text-emerald-400/70">
              … and {pages.length - 12} more
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

interface CitedPage {
  title: string
  path: string
}

const REF_TYPE_CONFIG: Record<string, { icon: typeof FileText; color: string }> = {
  entity: { icon: Users, color: "text-blue-500" },
  concept: { icon: Lightbulb, color: "text-purple-500" },
  source: { icon: BookOpen, color: "text-orange-500" },
  query: { icon: HelpCircle, color: "text-green-500" },
  synthesis: { icon: GitMerge, color: "text-red-500" },
  comparison: { icon: BarChart3, color: "text-teal-500" },
  finding: { icon: TrendingUp, color: "text-purple-500" },
  thesis: { icon: Target, color: "text-rose-500" },
  methodology: { icon: BookOpen, color: "text-teal-500" },
  overview: { icon: Layout, color: "text-yellow-500" },
  clip: { icon: Globe, color: "text-blue-400" },
}

function getRefType(path: string): string {
  if (path.includes("raw/sources/")) return "clip"
  return inferWikiTypeFromPath(path) ?? "source"
}

/**
 * Markdown image-reference regex used to count `![](url)` occurrences
 * in cited pages AND extract the first URL (so the image-badge
 * jump button knows where to send the user). Same shape as the
 * search/pipeline regex elsewhere (kept duplicated to avoid
 * coupling — this module never wants to pull caption-pipeline
 * imports for a 3-character count).
 *
 * Group 1 captures the URL (everything inside `(...)` of the
 * markdown image syntax, no whitespace).
 */
const CITED_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

interface CitedImageInfo {
  count: number
  /** First image URL on the page — used as the scroll target when
   *  the badge button opens the raw source. Null when count===0. */
  firstUrl: string | null
}

function CitedReferencesPanel({ content, savedReferences }: { content: string; savedReferences?: CitedPage[] }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const [expanded, setExpanded] = useState(false)
  /**
   * Per-cited-page image info: count + first image URL. We can't
   * hang this off `CitedPage` directly because `extractCitedPages`
   * is sync and works on the AI's text response, never seeing the
   * underlying page. So we fetch the page contents lazily here.
   * Same path → same info, so a tiny in-component map keyed by
   * path is plenty.
   */
  const [imageInfos, setImageInfos] = useState<Record<string, CitedImageInfo>>({})

  // Use saved references first (persisted with message), fall back to dynamic extraction
  const citedPages = useMemo(() => {
    if (savedReferences && savedReferences.length > 0) return savedReferences
    return extractCitedPages(content)
  }, [content, savedReferences])

  // Async-fetch each cited page's content once and extract image
  // info: count + first URL. Done in parallel; failures are
  // silently treated as { count: 0, firstUrl: null } (page may
  // not exist on disk yet, e.g. a citation the LLM hallucinated).
  useEffect(() => {
    if (!project || citedPages.length === 0) return
    const pp = normalizePath(project.path)
    let cancelled = false
    Promise.all(
      citedPages.map(async (page) => {
        // Try the path verbatim first, then the same fallback set
        // the click-handler uses below — keeps "is the file on
        // disk" check consistent across the panel.
        const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
        const candidates = [
          `${pp}/${page.path}`,
          `${pp}/wiki/entities/${id}.md`,
          `${pp}/wiki/concepts/${id}.md`,
          `${pp}/wiki/sources/${id}.md`,
          `${pp}/wiki/queries/${id}.md`,
          `${pp}/wiki/synthesis/${id}.md`,
          `${pp}/wiki/comparisons/${id}.md`,
          `${pp}/wiki/${id}.md`,
        ]
        for (const candidate of candidates) {
          try {
            const text = await readFile(candidate)
            // Reset stateful regex.lastIndex by `new RegExp(...)` —
            // module-level `g` regexes carry state across calls
            // and would skip matches on the second invocation.
            const re = new RegExp(CITED_IMAGE_RE.source, CITED_IMAGE_RE.flags)
            const matches = [...text.matchAll(re)]
            const info: CitedImageInfo = {
              count: matches.length,
              firstUrl: matches.length > 0 ? matches[0][1] : null,
            }
            return [page.path, info] as const
          } catch {
            // try next candidate
          }
        }
        return [page.path, { count: 0, firstUrl: null }] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      const next: Record<string, CitedImageInfo> = {}
      for (const [path, info] of entries) next[path] = info
      setImageInfos(next)
    })
    return () => {
      cancelled = true
    }
  }, [project, citedPages])

  /**
   * Open the raw source file for a page's first image and stage a
   * scroll target so the markdown preview lands on that image.
   * Mirrors the lightbox "Jump to source document" path in
   * search-view — same `findRawSourceForImage` resolver, same
   * `pendingScrollImageSrc` store handoff, same fallback to
   * opening the wiki page when no raw source is found.
   */
  const handleJumpToImageSource = useCallback(
    async (firstUrl: string, fallbackPath: string) => {
      if (!project) return
      const pp = normalizePath(project.path)
      const rawPath = await findRawSourceForImage(firstUrl, pp)
      if (rawPath) {
        try {
          const content = await readFile(rawPath)
          setPendingScrollImageSrc(imageUrlToAbsolute(firstUrl, pp))
          setSelectedFile(rawPath)
          setFileContent(content)
          console.log(`[refs:image-jump] ${firstUrl} → raw source ${rawPath}`)
          return
        } catch (err) {
          console.warn(`[refs:image-jump] failed to read ${rawPath}:`, err)
        }
      }
      // Fallback: open the wiki summary itself with same scroll
      // target — at least the safety-net section will scroll into
      // view there.
      try {
        const content = await readFile(`${pp}/${fallbackPath}`)
        setPendingScrollImageSrc(firstUrl)
        setSelectedFile(`${pp}/${fallbackPath}`)
        setFileContent(content)
      } catch (err) {
        console.warn(`[refs:image-jump] fallback also failed:`, err)
      }
    },
    [project, setPendingScrollImageSrc, setSelectedFile, setFileContent],
  )

  if (citedPages.length === 0) return null

  const MAX_COLLAPSED = 3
  const visiblePages = expanded ? citedPages : citedPages.slice(0, MAX_COLLAPSED)
  const hasMore = citedPages.length > MAX_COLLAPSED

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-xs mb-1">
      <button
        type="button"
        onClick={() => hasMore && setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <FileText className="h-3 w-3 shrink-0" />
        <span className="font-medium">References ({citedPages.length})</span>
        {hasMore && (
          expanded
            ? <ChevronDown className="h-3 w-3 ml-auto" />
            : <ChevronRight className="h-3 w-3 ml-auto" />
        )}
      </button>
      <div className="px-2 pb-1.5">
        {visiblePages.map((page, i) => {
          const refType = getRefType(page.path)
          const config = REF_TYPE_CONFIG[refType] ?? REF_TYPE_CONFIG.source
          const Icon = config.icon
          const info = imageInfos[page.path]
          const hasImages = (info?.count ?? 0) > 0
          const openCitedPage = async () => {
            if (!project) return
            const pp = normalizePath(project.path)
            const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
            const candidates = [
              `${pp}/${page.path}`,
              `${pp}/wiki/entities/${id}.md`,
              `${pp}/wiki/concepts/${id}.md`,
              `${pp}/wiki/sources/${id}.md`,
              `${pp}/wiki/queries/${id}.md`,
              `${pp}/wiki/synthesis/${id}.md`,
              `${pp}/wiki/comparisons/${id}.md`,
              `${pp}/wiki/${id}.md`,
            ]
            for (const candidate of candidates) {
              try {
                await readFile(candidate)
                setSelectedFile(candidate)
                return
              } catch {
                // try next
              }
            }
            setSelectedFile(`${pp}/${page.path}`)
          }
          return (
            // Outer is a div, NOT a button — we have two click
            // targets inside (image badge + main row) and nesting
            // a button inside a button is invalid HTML and breaks
            // event delegation. Hover effect shifts to the inner
            // buttons individually so each gives feedback.
            <div
              key={page.path}
              className="flex w-full items-center gap-1.5 rounded text-left"
              title={page.path}
            >
              <span className="text-[10px] text-muted-foreground/60 w-4 shrink-0 text-right">[{i + 1}]</span>
              {/*
               * Image badge — clickable, separately from the page
               * row. Click → resolve the FIRST image's raw source
               * (`raw/sources/<slug>.<ext>`) and open the FULL
               * combined-extraction preview, scrolled to that
               * image. This mirrors the search-view lightbox
               * "Jump to source document" behavior so the two
               * surfaces feel consistent.
               *
               * Icon: lucide `Image` (picture-frame outline with
               * mountain + sun) — direct visual cue for "image",
               * NOT `Camera` which reads as "take a photo".
               */}
              {hasImages && info?.firstUrl && (
                <button
                  type="button"
                  onClick={() => handleJumpToImageSource(info.firstUrl!, page.path)}
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100/40 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors"
                  title={`Open original document at first image (${info.count} image${info.count === 1 ? "" : "s"} on this page)`}
                >
                  <ImageIcon className="h-3 w-3" />
                  {info.count}
                </button>
              )}
              <button
                type="button"
                onClick={openCitedPage}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/50 transition-colors"
              >
                <Icon className={`h-3 w-3 shrink-0 ${config.color}`} />
                <span className="truncate text-foreground/80">{page.title}</span>
              </button>
            </div>
          )
        })}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-center text-[10px] text-muted-foreground hover:text-primary pt-0.5"
          >
            +{citedPages.length - MAX_COLLAPSED} more...
          </button>
        )}
      </div>
    </div>
  )
}


/**
 * Extract cited wiki pages from the hidden <!-- cited: 1, 3, 5 --> comment.
 * Maps page numbers back to the pages that were sent to the LLM.
 */
function extractCitedPages(text: string): CitedPage[] {
  const citedMatch = text.match(/<!--\s*cited:\s*(.+?)\s*-->/)
  if (citedMatch && lastQueryPages.length > 0) {
    const numbers = citedMatch[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= lastQueryPages.length)

    const pages = numbers.map((n) => lastQueryPages[n - 1])
    if (pages.length > 0) return pages
  }

  // Fallback: if LLM used [1], [2] notation in text, try to match those
  if (lastQueryPages.length > 0) {
    const numberRefs = text.match(/\[(\d+)\]/g)
    if (numberRefs) {
      const numbers = [...new Set(numberRefs.map((r) => parseInt(r.slice(1, -1), 10)))]
        .filter((n) => n >= 1 && n <= lastQueryPages.length)
      if (numbers.length > 0) {
        return numbers.map((n) => lastQueryPages[n - 1])
      }
    }
  }

  // Fallback for persisted messages: extract [[wikilinks]] from the text
  // Try to resolve each wikilink to a real file path by checking common wiki subdirectories
  const wikilinks = text.match(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)
  if (wikilinks) {
    const seen = new Set<string>()
    const pages: CitedPage[] = []
    const WIKI_DIRS = ["entities", "concepts", "sources", "queries", "synthesis", "comparisons"]

    for (const link of wikilinks) {
      const nameMatch = link.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/)
      if (nameMatch) {
        const id = nameMatch[1].trim()
        const display = nameMatch[2]?.trim() || id

        // Skip if id contains path separators (already a path like queries/xxx)
        if (seen.has(id)) continue
        seen.add(id)

        // Try to find the file in known wiki subdirectories
        let resolvedPath = ""
        if (id.includes("/")) {
          // Already has directory like "queries/my-query"
          resolvedPath = `wiki/${id}.md`
        } else {
          // Search in common directories
          for (const dir of WIKI_DIRS) {
            resolvedPath = `wiki/${dir}/${id}.md`
            // We can't do async file checking here, so try all known patterns
            // The click handler will try multiple paths
            break // Use first candidate, click handler resolves the rest
          }
          if (!resolvedPath) resolvedPath = `wiki/${id}.md`
        }

        pages.push({ title: display, path: resolvedPath })
      }
    }
    if (pages.length > 0) return pages
  }

  // No citations found
  return []
}

interface StreamingMessageProps {
  content: string
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  const { thinking, answer } = useMemo(() => separateThinking(content), [content])
  const isThinking = thinking !== null && answer.length === 0

  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        {isThinking ? (
          <StreamingThinkingBlock content={thinking} />
        ) : (
          <>
            {thinking && <ThinkingBlock content={thinking} />}
            <MarkdownContent content={answer} />
            <span className="animate-pulse">▊</span>
          </>
        )}
      </div>
    </div>
  )
}

// ── Proposed wiki edits surfaced from the chat answer ─────────────
// When the assistant proposes a wiki correction it emits a FILE block
// (apply to an existing page) or, when unsure which page, a REVIEW block
// (route to the manual review queue). We render those as actionable
// cards instead of letting the raw block show as text.

interface ProposedReview { kind: string; title: string; body: string }

function parseProposedReviews(content: string): ProposedReview[] {
  const re = /---REVIEW:\s*([\w-]+)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g
  const out: ProposedReview[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    out.push({ kind: m[1].trim(), title: m[2].trim(), body: m[3].trim() })
  }
  return out
}

function ProposedEdits({ content }: { content: string }) {
  const fileBlocks = useMemo(
    () => parseFileBlocks(content).blocks.filter((b) => /^wiki\/.+\.md$/i.test(b.path) && isSafeIngestPath(b.path)),
    [content],
  )
  const reviews = useMemo(() => parseProposedReviews(content), [content])
  if (fileBlocks.length === 0 && reviews.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {fileBlocks.map((b, i) => (
        <EditCard key={`edit-${i}`} path={b.path} newContent={b.content} />
      ))}
      {reviews.map((r, i) => (
        <ReviewSuggestionCard key={`rev-${i}`} kind={r.kind} title={r.title} body={r.body} />
      ))}
    </div>
  )
}

function EditCard({ path, newContent }: { path: string; newContent: string }) {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [oldContent, setOldContent] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [status, setStatus] = useState<"idle" | "applying" | "applied" | "error">("idle")
  const [errorMsg, setErrorMsg] = useState("")

  const pp = project ? normalizePath(project.path) : ""
  const fullPath = pp ? `${pp}/${path}` : ""

  useEffect(() => {
    let cancelled = false
    if (!fullPath) return
    readFile(fullPath)
      .then((c) => { if (!cancelled) setOldContent(c) })
      .catch(() => { if (!cancelled) setOldContent(null) })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [fullPath])

  const isNew = loaded && oldContent === null
  const diff = useMemo(
    () => (oldContent !== null ? diffLines(oldContent, newContent) : null),
    [oldContent, newContent],
  )
  const stats = useMemo(() => (diff ? diffStats(diff) : null), [diff])
  const unchanged = oldContent !== null && isUnchanged(oldContent, newContent)

  const handleApply = useCallback(async () => {
    if (!project || status === "applying" || status === "applied") return
    setStatus("applying")
    try {
      await applyPageEdit(project.path, path, newContent)
      // Refresh the tree + dependent views, and the open preview if this
      // is the page being viewed.
      try {
        const tree = await listDirectory(pp)
        useWikiStore.getState().setFileTree(tree)
      } catch { /* ignore */ }
      useWikiStore.getState().bumpDataVersion()
      if (selectedFile && normalizePath(selectedFile) === normalizePath(fullPath)) {
        useWikiStore.getState().setFileContent(newContent)
      }
      setStatus("applied")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }, [project, status, path, newContent, pp, selectedFile, fullPath])

  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/30 p-2 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap">
        <GitMerge className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="font-medium text-foreground">
          {isNew ? "Proposed new page" : "Proposed edit"}
        </span>
        <code className="rounded bg-muted px-1 py-0.5 text-[10px] break-all">{path}</code>
        {stats && (
          <span className="text-[10px] text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{stats.removed}</span>
          </span>
        )}
      </div>

      {unchanged ? (
        <p className="mt-1 text-muted-foreground">No changes — the proposed content matches the current page.</p>
      ) : (
        <>
          <div className="mt-1.5 flex items-center gap-2">
            {!isNew && diff && (
              <button
                type="button"
                onClick={() => setShowDiff((v) => !v)}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary"
              >
                {showDiff ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showDiff ? "Hide diff" : "Show diff"}
              </button>
            )}
            <button
              type="button"
              onClick={handleApply}
              disabled={status === "applying" || status === "applied" || !loaded}
              className="inline-flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-60"
              title={isNew ? "Create this page" : "Back up the current page and apply this edit"}
            >
              {status === "applied" ? <Check className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              {status === "applied"
                ? "Applied"
                : status === "applying"
                  ? "Applying…"
                  : isNew
                    ? "Create page"
                    : "Apply edit"}
            </button>
            {!isNew && status !== "applied" && (
              <span className="text-[10px] text-muted-foreground">a backup is saved first</span>
            )}
          </div>

          {showDiff && diff && (
            <pre className="mt-1.5 max-h-72 overflow-auto rounded bg-background/70 p-2 font-mono text-[11px] leading-snug">
              {diff.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === "add"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : line.type === "del"
                        ? "bg-red-500/10 text-red-700 dark:text-red-300"
                        : "text-muted-foreground"
                  }
                >
                  <span className="select-none opacity-60">{line.type === "add" ? "+ " : line.type === "del" ? "− " : "  "}</span>
                  {line.text || " "}
                </div>
              ))}
            </pre>
          )}

          {status === "error" && (
            <p className="mt-1 text-red-600 dark:text-red-400">Apply failed: {errorMsg}</p>
          )}
        </>
      )}
    </div>
  )
}

function ReviewSuggestionCard({ kind, title, body }: { kind: string; title: string; body: string }) {
  const [sent, setSent] = useState(false)
  const handleSend = useCallback(() => {
    const type = (["contradiction", "duplicate", "missing-page", "confirm", "suggestion"].includes(kind)
      ? kind
      : "suggestion") as "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion"
    useReviewStore.getState().addItem({
      type,
      title: title || "Suggested wiki change",
      description: body,
      options: [{ label: "Mark handled", action: "ack" }],
    })
    setSent(true)
  }, [kind, title, body])

  return (
    <div className="rounded-md border border-sky-300/60 bg-sky-50/60 dark:border-sky-800/60 dark:bg-sky-950/30 p-2 text-xs">
      <div className="flex items-center gap-1.5">
        <HelpCircle className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
        <span className="font-medium text-foreground">Suggested change (needs review)</span>
      </div>
      {title && <p className="mt-1 font-medium text-foreground">{title}</p>}
      {body && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{body}</p>}
      <button
        type="button"
        onClick={handleSend}
        disabled={sent}
        className="mt-1.5 inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-60"
      >
        {sent ? <Check className="h-3 w-3" /> : <BookmarkPlus className="h-3 w-3" />}
        {sent ? "Sent to Review" : "Send to Review"}
      </button>
    </div>
  )
}

function MarkdownContent({ content }: { content: string }) {
  // Strip hidden comments and any proposed-edit FILE/REVIEW blocks — those
  // are rendered separately as Apply/Review cards (see ProposedEdits), not
  // as raw markdown. The trailing-open variants keep a half-streamed block
  // from flashing as plain text mid-response.
  const cleaned = content
    .replace(/<!--.*?-->/gs, "")
    .replace(/---FILE:[\s\S]*?---END FILE---/g, "")
    .replace(/---REVIEW:[\s\S]*?---END REVIEW---/g, "")
    .replace(/---FILE:[\s\S]*$/g, "")
    .replace(/---REVIEW:[\s\S]*$/g, "")
    .trimEnd()

  // Project path for resolving wiki-relative image src in chat
  // replies (LLM may surface images that came in via retrieved
  // chunks, e.g. when the chat answer cites a diagram from a wiki
  // page). Same convention the file-preview uses.
  const projectPath = useWikiStore((s) => s.project?.path ?? null)

  // Separate thinking blocks from main content
  const { thinking, answer } = useMemo(() => separateThinking(cleaned), [cleaned])
  const processed = useMemo(() => processContent(answer), [answer])
  const renderLanguage = useMemo(() => detectLanguage(answer), [answer])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)

  return (
    <div>
      {thinking && <ThinkingBlock content={thinking} />}
      <div
        className="chat-markdown prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none"
        dir={direction}
        lang={htmlLang}
        style={{ textAlign: "start" }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            a: ({ href, children }) => {
              if (href?.startsWith("wikilink:")) {
                const pageName = href.slice("wikilink:".length)
                return <WikiLink pageName={pageName}>{children}</WikiLink>
              }
              return (
                <span className="text-primary underline cursor-default" title={href}>
                  {children}
                </span>
              )
            },
            img: ({ src, alt, ...props }) => (
              <img
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
                alt={alt ?? ""}
                className="my-2 max-w-full rounded border border-border/40"
                loading="lazy"
                {...props}
              />
            ),
            table: ({ children, ...props }) => (
              <div className="my-2 overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-xs" {...props}>{children}</table>
              </div>
            ),
            thead: ({ children, ...props }) => (
              <thead className="bg-muted" {...props}>{children}</thead>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-border/80 px-3 py-1.5 text-start font-semibold bg-muted" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-border/60 px-3 py-1.5" {...props}>{children}</td>
            ),
            pre: ({ children, ...props }) => {
              const mermaid = unwrapMermaidPre(children)
              if (mermaid) return <>{mermaid}</>
              return (
                <pre
                  dir="ltr"
                  className="rounded bg-background/50 p-2 text-xs overflow-x-auto"
                  style={{ textAlign: "left" }}
                  {...props}
                >
                  {children}
                </pre>
              )
            },
            code: ({ className, children, ...props }) => {
              const lang = className?.replace("language-", "")
              const codeText = String(children).replace(/\n$/, "")
              if (lang === "mermaid") {
                return <MermaidDiagram code={codeText} />
              }
              return <code dir="ltr" className={className} {...props}>{children}</code>
            },
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>
    </div>
  )
}

/**
 * Separate <think>...</think> blocks from the main answer.
 * Handles multiple think blocks and partial (unclosed) thinking during streaming.
 */
function separateThinking(text: string): { thinking: string | null; answer: string } {
  // Match complete <think>...</think> and <thinking>...</thinking> blocks
  const thinkRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi
  const thinkParts: string[] = []
  let answer = text

  let match: RegExpExecArray | null
  while ((match = thinkRegex.exec(text)) !== null) {
    thinkParts.push(match[1].trim())
  }
  answer = answer.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim()

  // Handle unclosed <think> or <thinking> tag (streaming in progress)
  const unclosedMatch = answer.match(/<think(?:ing)?>([\s\S]*)$/i)
  if (unclosedMatch) {
    thinkParts.push(unclosedMatch[1].trim())
    answer = answer.replace(/<think(?:ing)?>[\s\S]*$/i, "").trim()
  }

  const thinking = thinkParts.length > 0 ? thinkParts.join("\n\n") : null
  return { thinking, answer }
}

/** Streaming thinking: shows latest ~5 lines rolling upward with animation */
function StreamingThinkingBlock({ content }: { content: string }) {
  const lines = content.split("\n").filter((l) => l.trim())
  const visibleLines = lines.slice(-5)

  return (
    <div className="rounded-md border border-dashed border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm animate-pulse">💭</span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Thinking...</span>
        <span className="text-[10px] text-amber-600 dark:text-amber-400/50 dark:text-amber-500/40">{lines.length} lines</span>
      </div>
      <div className="h-[5lh] overflow-hidden text-xs text-amber-800 dark:text-amber-200/70 dark:text-amber-300/60 font-mono leading-relaxed">
        {visibleLines.map((line, i) => (
          <div
            key={lines.length - 5 + i}
            className="truncate"
            style={{ opacity: 0.4 + (i / visibleLines.length) * 0.6 }}
          >
            {line}
          </div>
        ))}
        <span className="animate-pulse text-amber-500">▊</span>
      </div>
    </div>
  )
}

/** Completed thinking: collapsed by default, click to expand */
function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split("\n").filter((l) => l.trim())

  return (
    <div className="mb-2 rounded-md border border-dashed border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-colors"
      >
        <span className="text-sm">💭</span>
        <span className="font-medium">Thought for {lines.length} lines</span>
        <span className="text-amber-600 dark:text-amber-400/60 dark:text-amber-500/60">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-amber-500/20 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200/80 dark:text-amber-300/70 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
          {content}
        </div>
      )}
    </div>
  )
}

/**
 * Process content to create clickable links:
 * - [[wikilinks]] → markdown links with wikilink: protocol
 */
function processContent(text: string): string {
  let result = text

  // Wrap bare \begin{...}...\end{...} blocks with $$ for remark-math
  result = result.replace(
    /(?<!\$\$\s*)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\s*\$\$)/g,
    (_match, block: string) => `$$\n${block}\n$$`,
  )

  // Only apply Unicode conversion to text outside of math delimiters
  // Split on $$...$$ and $...$ blocks, only convert non-math parts
  const parts = result.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g)
  result = parts
    .map((part) => {
      if (part.startsWith("$")) return part // preserve math
      return convertLatexToUnicode(part)
    })
    .join("")

  // Fix malformed wikilinks like [[name] (missing closing bracket)
  result = result.replace(/\[\[([^\]]+)\](?!\])/g, "[[$1]]")

  // Convert [[wikilinks]] to markdown links
  result = result.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )

  return result
}

function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [exists, setExists] = useState<boolean | null>(null)
  const resolvedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/entities/${pageName}.md`,
      `${pp}/wiki/concepts/${pageName}.md`,
      `${pp}/wiki/sources/${pageName}.md`,
      `${pp}/wiki/queries/${pageName}.md`,
      `${pp}/wiki/comparisons/${pageName}.md`,
      `${pp}/wiki/synthesis/${pageName}.md`,
      `${pp}/wiki/${pageName}.md`,
    ]

    let cancelled = false
    async function check() {
      for (const path of candidates) {
        try {
          await readFile(path)
          if (!cancelled) {
            resolvedPath.current = path
            setExists(true)
          }
          return
        } catch {
          // try next
        }
      }
      if (!cancelled) setExists(false)
    }
    check()
    return () => { cancelled = true }
  }, [project, pageName])

  const handleClick = useCallback(async () => {
    if (!resolvedPath.current) return
    try {
      const content = await readFile(resolvedPath.current)
      setSelectedFile(resolvedPath.current)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // ignore
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  if (exists === false) {
    return (
      <span className="inline text-muted-foreground" title={`Page not found: ${pageName}`}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-primary underline decoration-primary/30 hover:bg-primary/10 hover:decoration-primary"
      title={`Open wiki page: ${pageName}`}
    >
      <FileText className="inline h-3 w-3" />
      {children}
    </button>
  )
}
