import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import {
  FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, ChevronRight, ChevronDown, Layout, Globe, Trash2,
  Plane, Wrench, GraduationCap, ChefHat, StickyNote, Newspaper, Clapperboard, Music, Gamepad2,
  UtensilsCrossed, ShoppingCart, Dumbbell, FileSignature, Receipt, HeartPulse, ShieldCheck,
  FileCode, Bug, Database, User, Building2, Scale, FolderKanban, CalendarClock, Plug,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  tags: string[]
  origin?: string
}

// Maps a page's frontmatter `type` (always the english slug, e.g.
// "travel-plan", even when the folder name is Chinese) to a sidebar
// group: an icon, an i18n label key, a color, and a sort order. Covers
// the comprehensive schema's 34 types plus the 7 legacy ones. Anything
// not listed falls through to DEFAULT_CONFIG ("Other") — which is what
// used to swallow every new type before this map was extended.
const TYPE_CONFIG: Record<string, { icon: typeof FileText; labelKey: string; color: string; order: number }> = {
  overview:        { icon: Layout,          labelKey: "knowledgeTree.types.overview",      color: "text-yellow-500",  order: 0 },
  // ── single-page everyday types ──
  "travel-plan":   { icon: Plane,           labelKey: "knowledgeTree.types.travelPlan",    color: "text-sky-500",     order: 10 },
  manual:          { icon: BookOpen,        labelKey: "knowledgeTree.types.manual",        color: "text-orange-500",  order: 11 },
  "project-doc":   { icon: FileText,        labelKey: "knowledgeTree.types.projectDoc",    color: "text-blue-500",    order: 12 },
  tutorial:        { icon: GraduationCap,   labelKey: "knowledgeTree.types.tutorial",      color: "text-indigo-500",  order: 13 },
  book:            { icon: BookOpen,        labelKey: "knowledgeTree.types.book",          color: "text-amber-600",   order: 14 },
  recipe:          { icon: ChefHat,         labelKey: "knowledgeTree.types.recipe",        color: "text-rose-500",    order: 15 },
  note:            { icon: StickyNote,      labelKey: "knowledgeTree.types.note",          color: "text-yellow-600",  order: 16 },
  report:          { icon: FileText,        labelKey: "knowledgeTree.types.report",        color: "text-slate-500",   order: 17 },
  article:         { icon: Newspaper,       labelKey: "knowledgeTree.types.article",       color: "text-teal-500",    order: 18 },
  meeting:         { icon: CalendarClock,   labelKey: "knowledgeTree.types.meeting",       color: "text-cyan-600",    order: 19 },
  decision:        { icon: Scale,           labelKey: "knowledgeTree.types.decision",      color: "text-violet-500",  order: 20 },
  project:         { icon: FolderKanban,    labelKey: "knowledgeTree.types.project",       color: "text-blue-600",    order: 21 },
  "film-tv":       { icon: Clapperboard,    labelKey: "knowledgeTree.types.filmTv",        color: "text-fuchsia-500", order: 22 },
  music:           { icon: Music,           labelKey: "knowledgeTree.types.music",         color: "text-pink-500",    order: 23 },
  game:            { icon: Gamepad2,        labelKey: "knowledgeTree.types.game",          color: "text-green-600",   order: 24 },
  menu:            { icon: UtensilsCrossed, labelKey: "knowledgeTree.types.menu",          color: "text-orange-600",  order: 25 },
  "shopping-list": { icon: ShoppingCart,    labelKey: "knowledgeTree.types.shoppingList",  color: "text-lime-600",    order: 26 },
  "fitness-plan":  { icon: Dumbbell,        labelKey: "knowledgeTree.types.fitnessPlan",   color: "text-red-500",     order: 27 },
  contract:        { icon: FileSignature,   labelKey: "knowledgeTree.types.contract",      color: "text-stone-500",   order: 28 },
  invoice:         { icon: Receipt,         labelKey: "knowledgeTree.types.invoice",       color: "text-emerald-600", order: 29 },
  "medical-record":{ icon: HeartPulse,      labelKey: "knowledgeTree.types.medicalRecord", color: "text-red-600",     order: 30 },
  insurance:       { icon: ShieldCheck,     labelKey: "knowledgeTree.types.insurance",     color: "text-green-700",   order: 31 },
  "code-snippet":  { icon: FileCode,        labelKey: "knowledgeTree.types.codeSnippet",   color: "text-zinc-500",    order: 32 },
  "api-doc":       { icon: Plug,            labelKey: "knowledgeTree.types.apiDoc",        color: "text-cyan-500",    order: 33 },
  "error-log":     { icon: Bug,             labelKey: "knowledgeTree.types.errorLog",      color: "text-red-400",     order: 34 },
  // ── multi-page (decomposable) types ──
  paper:           { icon: FileText,        labelKey: "knowledgeTree.types.paper",         color: "text-orange-500",  order: 40 },
  concept:         { icon: Lightbulb,       labelKey: "knowledgeTree.types.concept",       color: "text-purple-500",  order: 41 },
  tool:            { icon: Wrench,          labelKey: "knowledgeTree.types.tool",          color: "text-slate-600",   order: 42 },
  dataset:         { icon: Database,        labelKey: "knowledgeTree.types.dataset",       color: "text-blue-400",    order: 43 },
  person:          { icon: User,            labelKey: "knowledgeTree.types.person",        color: "text-blue-500",    order: 44 },
  company:         { icon: Building2,       labelKey: "knowledgeTree.types.company",       color: "text-indigo-600",  order: 45 },
  regulation:      { icon: Scale,           labelKey: "knowledgeTree.types.regulation",    color: "text-amber-700",   order: 46 },
  // ── meta + legacy types ──
  synthesis:       { icon: GitMerge,        labelKey: "knowledgeTree.types.synthesis",     color: "text-red-500",     order: 50 },
  comparison:      { icon: BarChart3,       labelKey: "knowledgeTree.types.comparison",    color: "text-emerald-500", order: 51 },
  query:           { icon: HelpCircle,      labelKey: "knowledgeTree.types.query",         color: "text-green-500",   order: 52 },
  source:          { icon: BookOpen,        labelKey: "knowledgeTree.types.source",        color: "text-orange-500",  order: 53 },
  entity:          { icon: Users,           labelKey: "knowledgeTree.types.entity",        color: "text-blue-500",    order: 54 },
}

const DEFAULT_CONFIG = { icon: FileText, labelKey: "knowledgeTree.types.other", color: "text-muted-foreground", order: 99 }

export function KnowledgeTree() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "entity", "concept", "source"]))
  // Two-stage delete: first click arms the row, second click executes.
  // Only one row armed at a time (clicking another row replaces).
  const [armedPath, setArmedPath] = useState<string | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${pp}/wiki`)
      const mdFiles = flattenMdFiles(wikiTree)

      const pageInfos: WikiPageInfo[] = []
      for (const file of mdFiles) {
        // Skip index.md and log.md
        if (file.name === "index.md" || file.name === "log.md") continue
        try {
          const content = await readFile(file.path)
          const info = parsePageInfo(file.path, file.name, content)
          pageInfos.push(info)
        } catch {
          pageInfos.push({
            path: file.path,
            title: file.name.replace(".md", "").replace(/-/g, " "),
            type: "other",
            tags: [],
          })
        }
      }

      setPages(pageInfos)
    } catch {
      setPages([])
    }
  }, [project])

  // Reload when file tree changes (after ingest writes new pages)
  useEffect(() => {
    loadPages()
  }, [loadPages, fileTree])

  const handleDeleteClick = useCallback(
    async (pagePath: string) => {
      if (!project) return
      // First click: arm. Second click on the same row: execute.
      if (armedPath !== pagePath) {
        setArmedPath(pagePath)
        return
      }
      setArmedPath(null)
      setDeletingPath(pagePath)
      try {
        const pp = normalizePath(project.path)
        await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
        // Refresh: page list, file tree, any data-version subscribers.
        await loadPages()
        try {
          const tree = await listDirectory(pp)
          setFileTree(tree)
        } catch {
          // non-critical
        }
        bumpDataVersion()
        if (selectedFile === pagePath) setSelectedFile(null)
      } catch (err) {
        console.error("[KnowledgeTree] delete failed:", err)
        window.alert(`Failed to delete: ${err}`)
      } finally {
        setDeletingPath(null)
      }
    },
    [project, armedPath, loadPages, selectedFile, setSelectedFile, setFileTree, bumpDataVersion],
  )

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("knowledgeTree.noProject", { defaultValue: "No project open" })}
      </div>
    )
  }

  // Group pages by type
  const grouped = new Map<string, WikiPageInfo[]>()
  for (const page of pages) {
    const list = grouped.get(page.type) ?? []
    list.push(page)
    grouped.set(page.type, list)
  }

  // Sort groups by configured order
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const orderA = TYPE_CONFIG[a[0]]?.order ?? DEFAULT_CONFIG.order
    const orderB = TYPE_CONFIG[b[0]]?.order ?? DEFAULT_CONFIG.order
    return orderA - orderB
  })

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>

        {sortedGroups.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t("knowledgeTree.empty", { defaultValue: "No wiki pages yet. Import sources to get started." })}
          </div>
        )}

        {sortedGroups.map(([type, items]) => {
          const config = TYPE_CONFIG[type] ?? DEFAULT_CONFIG
          const Icon = config.icon
          const isExpanded = expandedTypes.has(type)

          return (
            <div key={type} className="mb-1">
              <button
                onClick={() => toggleType(type)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                <span className="flex-1 text-left font-medium">{t(config.labelKey)}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </button>

              {isExpanded && (
                <div className="ml-3">
                  {items.map((page) => {
                    const isSelected = selectedFile === page.path
                    const isArmed = armedPath === page.path
                    const isDeleting = deletingPath === page.path
                    return (
                      <div
                        key={page.path}
                        className={`group flex items-center gap-1 rounded-md ${
                          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        <button
                          onClick={() => setSelectedFile(page.path)}
                          className={`flex flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm min-w-0 ${
                            isSelected
                              ? "text-accent-foreground"
                              : "text-muted-foreground group-hover:text-accent-foreground"
                          }`}
                          title={page.path}
                        >
                          {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                          <span className="truncate">{page.title}</span>
                        </button>
                        <DeleteButton
                          armed={isArmed}
                          deleting={isDeleting}
                          // Visible on hover, when this row is armed,
                          // or while deleting. Other rows fade out so
                          // accidental clicks on a sibling don't pile up.
                          className={`mr-1 transition-opacity ${
                            isArmed || isDeleting
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          }`}
                          onClick={() => void handleDeleteClick(page.path)}
                          name={page.title}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Raw sources quick access */}
        <RawSourcesSection />
      </div>
    </ScrollArea>
  )
}

function RawSourcesSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => setSources(flattenAllFiles(tree)))
      .catch(() => setSources([]))
  }, [project])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">{t("knowledgeTree.rawSources", { defaultValue: "Raw Sources" })}</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function parsePageInfo(path: string, fileName: string, content: string): WikiPageInfo {
  let type = "other"
  let title = fileName.replace(".md", "").replace(/-/g, " ")
  const tags: string[] = []
  let origin: string | undefined

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    if (typeMatch) type = typeMatch[1].trim().toLowerCase()

    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) title = titleMatch[1].trim()

    const tagsMatch = fm.match(/^tags:\s*\[(.+?)\]/m)
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, "")))
    }

    const originMatch = fm.match(/^origin:\s*(.+)$/m)
    if (originMatch) origin = originMatch[1].trim()
  }

  // Fallback: try first heading if no frontmatter title
  if (title === fileName.replace(".md", "").replace(/-/g, " ")) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    if (headingMatch) title = headingMatch[1].trim()
  }

  // Fallback: infer type from path
  if (type === "other") {
    if (path.includes("/entities/")) type = "entity"
    else if (path.includes("/concepts/")) type = "concept"
    else if (path.includes("/sources/")) type = "source"
    else if (path.includes("/queries/")) type = "query"
    else if (path.includes("/comparisons/")) type = "comparison"
    else if (path.includes("/synthesis/")) type = "synthesis"
    else if (fileName === "overview.md") type = "overview"
  }

  return { path, title, type, tags, origin }
}

/**
 * Two-stage delete affordance for a single page row. Default state =
 * subtle ghost trash icon. Armed state = solid red Confirm pill so a
 * second click can't be accidental. Same visual contract as the
 * sources-view DeleteButton — kept inline here rather than shared
 * because the parent owns the armed/deleting/visibility state and
 * extracting would mean lifting four props to a shared module for one
 * extra caller.
 */
function DeleteButton({
  armed,
  deleting,
  onClick,
  name,
  className = "",
}: {
  armed: boolean
  deleting: boolean
  onClick: () => void
  name: string
  className?: string
}) {
  if (deleting) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 shrink-0 cursor-default ${className}`}
        disabled
        title={`Deleting ${name}…`}
      >
        <Trash2 className="h-3 w-3 animate-pulse text-destructive" />
      </Button>
    )
  }
  if (armed) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={`h-6 shrink-0 px-1.5 text-[10px] font-semibold animate-pulse ${className}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        title={`Click again to delete ${name} and clean up references`}
      >
        <Trash2 className="mr-0.5 h-3 w-3" />
        Confirm
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive ${className}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={`Delete ${name} (and clean up references)`}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  )
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
