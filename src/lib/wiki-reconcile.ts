/**
 * wiki-reconcile — mechanical cleanup of dangling references.
 *
 * Karpathy-frame motivation: the wiki is the LLM's memory. Memory
 * decays over time as pages are renamed, deleted, refactored, or
 * imported with hand-typed wikilinks that never get a matching page.
 * The downstream effect: lint reports balloon (we saw 84+ broken-link
 * findings on a single project), graph search hits dead ends,
 * `related:` arrays drift from reality.
 *
 * `reconcileWiki` is the **non-LLM** garbage-collection pass. It
 * makes a small set of mechanical, lossless edits:
 *
 *   1. Broken `[[X]]` wikilinks  →  replace with plain text "X"
 *      (preserve the alias if the link was `[[X|alias]]` — we keep
 *      the displayed text, just drop the wikilink syntax).
 *
 *   2. Broken `related:` array entries  →  remove only the dangling
 *      slugs, leave the rest of the array intact.
 *
 *   3. `index.md` lines whose `[[target]]` points at a non-existent
 *      page  →  drop those lines. Other lines (headings, prose,
 *      user-curated content) are preserved verbatim.
 *
 * What it does NOT do (deliberately):
 *
 *   - It never deletes page bodies, never touches `created:`/`updated:`,
 *     never restructures the wiki.
 *   - It never creates new pages — if a wikilink target should exist,
 *     that's a job for the AI lint-fix flow (which can write stubs).
 *   - It never edits files under `sources/`, `raw/`, `queries/`, or
 *     the `.llm-wiki` trees — those are raw/scratch areas, source-of-
 *     truth preserved for re-ingest. (The wikilink resolver still
 *     INCLUDES queries/ pages as valid targets — the user might write
 *     `[[queries/my-question]]` from a knowledge page.)
 *
 * Slug resolution uses a fuzzy alias for trailing date suffixes:
 * `claude-code-cli-参考-20260520` is also reachable via the bare slug
 * `claude-code-cli-参考`, because the user (or another LLM) typically
 * writes the wikilink without remembering the timestamp. Without this
 * alias, every SaveToWiki page would generate broken links across the
 * wiki the moment another page referenced its topic.
 *
 * Dry-run mode returns the diff without writing. Real run writes
 * atomically via writeFileAtomic and bumps the lint store afterwards.
 */
import {
  fileExists,
  listDirectory,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import yaml from "js-yaml"

/* ────────────────────────────────────────────────
 * Public surface
 * ────────────────────────────────────────────────*/

export interface ReconcileOpts {
  /** When true, computes the changes but does NOT write to disk. */
  dryRun?: boolean
  /**
   * Path prefixes (wiki-relative) whose files are SKIPPED for editing.
   * Defaults to raw / scratch trees so chat-saved queries and raw
   * source imports never get rewritten by the reconciler.
   */
  skipEditPrefixes?: readonly string[]
}

export interface ReconcileFileChange {
  /** Wiki-relative path of the changed file (e.g. "concepts/foo.md"). */
  slug: string
  /** Count of broken `[[X]]` references rewritten to plain text. */
  brokenWikilinksReplaced: number
  /** Count of `related:` entries removed for missing targets. */
  relatedEntriesRemoved: number
  /** Whether this file ALSO had its index.md row scrubbed (only set
   *  when slug === "index"). */
  indexRowsDropped: number
  /** Count of missing-from-index knowledge pages this run added back
   *  to index.md. Only non-zero on the index.md row of the result. */
  indexRowsAdded: number
  /** Old vs new content snapshot, present only on dry-run so the
   *  caller can preview. Empty in real-run to keep memory low. */
  diffPreview?: { before: string; after: string }
}

export interface ReconcileResult {
  /** How many wiki files were scanned (excluding the skip-edit set). */
  filesScanned: number
  /** Per-file changes (only entries with at least one change). */
  changes: ReconcileFileChange[]
  /** Sum of every changes[i].brokenWikilinksReplaced. */
  totalBrokenWikilinksReplaced: number
  /** Sum of every changes[i].relatedEntriesRemoved. */
  totalRelatedEntriesRemoved: number
  /** Sum of changes[i].indexRowsDropped (typically just index.md). */
  totalIndexRowsDropped: number
  /** Sum of changes[i].indexRowsAdded (typically just index.md). */
  totalIndexRowsAdded: number
  /** True when no real writes happened. */
  dryRun: boolean
}

const DEFAULT_SKIP_EDIT_PREFIXES: ReadonlyArray<string> = [
  "sources/",
  "raw/",
  "queries/",
  ".llm-wiki/",
  ".llm-wiki-local/",
] as const

export async function reconcileWiki(
  projectPath: string,
  opts: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return emptyResult(opts.dryRun === true)
  }

  const dryRun = opts.dryRun === true
  const skipPrefixes = (opts.skipEditPrefixes ?? DEFAULT_SKIP_EDIT_PREFIXES).map(
    (p) => (p.endsWith("/") ? p : p + "/"),
  )

  // Build the slug-resolution map. Includes EVERY wiki page (knowledge
  // + raw + queries) so wikilinks from a knowledge page to e.g.
  // queries/my-question still resolve — only EDITING is restricted by
  // skipPrefixes; resolution is full-corpus.
  const allFiles = flattenMd(tree)
  const slugSet = buildResolutionSet(allFiles, wikiRoot)

  // Pre-scan the knowledge layer to build the "should be in index.md"
  // list. We only auto-add entries for the canonical knowledge types
  // (concept, entity, source, synthesis, finding, comparison) — these
  // are the LLM-generated taxonomy where drift is most painful (the
  // agent creates pages without remembering to update index.md).
  // Notes / reports / etc. live alongside but stay user-curated; an
  // empty section is better than a wrong assumption about where the
  // user wants them listed.
  const indexCandidates = await collectIndexCandidates(allFiles, wikiRoot)

  const changes: ReconcileFileChange[] = []
  let scanned = 0

  for (const file of allFiles) {
    if (file.name === "log.md") continue  // log.md is append-only history
    const slug = relativeToSlug(getRelativePath(file.path, wikiRoot))
    if (isIgnoredForEditing(slug, skipPrefixes)) continue
    scanned += 1

    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    const isIndex = file.name === "index.md" && !slug.includes("/")
    const fileChange = isIndex
      ? rewriteIndexFile(content, slugSet, indexCandidates)
      : rewriteKnowledgeFile(content, slugSet)

    if (fileChange.unchanged) continue

    if (!dryRun && fileExists != null) {
      // Best-effort double-check the file still exists before we
      // rewrite it — protects against the user deleting mid-pass.
      const stillThere = await fileExists(file.path).catch(() => false)
      if (!stillThere) continue
      await writeFileAtomic(file.path, fileChange.next)
    }

    changes.push({
      slug,
      brokenWikilinksReplaced: fileChange.brokenWikilinksReplaced,
      relatedEntriesRemoved: fileChange.relatedEntriesRemoved,
      indexRowsDropped: fileChange.indexRowsDropped,
      indexRowsAdded: fileChange.indexRowsAdded,
      ...(dryRun
        ? { diffPreview: { before: content, after: fileChange.next } }
        : {}),
    })
  }

  // If index.md didn't exist on disk but there are candidates to add,
  // synthesise an empty index pass so the auto-add still runs. This
  // matters for fresh projects where the user has imported a few
  // concept pages but hasn't initialised index.md yet — reconcile
  // shouldn't silently skip just because there's nothing to scrub.
  const sawIndex = allFiles.some(
    (f) => f.name === "index.md" && !relativeToSlug(getRelativePath(f.path, wikiRoot)).includes("/"),
  )
  if (!sawIndex && indexCandidates.length > 0) {
    const synthesised = rewriteIndexFile("", slugSet, indexCandidates)
    if (!synthesised.unchanged) {
      const indexPath = `${wikiRoot}/index.md`
      if (!dryRun) {
        await writeFileAtomic(indexPath, synthesised.next)
      }
      changes.push({
        slug: "index",
        brokenWikilinksReplaced: 0,
        relatedEntriesRemoved: 0,
        indexRowsDropped: 0,
        indexRowsAdded: synthesised.indexRowsAdded,
        ...(dryRun ? { diffPreview: { before: "", after: synthesised.next } } : {}),
      })
    }
  }

  const totals = changes.reduce(
    (acc, c) => ({
      links: acc.links + c.brokenWikilinksReplaced,
      related: acc.related + c.relatedEntriesRemoved,
      indexDropped: acc.indexDropped + c.indexRowsDropped,
      indexAdded: acc.indexAdded + c.indexRowsAdded,
    }),
    { links: 0, related: 0, indexDropped: 0, indexAdded: 0 },
  )

  return {
    filesScanned: scanned,
    changes,
    totalBrokenWikilinksReplaced: totals.links,
    totalRelatedEntriesRemoved: totals.related,
    totalIndexRowsDropped: totals.indexDropped,
    totalIndexRowsAdded: totals.indexAdded,
    dryRun,
  }
}

/* ────────────────────────────────────────────────
 * Slug resolution
 * ────────────────────────────────────────────────*/

/**
 * Strip a trailing `-YYYYMMDD` or `-YYYYMMDD-HHMMSS` suffix. The
 * SaveToWiki / query naming convention appends timestamps to keep
 * same-day saves distinct, but a wikilink from elsewhere usually
 * writes just the topic name. Without aliasing, EVERY SaveToWiki page
 * generates broken-links by design — that's exactly Pattern 2 from
 * the user's wiki audit.
 */
function stripTrailingDateSuffix(slug: string): string | null {
  const m = slug.match(/^(.+?)-(\d{8})(-\d{6})?$/)
  return m ? m[1] : null
}

/**
 * Resolution set: every form a wikilink might use to refer to a real
 * page. Lookups go through `hasSlug(set, link)` which lowercases the
 * needle. Trailing whitespace + `.md` extension are stripped at the
 * call site.
 */
function buildResolutionSet(
  files: FileNode[],
  wikiRoot: string,
): Set<string> {
  const set = new Set<string>()
  for (const f of files) {
    const rel = relativeToSlug(getRelativePath(f.path, wikiRoot))
    if (rel.length === 0) continue
    const lower = rel.toLowerCase()
    set.add(lower)
    // Basename-only alias: [[foo]] resolves regardless of folder.
    const basename = lower.split("/").pop() ?? lower
    set.add(basename)
    // Trailing date suffix alias: foo-20260520 also resolvable as foo.
    const stripped = stripTrailingDateSuffix(basename)
    if (stripped) set.add(stripped)
  }
  return set
}

function hasSlug(set: Set<string>, link: string): boolean {
  const cleaned = link.trim().replace(/\.md$/i, "").toLowerCase()
  if (set.has(cleaned)) return true
  const basename = cleaned.split("/").pop() ?? cleaned
  if (set.has(basename)) return true
  return false
}

/* ────────────────────────────────────────────────
 * Per-file rewriters
 * ────────────────────────────────────────────────*/

interface RewriteResult {
  next: string
  unchanged: boolean
  brokenWikilinksReplaced: number
  relatedEntriesRemoved: number
  indexRowsDropped: number
  indexRowsAdded: number
}

/** Wikilink regex matching `[[target]]` or `[[target|alias]]`. */
const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g

/**
 * Rewrite a knowledge page (any non-index .md outside the skip set).
 * Strips broken wikilinks from the body, drops broken `related:`
 * entries from the frontmatter. Other frontmatter keys + body content
 * are preserved byte-for-byte.
 */
function rewriteKnowledgeFile(
  content: string,
  slugSet: Set<string>,
): RewriteResult {
  const { frontmatter, body } = parseFrontmatter(content)

  // ── body: strip broken wikilinks ─────────────
  let brokenLinks = 0
  const newBody = body.replace(WIKILINK_RE, (_match, target: string, alias?: string) => {
    if (hasSlug(slugSet, target)) {
      // Resolves — keep the link as-is.
      return alias ? `[[${target}|${alias}]]` : `[[${target}]]`
    }
    brokenLinks += 1
    // Replace with plain text. Prefer the displayed alias if present,
    // else the link text itself. Word boundaries preserved.
    return (alias ?? target).trim()
  })

  // ── frontmatter: drop broken related entries ──
  let relatedRemoved = 0
  let newFm: Record<string, unknown> | null = null
  if (frontmatter && typeof frontmatter === "object") {
    const fm = frontmatter as Record<string, unknown>
    if (Array.isArray(fm.related)) {
      const before = (fm.related as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
      const after = before.filter((s) => hasSlug(slugSet, s))
      if (after.length !== before.length) {
        relatedRemoved = before.length - after.length
        newFm = { ...fm }
        if (after.length > 0) newFm.related = after
        else delete newFm.related
      }
    }
  }

  const unchanged = brokenLinks === 0 && relatedRemoved === 0
  if (unchanged) {
    return {
      next: content,
      unchanged: true,
      brokenWikilinksReplaced: 0,
      relatedEntriesRemoved: 0,
      indexRowsDropped: 0,
      indexRowsAdded: 0,
    }
  }

  const next = composeMarkdown(newFm ?? (frontmatter as Record<string, unknown> | null), newBody)
  return {
    next,
    unchanged: false,
    brokenWikilinksReplaced: brokenLinks,
    relatedEntriesRemoved: relatedRemoved,
    indexRowsDropped: 0,
    indexRowsAdded: 0,
  }
}

/**
 * Rewrite `wiki/index.md`. Different semantic from a knowledge page:
 * lines like `- [[concepts/foo]]` are TOC entries, and a broken target
 * means the whole line should disappear (not just the link syntax —
 * keeping the bare topic name as a list bullet would be confusing
 * because it implies a page that doesn't exist).
 *
 * Non-list lines (headings, prose) are preserved verbatim so any
 * user-authored introduction or section dividers survive.
 *
 * Auto-add pass: any knowledge-layer page (concept / entity / source
 * / synthesis / finding / comparison) NOT already linked in the index
 * is appended to its type's section. Section headings are created if
 * absent. This closes the "missing-from-index" half of the drift
 * problem — broken rows are dropped above, missing rows are added
 * here, and the result is fully reconciled.
 */
function rewriteIndexFile(
  content: string,
  slugSet: Set<string>,
  indexCandidates: IndexCandidate[],
): RewriteResult {
  const lines = content.split("\n")
  const kept: string[] = []
  let rowsDropped = 0
  const linkedSlugs = new Set<string>()

  for (const line of lines) {
    // A "TOC row" is a list item containing at least one wikilink.
    // Match `- [[X]]`, `- [[X|alias]]`, `* [[X]]`, with optional
    // leading whitespace.
    const tocMatch = line.match(/^\s*[-*+]\s+\[\[([^\]\n|]+?)(?:\|[^\]\n]+?)?\]\]/)
    if (!tocMatch) {
      kept.push(line)
      continue
    }
    const target = tocMatch[1]
    if (hasSlug(slugSet, target)) {
      kept.push(line)
      // Record what's already linked so auto-add doesn't duplicate.
      // Resolve via the resolution set's basename alias rule so e.g.
      // `[[transformer]]` recognises `concepts/transformer.md`.
      linkedSlugs.add(target.trim().toLowerCase())
      const basename = target.trim().toLowerCase().split("/").pop() ?? ""
      if (basename) linkedSlugs.add(basename)
    } else {
      rowsDropped += 1
      // Line is dropped — DON'T push.
    }
  }

  // Identify candidates not yet linked.
  const missing = indexCandidates.filter((c) => {
    const slug = c.slug.toLowerCase()
    const basename = slug.split("/").pop() ?? slug
    return !linkedSlugs.has(slug) && !linkedSlugs.has(basename)
  })

  if (rowsDropped === 0 && missing.length === 0) {
    return {
      next: content,
      unchanged: true,
      brokenWikilinksReplaced: 0,
      relatedEntriesRemoved: 0,
      indexRowsDropped: 0,
      indexRowsAdded: 0,
    }
  }

  // Phase 1: drop broken rows.
  let body = kept.join("\n")

  // Phase 2: append missing entries to their type's section, creating
  // sections as needed at the end of the file.
  let rowsAdded = 0
  if (missing.length > 0) {
    const byType = new Map<string, IndexCandidate[]>()
    for (const m of missing) {
      const arr = byType.get(m.type) ?? []
      arr.push(m)
      byType.set(m.type, arr)
    }
    for (const [type, entries] of byType) {
      const headingText = INDEX_SECTION_HEADINGS[type] ?? toTitleCase(type)
      const aliasesLower = [
        headingText.toLowerCase(),
        type.toLowerCase(),
        ...(INDEX_SECTION_ALIASES[type]?.map((a) => a.toLowerCase()) ?? []),
      ]
      const bullets = entries.map((e) => formatIndexBullet(e))
      const before = body
      body = insertOrCreateSection(body, headingText, aliasesLower, bullets)
      // Only count rows that actually landed — `insertOrCreateSection`
      // bails when the target section is marked `<!-- manual -->`,
      // returning the input unchanged. Counting those would over-
      // report and trigger a false-positive write in dry-run flows.
      if (body !== before) rowsAdded += entries.length
    }
  }

  // Collapse any consecutive blank lines created by the drops to one
  // blank — keeps the index visually tidy after a heavy cleanup.
  let next = body.replace(/\n{3,}/g, "\n\n")
  if (!next.endsWith("\n")) next += "\n"

  return {
    next,
    unchanged: false,
    brokenWikilinksReplaced: 0,
    relatedEntriesRemoved: 0,
    indexRowsDropped: rowsDropped,
    indexRowsAdded: rowsAdded,
  }
}

/* ────────────────────────────────────────────────
 * Index auto-add — section management
 * ────────────────────────────────────────────────*/

interface IndexCandidate {
  /** Wiki-relative slug (e.g. "concepts/transformer"). */
  slug: string
  /** Frontmatter `type:` from the page (canonical taxonomy slug). */
  type: string
  /** Frontmatter title or filename-derived heading. */
  title: string
}

/**
 * Karpathy-frame principle: index.md is the "addressing layer" / memory
 * map of the wiki. Every page in Storage MUST be reachable via the
 * Index — otherwise the LLM (processor) can't see it exists and starts
 * making duplicate / off-topic decisions ("there's no page on X, I'll
 * write one" when there already is).
 *
 * This means the auto-add pass needs to cover EVERY canonical type,
 * not just the 6 LLM-generated ones. User-curated types (notes,
 * reports, books, …) are also Storage — leaving them off the map
 * breaks the framework.
 *
 * The auto-add still SKIPS:
 *   - `overview` — that's the wiki's framing, not an indexable page
 *   - `other` — escape-hatch type without a natural section
 *   - `query` — chat-saved replies have their own ## Queries flow
 */
const AUTO_INDEX_TYPES: ReadonlySet<string> = new Set([
  // Knowledge layer (LLM-generated)
  "concept", "entity", "source", "synthesis", "finding", "comparison",
  // Single-page everyday types
  "travel-plan", "manual", "project-doc", "tutorial", "book", "recipe",
  "note", "report", "article", "meeting", "decision", "project",
  "film-tv", "music", "game", "menu", "shopping-list", "fitness-plan",
  "contract", "invoice", "medical-record", "insurance",
  "code-snippet", "api-doc", "error-log",
  // Multi-page (decomposable) types
  "paper", "tool", "dataset", "person", "company", "regulation",
  // Research types
  "thesis", "methodology",
])

/** Canonical heading text per type. English plural — predictable and
 *  doesn't churn when UI language toggles. Localised matches happen
 *  via INDEX_SECTION_ALIASES so a hand-authored `## 概念` is
 *  recognised and reused instead of getting a duplicate `## Concepts`. */
const INDEX_SECTION_HEADINGS: Record<string, string> = {
  concept: "Concepts",
  entity: "Entities",
  source: "Sources",
  synthesis: "Synthesis",
  finding: "Findings",
  comparison: "Comparisons",
  "travel-plan": "Travel Plans",
  manual: "Manuals",
  "project-doc": "Project Documents",
  tutorial: "Tutorials",
  book: "Books",
  recipe: "Recipes",
  note: "Notes",
  report: "Reports",
  article: "Articles",
  meeting: "Meetings",
  decision: "Decisions",
  project: "Projects",
  "film-tv": "Film & TV",
  music: "Music",
  game: "Games",
  menu: "Menus",
  "shopping-list": "Shopping Lists",
  "fitness-plan": "Fitness Plans",
  contract: "Contracts",
  invoice: "Invoices",
  "medical-record": "Medical Records",
  insurance: "Insurance",
  "code-snippet": "Code Snippets",
  "api-doc": "API Docs",
  "error-log": "Error Logs",
  paper: "Papers",
  tool: "Tools",
  dataset: "Datasets",
  person: "People",
  company: "Companies",
  regulation: "Regulations",
  thesis: "Theses",
  methodology: "Methodologies",
}

/** Heading aliases — when the existing index uses any of these as a
 *  section heading, that section is treated as the canonical bucket
 *  for the type. Covers English / Chinese / legacy alternatives. */
const INDEX_SECTION_ALIASES: Record<string, string[]> = {
  concept: ["concepts", "概念", "concept"],
  entity: ["entities", "实体", "entity"],
  source: ["sources", "来源", "源", "source", "source documents"],
  synthesis: ["synthesis", "综合", "syntheses"],
  finding: ["findings", "结论", "finding"],
  comparison: ["comparisons", "对比", "comparison"],
  "travel-plan": ["travel plans", "旅游方案", "出行方案", "travel"],
  manual: ["manuals", "用户手册", "手册", "manual"],
  "project-doc": ["project documents", "项目文档", "项目文档", "project docs"],
  tutorial: ["tutorials", "教程", "tutorial"],
  book: ["books", "书籍", "book"],
  recipe: ["recipes", "食谱", "recipe"],
  note: ["notes", "笔记", "note"],
  report: ["reports", "报告", "report"],
  article: ["articles", "文章", "article"],
  meeting: ["meetings", "会议", "meeting"],
  decision: ["decisions", "决策", "decision"],
  project: ["projects", "项目", "project"],
  "film-tv": ["film & tv", "影视", "film-tv", "film and tv"],
  music: ["music", "音乐"],
  game: ["games", "游戏", "game"],
  menu: ["menus", "菜单", "menu"],
  "shopping-list": ["shopping lists", "购物清单", "shopping"],
  "fitness-plan": ["fitness plans", "健身计划", "fitness"],
  contract: ["contracts", "合同", "contract"],
  invoice: ["invoices", "发票", "invoice"],
  "medical-record": ["medical records", "医疗记录", "medical"],
  insurance: ["insurance", "保险", "保险单"],
  "code-snippet": ["code snippets", "代码片段", "snippets"],
  "api-doc": ["api docs", "api文档", "api"],
  "error-log": ["error logs", "错误日志", "errors"],
  paper: ["papers", "论文", "paper"],
  tool: ["tools", "工具", "tool"],
  dataset: ["datasets", "数据集", "dataset"],
  person: ["people", "人物", "persons"],
  company: ["companies", "公司", "company"],
  regulation: ["regulations", "法规", "regulation"],
  thesis: ["theses", "thesis", "论文（thesis）"],
  methodology: ["methodologies", "方法论", "methodology"],
}

/** Maps a frontmatter `type:` value that ISN'T a canonical slug to
 *  the canonical one. Handles old pages where the agent wrote the
 *  Chinese name (`type: 笔记`) before PR #12 enforced canonical
 *  slugs at writePage. */
const TYPE_ALIAS_TO_CANONICAL: Record<string, string> = {}
for (const [canonical, aliases] of Object.entries(INDEX_SECTION_ALIASES)) {
  for (const alias of aliases) {
    TYPE_ALIAS_TO_CANONICAL[alias.toLowerCase()] = canonical
  }
}

/** Maps a folder-name (Chinese or English) to the canonical type.
 *  Used as a fallback when a page's frontmatter `type:` is missing
 *  or unrecognisable — the folder it lives in is a strong signal. */
const FOLDER_TO_CANONICAL_TYPE: Record<string, string> = {}
for (const [canonical, aliases] of Object.entries(INDEX_SECTION_ALIASES)) {
  for (const alias of aliases) {
    FOLDER_TO_CANONICAL_TYPE[alias.toLowerCase()] = canonical
  }
}

/** Section headings the user explicitly marked manual — preserved
 *  verbatim by the rewriter. Detection: trailing `<!-- manual -->`
 *  HTML comment on the heading line. */
const MANUAL_MARKER_RE = /<!--\s*manual\s*-->/i

/**
 * Resolve a page's canonical type from its frontmatter `type:` value
 * and/or its folder. Returns null when no signal lands inside the
 * taxonomy — those pages stay off the index entirely (the caller
 * already excludes structural files like overview.md).
 *
 *   1. Frontmatter type IS canonical → done.
 *   2. Frontmatter type matches a Chinese / legacy alias →
 *      normalise (e.g. `type: 笔记` → `note`).
 *   3. Slug's first folder name matches a known Chinese / English
 *      folder convention → infer (`笔记/foo.md` → `note`).
 *   4. Else: null. Off-taxonomy + uncategorisable.
 */
function resolveCanonicalType(rawType: unknown, slug: string): string | null {
  if (typeof rawType === "string" && rawType.trim().length > 0) {
    const trimmed = rawType.trim()
    if (AUTO_INDEX_TYPES.has(trimmed)) return trimmed
    const aliased = TYPE_ALIAS_TO_CANONICAL[trimmed.toLowerCase()]
    if (aliased && AUTO_INDEX_TYPES.has(aliased)) return aliased
  }
  const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
  if (firstSegment.length === 0) return null
  const inferred = FOLDER_TO_CANONICAL_TYPE[firstSegment]
  if (inferred && AUTO_INDEX_TYPES.has(inferred)) return inferred
  return null
}

function toTitleCase(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatIndexBullet(c: IndexCandidate): string {
  // [[slug|title]] form — title may equal the slug's last segment, in
  // which case we drop the alias for tidiness.
  const lastSegment = c.slug.split("/").pop() ?? c.slug
  if (c.title.trim() === lastSegment) return `- [[${c.slug}]]`
  return `- [[${c.slug}|${c.title}]]`
}

/**
 * Insert `bullets` into the section whose heading text matches one of
 * `aliasesLower` (case-insensitive). If no such section exists, append
 * one with `headingText` at the end of the document.
 *
 * Bullets are inserted at the end of the existing section's list — new
 * pages naturally land below user-curated entries rather than reshuffling
 * existing order.
 */
function insertOrCreateSection(
  content: string,
  headingText: string,
  aliasesLower: string[],
  bullets: string[],
): string {
  if (bullets.length === 0) return content
  const lines = content.split("\n")

  // Find the start line of a matching section (any heading level).
  // Strip an `<!-- manual -->` marker from the heading text BEFORE
  // matching, but if the marker is present, the section is user-
  // managed — bail out without touching it. The bullets won't land
  // anywhere (caller's autoIngest invariant is that the page already
  // exists; the user just opted out of auto-listing).
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/
  let sectionStart = -1
  let sectionLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe)
    if (!m) continue
    const rawText = m[2].trim()
    if (MANUAL_MARKER_RE.test(rawText)) {
      // Strip the marker for alias-matching purposes.
      const stripped = rawText.replace(MANUAL_MARKER_RE, "").trim().toLowerCase()
      if (aliasesLower.includes(stripped)) {
        // User-managed section for this type — leave it alone.
        return content
      }
      continue
    }
    const text = rawText.toLowerCase()
    if (aliasesLower.includes(text)) {
      sectionStart = i
      sectionLevel = m[1].length
      break
    }
  }

  if (sectionStart === -1) {
    // Append a new ## section at the end. Default to level 2 — every
    // hand-written index I've seen uses ## for type groupings.
    const tail = content.endsWith("\n") ? content : content + "\n"
    return (
      tail +
      (content.length === 0 ? "" : "\n") +
      `## ${headingText}\n\n` +
      bullets.join("\n") +
      "\n"
    )
  }

  // Find the end of this section — the next heading at the SAME level
  // or higher (smaller number = higher level). If none, end-of-file.
  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe)
    if (!m) continue
    if (m[1].length <= sectionLevel) {
      sectionEnd = i
      break
    }
  }

  // Find the last non-blank line within the section to insert after.
  // Otherwise insert right after the heading.
  let insertAt = sectionStart + 1
  for (let i = sectionEnd - 1; i > sectionStart; i--) {
    if (lines[i].trim().length > 0) {
      insertAt = i + 1
      break
    }
  }

  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)
  return [...before, ...bullets, ...after].join("\n")
}

/**
 * Walk the wiki tree, read each .md, build the list of auto-index
 * candidates. A candidate is a knowledge-layer page (AUTO_INDEX_TYPES)
 * with a non-empty frontmatter `type:` field. Pages without parseable
 * frontmatter / outside the taxonomy are skipped silently.
 *
 * I/O happens here (not the rewriter) so the rewriter stays pure +
 * unit-testable.
 */
async function collectIndexCandidates(
  files: FileNode[],
  wikiRoot: string,
): Promise<IndexCandidate[]> {
  const candidates: IndexCandidate[] = []
  for (const f of files) {
    if (f.name === "index.md" || f.name === "log.md" || f.name === "purpose.md" || f.name === "schema.md" || f.name === "overview.md") continue
    const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
    if (slug.includes("/")) {
      const top = slug.split("/")[0]
      // Skip ignored folders unconditionally — raw imports, scratch,
      // and chat-saved queries have their own flows.
      if (
        top === "raw" ||
        top === ".llm-wiki" ||
        top === ".llm-wiki-local" ||
        top === "queries" ||
        top === "media"
      ) {
        continue
      }
    }
    let content: string
    try {
      content = await readFile(f.path)
    } catch {
      continue
    }
    const { frontmatter } = parseFrontmatter(content)
    const fm =
      frontmatter && typeof frontmatter === "object"
        ? (frontmatter as Record<string, unknown>)
        : {}

    const canonical = resolveCanonicalType(fm.type, slug)
    if (!canonical) continue
    if (!AUTO_INDEX_TYPES.has(canonical)) continue

    const title =
      typeof fm.title === "string" && fm.title.length > 0
        ? fm.title
        : (slug.split("/").pop() ?? slug)
    candidates.push({ slug, type: canonical, title })
  }
  return candidates
}

/* ────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────*/

function flattenMd(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const n of nodes) {
    if (n.is_dir && n.children) out.push(...flattenMd(n.children))
    else if (!n.is_dir && n.name.toLowerCase().endsWith(".md")) out.push(n)
  }
  return out
}

function relativeToSlug(rel: string): string {
  return rel.replace(/\.md$/i, "")
}

function isIgnoredForEditing(
  slug: string,
  prefixes: readonly string[],
): boolean {
  for (const p of prefixes) {
    if (slug.startsWith(p)) return true
  }
  return false
}

const FRONTMATTER_PRIMARY_KEYS = [
  "type",
  "title",
  "created",
  "updated",
  "tags",
  "related",
  "sources",
] as const

function composeMarkdown(
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "")
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return trimmedBody + "\n"
  }
  // Preserve key order: primary keys first, then anything else
  // verbatim. This matches FileSystemWikiAccess.composeMarkdown so
  // reconciled files don't shuffle frontmatter as a side effect.
  const ordered: Record<string, unknown> = {}
  for (const k of FRONTMATTER_PRIMARY_KEYS) {
    if (k in frontmatter) ordered[k] = frontmatter[k]
  }
  for (const [k, v] of Object.entries(frontmatter)) {
    if (!(k in ordered)) ordered[k] = v
  }
  const yamlBlock = yaml
    .dump(ordered, {
      lineWidth: 1000,
      noRefs: true,
      sortKeys: false,
      schema: yaml.JSON_SCHEMA,
      flowLevel: 1,
    })
    .trimEnd()
  return `---\n${yamlBlock}\n---\n\n${trimmedBody}\n`
}

function emptyResult(dryRun: boolean): ReconcileResult {
  return {
    filesScanned: 0,
    changes: [],
    totalBrokenWikilinksReplaced: 0,
    totalRelatedEntriesRemoved: 0,
    totalIndexRowsDropped: 0,
    totalIndexRowsAdded: 0,
    dryRun,
  }
}
