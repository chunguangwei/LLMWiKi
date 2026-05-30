/**
 * FileSystemWikiAccess — real WikiAccess implementation.
 *
 * Backs the agent's wiki-inspection / mutation tools onto the
 * project's actual `wiki/` directory via the existing fs commands
 * and frontmatter parser. This is the only piece of agent-ingest
 * that touches disk; the runner, tools, and tracker all flow
 * through this seam.
 *
 * Design choices worth pinning:
 *
 *   - **Atomic writes** everywhere. `writeFileAtomic` writes to a
 *     temp file and renames into place, so a crash mid-write never
 *     leaves a half-baked .md on disk. Concurrent agents running on
 *     the same project (rare, but possible) get last-writer-wins —
 *     no merge logic, by design (Phase E checkpoints make resume
 *     idempotent so a clobbered write just retries).
 *
 *   - **Slug = path without `.md`**, relative to `wiki/`. Pages live
 *     wherever the project's frontmatter `type:` says they should
 *     (concepts/, entities/, …) — we don't impose folder structure
 *     here; we just resolve whatever the slug points at.
 *
 *   - **Structural pages excluded** from listPages: index.md /
 *     log.md / overview.md. They're the wiki's TOC + change log
 *     + project summary, NOT knowledge pages; surfacing them to
 *     the agent would pollute "is there already a page on topic X"
 *     decisions.
 *
 *   - **`created:` preserved on update**. The agent updates content;
 *     it never resets the page's birth date. `updated:` ALWAYS gets
 *     bumped to today (ISO date, not timestamp — wiki convention).
 *
 *   - **`related:` + `tags:` union-merged on update**. The agent's
 *     mental model is "add these connections" not "replace all
 *     connections". An explicit clear would have to be a direct
 *     file edit.
 *
 *   - **Type validation** is currently advisory — we accept any
 *     non-empty string. Project-level schema enforcement (only the
 *     34 default types + the project's schema.md additions) is a
 *     Phase E concern; the LLM's system prompt already lists the
 *     allowed types, so over-validation here would just add a
 *     redundant guard that fails non-deterministically when the
 *     LLM uses a synonym.
 */
import { invoke } from "@tauri-apps/api/core"
import yaml from "js-yaml"
import {
  fileExists,
  listDirectory,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import type {
  WikiAccess,
  WikiPageFull,
  WikiPageSummary,
} from "./types"

/** Pages skipped from listPages — they're structural, not knowledge. */
const STRUCTURAL_PAGES: ReadonlySet<string> = new Set([
  "index.md",
  "log.md",
  "overview.md",
])

const PREVIEW_CHARS = 200

export class FileSystemWikiAccess implements WikiAccess {
  private readonly wikiRoot: string

  constructor(projectPath: string) {
    this.wikiRoot = `${normalizePath(projectPath)}/wiki`
  }

  /* ── listPages ──────────────────────────────────────── */

  async listPages(filter?: { type?: string }): Promise<WikiPageSummary[]> {
    const tree = await listDirectory(this.wikiRoot).catch(() => [])
    const mdPaths = flattenMdFiles(tree)
    const pages: WikiPageSummary[] = []
    for (const path of mdPaths) {
      const base = pathBasename(path)
      if (STRUCTURAL_PAGES.has(base.toLowerCase())) continue
      const summary = await this.toSummary(path).catch(() => null)
      if (!summary) continue
      if (filter?.type && summary.type !== filter.type) continue
      pages.push(summary)
    }
    return pages
  }

  private async toSummary(absPath: string): Promise<WikiPageSummary | null> {
    let content: string
    try {
      content = await readFile(absPath)
    } catch {
      return null
    }
    const { frontmatter, body } = parseFrontmatter(content)
    const fm = frontmatter ?? {}
    const slug = absPathToSlug(absPath, this.wikiRoot)
    const type = stringField(fm.type) ?? "other"
    const title =
      stringField(fm.title) ?? firstHeading(body) ?? pathStemHumanised(absPath)
    const description = makePreview(body)
    const related = stringArrayField(fm.related)
    return {
      slug,
      type,
      title,
      description,
      ...(related.length > 0 ? { related } : {}),
    }
  }

  /* ── readPage ───────────────────────────────────────── */

  async readPage(slug: string): Promise<WikiPageFull | null> {
    const path = this.slugToAbsPath(slug)
    if (!(await fileExists(path))) return null
    let content: string
    try {
      content = await readFile(path)
    } catch {
      return null
    }
    const { frontmatter, body } = parseFrontmatter(content)
    const fm = (frontmatter ?? {}) as Record<string, unknown>
    return {
      slug,
      type: stringField(fm.type) ?? "other",
      title:
        stringField(fm.title) ?? firstHeading(body) ?? pathStemHumanised(path),
      frontmatter: fm,
      body,
    }
  }

  /* ── writePage ─────────────────────────────────────── */

  async writePage(opts: {
    slug: string
    type: string
    title: string
    body: string
    related?: string[]
    tags?: string[]
  }): Promise<
    | { kind: "created"; path: string }
    | { kind: "slug_taken" }
    | { kind: "validation_failed"; detail: string }
  > {
    if (opts.type.trim().length === 0) {
      return { kind: "validation_failed", detail: "type must be non-empty" }
    }
    if (opts.title.trim().length === 0) {
      return { kind: "validation_failed", detail: "title must be non-empty" }
    }
    const path = this.slugToAbsPath(opts.slug)
    if (await fileExists(path)) {
      return { kind: "slug_taken" }
    }
    const today = todayIso()
    const fm: Record<string, unknown> = {
      type: opts.type.trim(),
      title: opts.title.trim(),
      created: today,
      updated: today,
    }
    if (opts.tags && opts.tags.length > 0) fm.tags = uniqueStringArray(opts.tags)
    if (opts.related && opts.related.length > 0)
      fm.related = uniqueStringArray(opts.related)
    const content = composeMarkdown(fm, opts.body)
    await writeFileAtomic(path, content)
    return { kind: "created", path }
  }

  /* ── updatePage ────────────────────────────────────── */

  async updatePage(opts: {
    slug: string
    body: string
    related?: string[]
    tags?: string[]
  }): Promise<
    | { kind: "updated"; path: string; added_chars: number }
    | { kind: "slug_not_found" }
    | { kind: "validation_failed"; detail: string }
  > {
    const path = this.slugToAbsPath(opts.slug)
    if (!(await fileExists(path))) return { kind: "slug_not_found" }
    let prevContent: string
    try {
      prevContent = await readFile(path)
    } catch (err) {
      return {
        kind: "validation_failed",
        detail: `failed to read existing page: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
    const { frontmatter: prevFm, body: prevBody } = parseFrontmatter(prevContent)
    const fm = mergeFrontmatterForUpdate(
      (prevFm ?? {}) as Record<string, unknown>,
      opts,
    )
    const content = composeMarkdown(fm, opts.body)
    await writeFileAtomic(path, content)
    return {
      kind: "updated",
      path,
      added_chars: Math.max(0, opts.body.length - prevBody.length),
    }
  }

  /* ── linkPages ─────────────────────────────────────── */

  async linkPages(opts: {
    from: string
    to: string
    bidirectional?: boolean
  }): Promise<
    | { kind: "linked"; from_was_new: boolean; to_was_new?: boolean }
    | { kind: "slug_not_found"; missing: "from" | "to" }
    | { kind: "validation_failed"; detail: string }
  > {
    const fromPath = this.slugToAbsPath(opts.from)
    if (!(await fileExists(fromPath))) {
      return { kind: "slug_not_found", missing: "from" }
    }
    const toPath = this.slugToAbsPath(opts.to)
    if (!(await fileExists(toPath))) {
      return { kind: "slug_not_found", missing: "to" }
    }

    const fromResult = await this.appendRelated(fromPath, opts.to).catch(
      (err) => ({ error: err instanceof Error ? err.message : String(err) }),
    )
    if ("error" in fromResult) {
      return { kind: "validation_failed", detail: fromResult.error }
    }

    if (opts.bidirectional) {
      const toResult = await this.appendRelated(toPath, opts.from).catch(
        (err) => ({ error: err instanceof Error ? err.message : String(err) }),
      )
      if ("error" in toResult) {
        return { kind: "validation_failed", detail: toResult.error }
      }
      return {
        kind: "linked",
        from_was_new: fromResult.was_new,
        to_was_new: toResult.was_new,
      }
    }
    return { kind: "linked", from_was_new: fromResult.was_new }
  }

  /**
   * Read a page, union-add `target` to its `related:` array, write
   * back. Returns whether the link was new — false means the file
   * wasn't touched (the slug was already present).
   */
  private async appendRelated(
    absPath: string,
    target: string,
  ): Promise<{ was_new: boolean }> {
    const content = await readFile(absPath)
    const { frontmatter, body } = parseFrontmatter(content)
    const fm = (frontmatter ?? {}) as Record<string, unknown>
    const prev = stringArrayField(fm.related)
    if (prev.includes(target)) {
      return { was_new: false }
    }
    fm.related = [...prev, target]
    fm.updated = todayIso()
    await writeFileAtomic(absPath, composeMarkdown(fm, body))
    return { was_new: true }
  }

  /* ── path / slug plumbing ──────────────────────────── */

  private slugToAbsPath(slug: string): string {
    // Slugs were validated by the tool layer (no traversal, no
    // illegal chars, no .md extension); we just join.
    return `${this.wikiRoot}/${slug}.md`
  }
}

/* ────────────────────────────────────────────────
 * Pure helpers (no I/O)
 * ────────────────────────────────────────────────*/

/** Walk a FileNode tree and return absolute paths of every .md
 *  (filtered to wiki/ pages — recurses into subfolders). */
function flattenMdFiles(nodes: FileNode[]): string[] {
  const out: string[] = []
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.is_dir) {
        if (n.children) walk(n.children)
        continue
      }
      if (n.name.toLowerCase().endsWith(".md")) out.push(n.path)
    }
  }
  walk(nodes)
  return out
}

function absPathToSlug(absPath: string, wikiRoot: string): string {
  const rel = absPath.startsWith(wikiRoot + "/")
    ? absPath.slice(wikiRoot.length + 1)
    : absPath
  // Strip .md extension. If a non-.md file somehow leaks here,
  // the unmodified name is returned — caller's responsibility.
  return rel.endsWith(".md") ? rel.slice(0, -3) : rel
}

function pathBasename(path: string): string {
  const i = path.lastIndexOf("/")
  return i >= 0 ? path.slice(i + 1) : path
}

function pathStemHumanised(path: string): string {
  return pathBasename(path).replace(/\.md$/i, "").replace(/-/g, " ")
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

/**
 * Description preview — first paragraph of body, with leading H1
 * stripped (since title already covers that), capped at PREVIEW_CHARS,
 * whitespace collapsed.
 */
function makePreview(body: string): string {
  const noH1 = body.replace(/^#\s+.+\n+/, "")
  const firstPara = noH1.split(/\n\s*\n/)[0] ?? ""
  const collapsed = firstPara.replace(/\s+/g, " ").trim()
  if (collapsed.length <= PREVIEW_CHARS) return collapsed
  return collapsed.slice(0, PREVIEW_CHARS).trimEnd() + "…"
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function stringArrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.length > 0)
}

function uniqueStringArray(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of input) {
    if (typeof s !== "string" || s.length === 0) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** Today as ISO date `YYYY-MM-DD` — the wiki convention for
 *  created / updated fields. Timestamps would surface in
 *  semantic search as noise. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Union-merge frontmatter for an update call.
 *
 *  - type / title / created — kept from previous frontmatter
 *    (the agent can't change these via update_wiki_page).
 *  - updated — bumped to today.
 *  - related / tags — union with whatever the agent passed.
 *  - Anything else in the previous frontmatter — preserved
 *    verbatim (sources:, custom fields, …).
 */
function mergeFrontmatterForUpdate(
  prev: Record<string, unknown>,
  patch: { related?: string[]; tags?: string[] },
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prev }
  merged.updated = todayIso()
  if (patch.related && patch.related.length > 0) {
    const prevRelated = stringArrayField(prev.related)
    merged.related = uniqueStringArray([...prevRelated, ...patch.related])
  }
  if (patch.tags && patch.tags.length > 0) {
    const prevTags = stringArrayField(prev.tags)
    merged.tags = uniqueStringArray([...prevTags, ...patch.tags])
  }
  return merged
}

/**
 * Compose a markdown file: `---\n<yaml>---\n\n<body>`.
 *
 * Order of frontmatter keys is fixed for human-friendliness:
 * type → title → created → updated → tags → related → sources →
 * everything else in insertion order. Stable order matters because
 * the user's editor diff shows write_wiki_page vs update_wiki_page
 * as a focused diff instead of a re-shuffle.
 */
function composeMarkdown(fm: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {}
  const PRIMARY_KEYS = ["type", "title", "created", "updated", "tags", "related", "sources"]
  for (const k of PRIMARY_KEYS) {
    if (k in fm) ordered[k] = fm[k]
  }
  for (const [k, v] of Object.entries(fm)) {
    if (!(k in ordered)) ordered[k] = v
  }
  // schema: JSON_SCHEMA — dates and other YAML-1.1 specials stay as
  // plain strings without quoting, matching what parseFrontmatter
  // reads back. flowLevel: 1 emits short arrays inline (`[a, b]`)
  // for readability — the wiki's hand-written pages already use
  // this shape.
  const yamlBlock = yaml
    .dump(ordered, {
      lineWidth: 1000,
      noRefs: true,
      sortKeys: false,
      schema: yaml.JSON_SCHEMA,
      flowLevel: 1,
    })
    .trimEnd()
  // Ensure a single blank line between frontmatter and body, and
  // that body ends with exactly one newline.
  const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "")
  return `---\n${yamlBlock}\n---\n\n${trimmedBody}\n`
}

// Re-export invoke for the tests below that need raw Tauri access
// (used by the .real-fs.test.ts when run against a temp project).
export { invoke as __invokeForTests }
