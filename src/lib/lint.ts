import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { parseFrontmatter } from "@/lib/frontmatter"
import { WIKI_TYPE_OPTIONS } from "@/lib/wiki-type-options"

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
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic" | "frontmatter-type"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  // ── Link-repair suggestions (structural lint only) ────────────────
  // The original broken wikilink text as the user typed it, e.g.
  // "transfomer". Carried so the one-click Fix knows what to rewrite.
  brokenTarget?: string
  // The best-guess existing page (wiki-relative path, e.g.
  // "entities/transformer.md") that this finding should link TO —
  // populated for broken-link (closest fuzzy match) and no-outlinks
  // (most topically-related page). Empty when no confident match.
  suggestedTarget?: string
  // The best-guess existing page that should link INTO an orphan
  // (wiki-relative path). The Fix appends a wikilink there.
  suggestedSource?: string
}

// Confidence thresholds for the link-repair suggestion engine. Tuned
// against a real ~250-page wiki so that suggestions stay actionable
// rather than noisy — a wrong suggestion is worse than none because
// the one-click Fix acts on it.
//   - BROKEN_LINK: fuzzy string match between the broken target and an
//     existing page must clear this before we offer a rename.
//   - RELATED_PAGE: token-overlap (cosine-ish) score for orphan /
//     no-outlinks "related page" suggestions. Deliberately low — even
//     a weak topical link beats a fully unlinked page.
//   - SAME_FOLDER_SCORE_BONUS: nudge co-located pages up; siblings in
//     the same folder are usually about the same sub-topic.
//   - SINGLE_CJK_TOKEN_WEIGHT: a lone CJK character is a weaker signal
//     than a multi-char word, so it counts for less in the overlap sum.
//   - SUGGESTION_TOKEN_WINDOW: only the first N chars of a page body
//     feed the token set (keeps long imports from dominating).
//   - SAME_BASENAME / CONTAINS_TARGET: short-circuit scores for the
//     two highest-confidence broken-link cases (same filename, or one
//     target is a substring of the other).
const BROKEN_LINK_SUGGESTION_MIN_SCORE = 0.74
const RELATED_PAGE_SUGGESTION_MIN_SCORE = 0.08
const SAME_FOLDER_SCORE_BONUS = 0.08
const SINGLE_CJK_TOKEN_WEIGHT = 0.35
const SUGGESTION_TOKEN_WINDOW = 4000
const SAME_BASENAME_SCORE = 0.96
const CONTAINS_TARGET_SCORE = 0.82

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

// ── Link-repair suggestion helpers ─────────────────────────────────────────────

/** Canonicalise a wikilink target / path for comparison: drop the
 *  optional `wiki/` prefix and `.md` suffix, trim, lowercase. So
 *  "wiki/Entities/Transformer.md" and "entities/transformer" compare
 *  equal. */
function normalizeLinkTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase()
}

/** Best human-readable title for a page: frontmatter `title:`, else the
 *  first H1, else the de-slugged filename. Used to widen the fuzzy
 *  match surface for broken-link suggestions. */
function extractTitle(content: string, fallbackPath: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (title?.[1]?.trim()) return title[1].trim()
  }
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return getFileName(fallbackPath)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
}

/** Tokenise text for topical-overlap scoring. Words of length ≥ 2 plus,
 *  for CJK runs, each individual character (so two pages sharing a
 *  Chinese term still overlap even when word boundaries are absent).
 *  NFKC-normalised + lowercased for stable comparison. */
function tokenizeForSuggestion(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length >= 2) tokens.add(token)
    if (/[㐀-鿿]/u.test(token)) {
      for (const char of Array.from(token)) tokens.add(char)
    }
  }
  return tokens
}

/** Plain Levenshtein edit distance (two-row DP). Used by the broken-link
 *  fuzzy matcher to catch typos like "transfomer" → "transformer". */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  const current = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      )
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]
  }
  return previous[b.length]
}

/** 0..1 similarity between a broken target and a candidate page key.
 *  Short-circuits the high-confidence cases (exact / same basename /
 *  substring) before falling back to a length-normalised edit-distance
 *  ratio. Very short basenames (< 5 chars) get a 0 to avoid wiring up
 *  bogus links like cat → bat. */
function stringSimilarity(a: string, b: string): number {
  const left = normalizeLinkTarget(a)
  const right = normalizeLinkTarget(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const leftBase = getFileName(left)
  const rightBase = getFileName(right)
  if (leftBase === rightBase) return SAME_BASENAME_SCORE
  if (right.includes(left) || left.includes(right)) return CONTAINS_TARGET_SCORE
  if (leftBase.length < 5 || rightBase.length < 5) return 0
  const maxLen = Math.max(leftBase.length, rightBase.length)
  if (maxLen === 0) return 0
  return 1 - levenshtein(leftBase, rightBase) / maxLen
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
  // Exclude structural pages from orphan / no-outlinks / broken-link
  // checks, plus all files under config-ignored path prefixes
  // (default raw / queries / etc). Structural pages = the wiki's
  // entry / TOC / change-log / overview / project framing —
  // they're MEANT to be entry points, not knowledge nodes in the
  // graph, so flagging them as orphan is a false positive that
  // bulk-fix will gladly act on (it has happened: a user saw
  // overview.md flagged as orphan and the cleanup deleted it).
  // Keep this list aligned with
  // agent-ingest/wiki-access.ts STRUCTURAL_PAGES and
  // project-file-sync.ts. Match is on basename only — a per-folder
  // `concepts/index.md` is still a real page.
  const STRUCTURAL_BASENAMES: ReadonlySet<string> = new Set([
    "index.md",
    "log.md",
    "overview.md",
    "purpose.md",
    "schema.md",
  ])
  const skippedByPathPrefix = new Map<string, number>()
  const contentFiles = wikiFiles.filter((f) => {
    if (STRUCTURAL_BASENAMES.has(f.name.toLowerCase())) return false
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

  // slugMap MUST include structural pages too — a wikilink from a
  // knowledge page to `[[overview]]` or `[[index]]` is valid (the
  // file exists), just not subject to orphan / no-outlinks checks.
  // Without including them here, every such link would be flagged
  // as broken.
  const slugMap = buildSlugMap(wikiFiles, wikiRoot)

  // Read all content files
  type PageData = {
    path: string
    shortName: string
    slug: string
    title: string
    content: string
    outlinks: string[]
    tokens: Set<string>
  }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const shortName = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortName)
      const title = extractTitle(content, shortName)
      const outlinks = extractWikilinks(content)
      const slugName = getFileName(slug)
      const tokens = tokenizeForSuggestion(`${title}\n${slugName}\n${content.slice(0, SUGGESTION_TOKEN_WINDOW)}`)
      pages.push({ path: f.path, shortName, slug, title, content, outlinks, tokens })
    } catch {
      // skip unreadable files
    }
  }

  // Suggest the closest EXISTING page for a broken wikilink target —
  // fuzzy-matched against each page's slug, wiki-relative path, and
  // title. Returns undefined unless the best score clears the
  // confidence threshold (a wrong rename is worse than none).
  function suggestBrokenTarget(target: string): PageData | undefined {
    let best: { page: PageData; score: number } | undefined
    for (const candidate of pages) {
      const score = Math.max(
        stringSimilarity(target, candidate.slug),
        stringSimilarity(target, candidate.shortName),
        stringSimilarity(target, candidate.title),
      )
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= BROKEN_LINK_SUGGESTION_MIN_SCORE ? best.page : undefined
  }

  // Suggest a topically-related page for orphan ("source" = a page that
  // should link INTO this one) and no-outlinks ("target" = a page this
  // one should link OUT to). Scored by token overlap with a same-folder
  // bonus. For the "target" direction we skip pages this page already
  // links to, so we never suggest a redundant link.
  function suggestRelatedPage(page: PageData, direction: "source" | "target"): PageData | undefined {
    const existingOutlinks = new Set(page.outlinks.map(normalizeLinkTarget))
    let best: { page: PageData; score: number } | undefined
    for (const candidate of pages) {
      if (candidate.shortName === page.shortName) continue
      if (direction === "target") {
        const candidateKeys = [
          normalizeLinkTarget(candidate.slug),
          normalizeLinkTarget(candidate.shortName),
          normalizeLinkTarget(getFileName(candidate.shortName).replace(/\.md$/i, "")),
        ]
        if (candidateKeys.some((key) => existingOutlinks.has(key))) continue
      }
      let overlap = 0
      for (const token of page.tokens) {
        if (candidate.tokens.has(token)) overlap += token.length > 1 ? 1 : SINGLE_CJK_TOKEN_WEIGHT
      }
      if (overlap === 0) continue
      const folderBonus =
        page.shortName.split("/")[0] === candidate.shortName.split("/")[0] ? SAME_FOLDER_SCORE_BONUS : 0
      const score =
        overlap / Math.sqrt(Math.max(1, page.tokens.size) * Math.max(1, candidate.tokens.size)) +
        folderBonus
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= RELATED_PAGE_SUGGESTION_MIN_SCORE ? best.page : undefined
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

  // Build the canonical type set ONCE per lint run. Sources from
  // WIKI_TYPE_OPTIONS (the same list the type selector + write-time
  // validation use) plus `overview` (the wiki's framing page, has
  // its own type even though the selector hides it) and `other`
  // (the explicit escape hatch). Any frontmatter `type:` outside
  // this set is suggested for normalisation.
  const canonicalTypes: ReadonlySet<string> = new Set([
    ...WIKI_TYPE_OPTIONS.map((o) => o.value),
    "overview",
    "other",
  ])

  for (const p of pages) {
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links (lowercased slug for case-insensitive match)
    const inbound = inboundCounts.get(p.slug.toLowerCase()) ?? 0
    if (inbound === 0) {
      const suggestedSource = suggestRelatedPage(p, "source")
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
        suggestedSource: suggestedSource?.shortName,
      })
    }

    // Frontmatter type check — every page should declare a canonical
    // `type:` so the knowledge tree, lint, and reconcile can place
    // it. Two failure modes:
    //   - missing → warning (no `type:` at all, page is a "lost
    //     resource" the system can't classify)
    //   - non-canonical → info (LLM or legacy import emitted a
    //     synonym like `type: 笔记` — works through alias
    //     normalisation but should be cleaned up for clarity)
    const { frontmatter: fm } = parseFrontmatter(p.content)
    const rawType =
      fm && typeof fm === "object" && typeof (fm as Record<string, unknown>).type === "string"
        ? ((fm as Record<string, unknown>).type as string).trim()
        : ""
    if (rawType.length === 0) {
      results.push({
        type: "frontmatter-type",
        severity: "warning",
        page: shortName,
        detail: "Missing frontmatter `type:` — set one of the canonical types (concept / entity / note / report / ...).",
      })
    } else if (!canonicalTypes.has(rawType)) {
      results.push({
        type: "frontmatter-type",
        severity: "info",
        page: shortName,
        detail: `Non-canonical \`type: ${rawType}\` — rename to a canonical slug from WIKI_TYPE_OPTIONS (e.g. note / report / article).`,
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      const suggestedTarget = suggestRelatedPage(p, "target")
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
        suggestedTarget: suggestedTarget?.shortName,
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
  //
  // `brokenTarget` (the original typed link) + `suggestedTarget` (the
  // closest existing page, if any) drive the one-click link repair:
  // rewrite the link to the suggestion, or stub out the missing page.
  // Suggestion is computed ONCE per target — the grouping means a
  // popular typo is fuzzy-matched a single time, not once per source.
  for (const { target, pages: sourcePages } of brokenByTarget.values()) {
    const pageList = Array.from(sourcePages).sort()
    const detail =
      pageList.length === 1
        ? `Broken link: [[${target}]] — target page not found.`
        : `Broken link: [[${target}]] — target page not found, referenced from ${pageList.length} pages.`
    const suggestedTarget = suggestBrokenTarget(target)
    results.push({
      type: "broken-link",
      severity: "warning",
      // `page` is the "primary" row anchor (first affected source);
      // the full list lives in affectedPages. UI shows page first
      // then expands to the rest.
      page: pageList[0],
      detail,
      brokenTarget: target,
      suggestedTarget: suggestedTarget?.shortName,
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
