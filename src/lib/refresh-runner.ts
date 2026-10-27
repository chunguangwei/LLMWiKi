import { readFile, writeFile } from "@/commands/fs"
import { withProjectLock } from "@/lib/project-mutex"
import { markdownFileSaver } from "@/lib/markdown-file-saver"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { webSearch, type WebSearchResult } from "@/lib/web-search"
import { streamChat } from "@/lib/llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import type { RefreshConfig, RefreshLastResult } from "@/types/wiki"

/**
 * Run a single page through the refresh pipeline:
 *   1. Read page + parse frontmatter
 *   2. Search the web for each configured query (or derive queries
 *      from the page title)
 *   3. Ask the LLM whether the page is stale; if so, summarize what's
 *      new and queue a review item
 *   4. Stamp `refresh-last-refreshed` / `refresh-last-result` back
 *      into the page so the scheduler knows when it ran
 *
 * Returns the outcome so the caller (scheduler or manual UI button)
 * can log / surface it.
 */
export async function runPageRefresh(pagePath: string, projectRoot?: string): Promise<RefreshLastResult> {
  const store = useWikiStore.getState()
  const { llmConfig, searchApiConfig } = store
  const normalized = normalizePath(pagePath)
  const wikiIndex = normalized.indexOf("/wiki/")
  const projectPath = normalizePath(projectRoot ?? store.project?.path ??
    (wikiIndex >= 0 ? normalized.slice(0, wikiIndex) : normalized))

  let content: string
  try {
    content = await readFile(pagePath)
  } catch (err) {
    console.error(`[refresh] cannot read ${pagePath}:`, err)
    return "error"
  }

  const parsed = parseFrontmatter(content)
  const fm = parsed.frontmatter ?? {}
  const cfg = readRefreshConfig(fm)
  if (!cfg.enabled) {
    return "no-change"
  }

  const title = stringField(fm, "title") ?? deriveTitleFromPath(pagePath)
  const queries = cfg.queries.length > 0 ? cfg.queries : defaultQueriesFor(title)

  let allResults: WebSearchResult[] = []
  try {
    for (const q of queries) {
      const results = await webSearch(q, searchApiConfig, 5)
      allResults.push(...results)
    }
  } catch (err) {
    console.error(`[refresh] web search failed for ${pagePath}:`, err)
    await stampResult(projectPath, pagePath, content, parsed.rawBlock, "error")
    return "error"
  }

  if (allResults.length === 0) {
    return await stampResult(projectPath, pagePath, content, parsed.rawBlock, "no-change") ? "no-change" : "error"
  }

  let verdict: { isStale: boolean; summary: string }
  try {
    verdict = await askLlmForVerdict(llmConfig, title, parsed.body, allResults)
  } catch (err) {
    console.error(`[refresh] model verdict failed for ${pagePath}:`, err)
    await stampResult(projectPath, pagePath, content, parsed.rawBlock, "error")
    return "error"
  }
  const result = verdict.isStale ? "pending-review" : "no-change"
  if (!await stampResult(projectPath, pagePath, content, parsed.rawBlock, result)) return "error"
  if (verdict.isStale) {
    useReviewStore.getState().addItem({
      type: "suggestion",
      title: `Refresh: ${title}`,
      description: verdict.summary,
      affectedPages: [pagePath],
      searchQueries: queries,
      options: [
        { label: "Open page", action: `open-page:${pagePath}` },
        { label: "Dismiss", action: "dismiss" },
      ],
    })
    return "pending-review"
  }

  return "no-change"
}

/** Decide if a page is due for a refresh based on its frontmatter. */
export function isDue(cfg: RefreshConfig, now: number = Date.now()): boolean {
  if (!cfg.enabled) return false
  if (cfg.lastResult === "error") return true
  if (!cfg.lastRefreshed) return true
  const last = Date.parse(cfg.lastRefreshed)
  if (Number.isNaN(last)) return true
  const dueAt = last + cfg.intervalDays * 24 * 60 * 60 * 1000
  return now >= dueAt
}

export function readRefreshConfig(
  frontmatter: Record<string, unknown>,
): RefreshConfig {
  const enabled = boolField(frontmatter, "refresh-enabled")
  const intervalRaw = stringField(frontmatter, "refresh-interval-days")
  const intervalDays = clampInterval(intervalRaw ? Number(intervalRaw) : 7)
  const queriesRaw = arrayField(frontmatter, "refresh-queries")
  const lastRefreshed = stringField(frontmatter, "refresh-last-refreshed") ?? null
  const lastResult = stringField(frontmatter, "refresh-last-result") as RefreshLastResult | undefined
  return {
    enabled,
    intervalDays,
    queries: queriesRaw,
    lastRefreshed,
    lastResult: lastResult ?? null,
  }
}

function clampInterval(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return 7
  return Math.max(1, Math.min(365, Math.round(d)))
}

function boolField(fm: Record<string, unknown>, key: string): boolean {
  const v = fm[key]
  if (typeof v === "boolean") return v
  if (typeof v === "string") return v.toLowerCase() === "true"
  return false
}

function stringField(fm: Record<string, unknown>, key: string): string | undefined {
  const v = fm[key]
  if (typeof v === "string" && v.trim()) return v.trim()
  return undefined
}

function arrayField(fm: Record<string, unknown>, key: string): string[] {
  const v = fm[key]
  if (Array.isArray(v)) {
    return v.map((x) => String(x)).filter((s) => s.trim().length > 0)
  }
  if (typeof v === "string" && v.trim()) return [v.trim()]
  return []
}

function deriveTitleFromPath(p: string): string {
  const base = p.split(/[/\\]/).pop() ?? p
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ")
}

function defaultQueriesFor(title: string): string[] {
  const year = new Date().getFullYear()
  return [`${title} ${year}`, `latest ${title}`]
}

/**
 * Ask the LLM to compare current page body vs fresh search results.
 * Returns a verdict. We use a one-shot non-streaming call (we collect
 * tokens into a buffer); the response is short.
 */
async function askLlmForVerdict(
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  title: string,
  body: string,
  results: WebSearchResult[],
): Promise<{ isStale: boolean; summary: string }> {
  const trimmedBody = body.length > 8000 ? body.slice(0, 8000) + "\n…(truncated)" : body
  const resultsBlock = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n")

  const prompt = `You are auditing a wiki page for staleness. Compare the page below against fresh web search results.\n\nReturn one line: STATUS=fresh OR STATUS=stale.\nIf stale, follow with a 3-5 bullet summary of what is new or contradicting; cite result numbers like [2].\nIf fresh, no bullets needed.\n\n=== PAGE: ${title} ===\n${trimmedBody}\n\n=== WEB RESULTS ===\n${resultsBlock}`

  let buffer = ""
  let failure: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: "You are a precise wiki staleness auditor. Be terse." },
      { role: "user", content: prompt },
    ],
    {
      onToken: (t) => {
        buffer += t
      },
      onDone: () => {},
      onError: (error) => { failure = error },
    },
  )

  if (failure) throw failure
  const statuses = [...buffer.matchAll(/^STATUS\s*=\s*(fresh|stale)\s*$/gim)]
  if (statuses.length !== 1 || !/^STATUS\s*=\s*(fresh|stale)\s*$/i.test(buffer.trim().split(/\r?\n/)[0])) {
    throw new Error("Invalid refresh verdict: expected a single STATUS=fresh or STATUS=stale")
  }
  return { isStale: statuses[0][1].toLowerCase() === "stale", summary: buffer.trim() }
}

/**
 * Update only `refresh-last-refreshed` and `refresh-last-result` in the
 * page's frontmatter. Preserves the rest of the YAML block (and the
 * user's formatting/comments) by editing rawBlock with a targeted
 * regex pass rather than re-serializing.
 */
async function stampResult(
  projectPath: string,
  pagePath: string,
  originalContent: string,
  rawBlock: string,
  result: RefreshLastResult,
): Promise<boolean> {
  // Serialize with ingest/research and with editor saves. Never stamp an old
  // verdict onto changed content, and never recreate a page deleted mid-run.
  try {
    return await withProjectLock(projectPath, async () => {
      let committed = false
      await markdownFileSaver.writeExternal(pagePath, originalContent, async () => {
        const latest = await readFile(pagePath)
        if (latest !== originalContent) return latest
        const snapshot = markdownFileSaver.getSnapshot(pagePath)
        if (snapshot?.pending || snapshot?.dirty && !snapshot.running) return latest
        const now = new Date().toISOString()
        let nextBlock = rawBlock
        if (nextBlock.length === 0) {
          nextBlock = `---\nrefresh-last-refreshed: "${now}"\nrefresh-last-result: ${result}\n---\n`
        } else {
          nextBlock = upsertField(nextBlock, "refresh-last-refreshed", `"${now}"`)
          nextBlock = upsertField(nextBlock, "refresh-last-result", result)
        }
        const updated = nextBlock + originalContent.slice(rawBlock.length)
        await writeFile(pagePath, updated)
        committed = true
        return updated
      })
      return committed
    })
  } catch (err) {
    console.error(`[refresh] metadata commit failed for ${pagePath}:`, err)
    return false
  }
}

/**
 * Replace `key: oldValue` in a `---\n…\n---` block. If `key` is absent
 * insert it just before the closing `---`. The closing fence may carry
 * trailing whitespace and a `\n`.
 */
export function upsertField(rawBlock: string, key: string, value: string): string {
  const fieldRe = new RegExp(`^(${escapeReg(key)}\\s*:\\s*).*$`, "m")
  if (fieldRe.test(rawBlock)) {
    return rawBlock.replace(fieldRe, `$1${value}`)
  }
  const closingRe = /\n---\s*(\r?\n|$)/
  const m = rawBlock.match(closingRe)
  if (!m || m.index === undefined) return rawBlock
  const before = rawBlock.slice(0, m.index)
  const after = rawBlock.slice(m.index)
  return `${before}\n${key}: ${value}${after}`
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
