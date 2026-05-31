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
      ? rewriteIndexFile(content, slugSet)
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
      ...(dryRun
        ? { diffPreview: { before: content, after: fileChange.next } }
        : {}),
    })
  }

  const totals = changes.reduce(
    (acc, c) => ({
      links: acc.links + c.brokenWikilinksReplaced,
      related: acc.related + c.relatedEntriesRemoved,
      index: acc.index + c.indexRowsDropped,
    }),
    { links: 0, related: 0, index: 0 },
  )

  return {
    filesScanned: scanned,
    changes,
    totalBrokenWikilinksReplaced: totals.links,
    totalRelatedEntriesRemoved: totals.related,
    totalIndexRowsDropped: totals.index,
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
    }
  }

  const next = composeMarkdown(newFm ?? (frontmatter as Record<string, unknown> | null), newBody)
  return {
    next,
    unchanged: false,
    brokenWikilinksReplaced: brokenLinks,
    relatedEntriesRemoved: relatedRemoved,
    indexRowsDropped: 0,
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
 */
function rewriteIndexFile(
  content: string,
  slugSet: Set<string>,
): RewriteResult {
  const lines = content.split("\n")
  const kept: string[] = []
  let rowsDropped = 0

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
    } else {
      rowsDropped += 1
      // Line is dropped — DON'T push.
    }
  }

  if (rowsDropped === 0) {
    return {
      next: content,
      unchanged: true,
      brokenWikilinksReplaced: 0,
      relatedEntriesRemoved: 0,
      indexRowsDropped: 0,
    }
  }

  // Collapse any consecutive blank lines created by the drops to one
  // blank — keeps the index visually tidy after a heavy cleanup.
  let next = kept.join("\n").replace(/\n{3,}/g, "\n\n")
  if (!next.endsWith("\n")) next += "\n"

  return {
    next,
    unchanged: false,
    brokenWikilinksReplaced: 0,
    relatedEntriesRemoved: 0,
    indexRowsDropped: rowsDropped,
  }
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
    dryRun,
  }
}
