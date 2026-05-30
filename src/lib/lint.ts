import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"

/**
 * Wiki sub-folders whose contents are RAW imports, not knowledge
 * pages. Real-world testing on a ~250-page wiki showed 70% of all
 * structural lint findings (94 broken-link + 15 orphan + 2 no-outlinks
 * out of 142 total) came from these folders — and almost none of
 * those findings were actionable:
 *
 *   - `sources/` holds source documents the user ingested. They're
 *     allowed to reference external concepts that don't have wiki
 *     pages yet (broken-link), they're naturally unlinked from other
 *     wiki pages (orphan), and their bodies are raw imports without
 *     wikilink curation (no-outlinks). Treating them as knowledge
 *     pages floods the Lint view with noise.
 *
 *   - `raw/` is the same idea under an older project layout.
 *
 *   - `queries/` is where chat-saved replies land (Save to Wiki).
 *     Each one is a one-shot answer card; no expectation that they
 *     should link / be linked-to like curated wiki pages.
 *
 *   - `.llm-wiki/` / `.llm-wiki-local/` are app-internal scratch
 *     directories (checkpoints, lint output itself, etc.) that the
 *     listDirectory walker can pick up if they accidentally have
 *     .md files. Hard-skip.
 *
 * Trailing slash convention — match is `startsWith(prefix)` against
 * the slug (NOT absolute path).
 */
const DEFAULT_IGNORE_PATH_PREFIXES: ReadonlyArray<string> = [
  "sources/",
  "raw/",
  "queries/",
  ".llm-wiki/",
  ".llm-wiki-local/",
]

export interface LintConfig {
  /** Path prefixes (wiki-relative, no leading slash, trailing slash
   *  required). Defaults skip raw / queries / app-internal trees. */
  ignorePathPrefixes: string[]
}

/**
 * Load the project's lint config from `.llm-wiki/lint-config.json`.
 * Returns the defaults when missing — most projects use them as-is
 * and don't need a config file. The file shape is:
 *
 *   {
 *     "ignorePathPrefixes": ["sources/", "raw/", "queries/"],
 *     "extraIgnorePathPrefixes": ["legacy-imports/"]
 *   }
 *
 *   - `ignorePathPrefixes` REPLACES the default list (advanced users
 *     who want to lint queries/ etc. set this to []).
 *   - `extraIgnorePathPrefixes` is added on top of the defaults
 *     (common case: keep defaults, add one more folder).
 */
export async function loadLintConfig(projectPath: string): Promise<LintConfig> {
  const pp = normalizePath(projectPath)
  let parsed: unknown
  try {
    const text = await readFile(`${pp}/.llm-wiki/lint-config.json`)
    parsed = JSON.parse(text)
  } catch {
    return { ignorePathPrefixes: DEFAULT_IGNORE_PATH_PREFIXES.slice() }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ignorePathPrefixes: DEFAULT_IGNORE_PATH_PREFIXES.slice() }
  }
  const obj = parsed as Record<string, unknown>
  const replace = Array.isArray(obj.ignorePathPrefixes)
    ? (obj.ignorePathPrefixes as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
    : null
  const extra = Array.isArray(obj.extraIgnorePathPrefixes)
    ? (obj.extraIgnorePathPrefixes as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
    : []
  const base = replace ?? DEFAULT_IGNORE_PATH_PREFIXES.slice()
  // Dedup + normalise trailing slash so config writers can leave it off.
  const normalised = Array.from(
    new Set([...base, ...extra].map((p) => (p.endsWith("/") ? p : p + "/"))),
  )
  return { ignorePathPrefixes: normalised }
}

/** Lint-time stats for the Lint view header. Returned alongside the
 *  findings so the UI can display "skipped N raw-source items" — a
 *  honest signal that lint is filtering noise rather than missing it. */
export interface LintStats {
  scanned: number
  skipped: number
  skippedByPathPrefix: Map<string, number>
}

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

/**
 * Build a slug → absolute path map from wiki files. Keys are lowercased
 * so [[Transformer]] matches transformer.md — wikilink matching should
 * be case-insensitive (matching typical wiki conventions). Callers must
 * also lowercase their lookup keys.
 */
function buildSlugMap(
  wikiFiles: FileNode[],
  wikiRoot: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of wikiFiles) {
    // e.g. /path/to/project/wiki/entities/foo.md → entities/foo
    const rel = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
    map.set(rel.toLowerCase(), f.path)
    // also index by basename without extension
    map.set(f.name.replace(/\.md$/, "").toLowerCase(), f.path)
  }
  return map
}

// ── Structural lint ───────────────────────────────────────────────────────────

export async function runStructuralLint(projectPath: string): Promise<LintResult[]> {
  const { findings } = await runStructuralLintWithStats(projectPath)
  return findings
}

/**
 * Same as runStructuralLint, but also returns counter stats for the
 * UI ("skipped N items"). Useful for surfacing why the lint count
 * dropped after a config tweak.
 */
export async function runStructuralLintWithStats(
  projectPath: string,
): Promise<{ findings: LintResult[]; stats: LintStats }> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return {
      findings: [],
      stats: { scanned: 0, skipped: 0, skippedByPathPrefix: new Map() },
    }
  }

  const config = await loadLintConfig(projectPath)
  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks plus all files
  // under config-ignored path prefixes (default raw / queries / etc).
  // The skip pass also records WHY each file was dropped so the UI
  // can show "skipped N items in sources/" instead of a silent dip.
  const skippedByPathPrefix = new Map<string, number>()
  const contentFiles = wikiFiles.filter((f) => {
    if (f.name === "index.md" || f.name === "log.md") return false
    const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
    for (const prefix of config.ignorePathPrefixes) {
      if (slug.startsWith(prefix)) {
        skippedByPathPrefix.set(prefix, (skippedByPathPrefix.get(prefix) ?? 0) + 1)
        return false
      }
    }
    return true
  })
  const stats: LintStats = {
    scanned: contentFiles.length,
    skipped: wikiFiles.length - contentFiles.length,
    skippedByPathPrefix,
  }

  const slugMap = buildSlugMap(contentFiles, wikiRoot)

  // Read all content files
  type PageData = { path: string; slug: string; content: string; outlinks: string[] }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
      const outlinks = extractWikilinks(content)
      pages.push({ path: f.path, slug, content, outlinks })
    } catch {
      // skip unreadable files
    }
  }

  // Build inbound link count. Lookups are case-insensitive — [[Transformer]]
  // should match transformer.md (slug "transformer").
  const inboundCounts = new Map<string, number>()
  for (const p of pages) {
    for (const link of p.outlinks) {
      const lookup = link.toLowerCase()
      const target = slugMap.has(lookup)
        ? relativeToSlug(getRelativePath(slugMap.get(lookup)!, wikiRoot)).toLowerCase()
        : lookup
      inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1)
    }
  }

  const results: LintResult[] = []

  // Broken links are GROUPED by target: a single missing target page
  // referenced from N source pages produces ONE lint item, with
  // `affectedPages` carrying the source list. Without this grouping,
  // a popular missing page (e.g. `[[领导梯队模型]]` referenced from
  // 7 different reports) generates 7 lint rows — readable as "the
  // same problem 7 times" — which floods the Lint view and makes
  // bulk AI fix expensive (each row would launch a separate agent
  // run repeating the same diagnosis).
  //
  // Key = the LOWERCASED link text the user typed. We dedupe on this
  // so case-variant references to the same name (`[[Foo]]` and
  // `[[foo]]`) collapse, but keep the FIRST-seen original casing in
  // `target` so the lint row reads like the wiki.
  const brokenByTarget = new Map<string, { target: string; pages: Set<string> }>()

  for (const p of pages) {
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links (lowercased slug for case-insensitive match)
    const inbound = inboundCounts.get(p.slug.toLowerCase()) ?? 0
    if (inbound === 0) {
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
      })
    }

    // Broken links — case-insensitive matching. Accumulated into the
    // by-target map; emitted once below.
    for (const link of p.outlinks) {
      const lookup = link.toLowerCase()
      const basename = getFileName(link).replace(/\.md$/, "").toLowerCase()
      const exists = slugMap.has(lookup) || slugMap.has(basename)
      if (exists) continue
      const key = lookup
      const entry = brokenByTarget.get(key) ?? { target: link, pages: new Set<string>() }
      entry.pages.add(shortName)
      brokenByTarget.set(key, entry)
    }
  }

  // Emit one broken-link row per missing target. Sort the affected-
  // pages list so the output is stable across runs (the input page
  // order depends on the OS's directory enumeration, which isn't).
  for (const { target, pages: sourcePages } of brokenByTarget.values()) {
    const pageList = Array.from(sourcePages).sort()
    const detail =
      pageList.length === 1
        ? `Broken link: [[${target}]] — target page not found.`
        : `Broken link: [[${target}]] — target page not found, referenced from ${pageList.length} pages.`
    results.push({
      type: "broken-link",
      severity: "warning",
      // `page` is the "primary" row anchor (first affected source);
      // the full list lives in affectedPages. UI shows page first
      // then expands to the rest.
      page: pageList[0],
      detail,
      ...(pageList.length > 1 ? { affectedPages: pageList } : {}),
    })
  }

  return { findings: results, stats }
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars)
  const summaries: string[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  // For auto-mode language detection, sample the concatenated summaries
  // so non-English wikis get a matching language directive.
  const summarySample = summaries.join("\n").slice(0, 2000)

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    buildLanguageDirective(summarySample),
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // semantic results always use type "semantic"
    void rawType

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}
