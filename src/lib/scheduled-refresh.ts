import { readFile, listDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { runPageRefresh, readRefreshConfig, isDue } from "@/lib/refresh-runner"
import type { FileNode, WikiProject } from "@/types/wiki"

/**
 * Background scheduler for page-level web refreshes.
 *
 * Mirrors `scheduled-import.ts` in shape — module-scope state, an
 * activeRunId guard against stale ticks, and `start*` / `stop*`
 * controllers driven by Settings → Save. The actual per-page work
 * lives in `refresh-runner.ts`.
 *
 * The scheduler ticks every `scanIntervalMin` minutes (user-configurable
 * but defaults to 30) and walks `wiki/` looking for pages whose
 * frontmatter says `refresh-enabled: true` and whose
 * `refresh-last-refreshed` is older than `refresh-interval-days`. Each
 * matching page is run sequentially so we don't fan out N concurrent
 * LLM/search calls and trip rate limits.
 */
let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false
let activeRunId = 0

export interface ScheduledRefreshConfig {
  enabled: boolean
  /** How often the scheduler wakes up to check, in minutes. */
  scanIntervalMin: number
}

const DEFAULT_SCAN_INTERVAL_MIN = 30

export function startScheduledRefresh(
  project: WikiProject,
  config: ScheduledRefreshConfig,
): void {
  stopScheduledRefresh()
  if (!config.enabled) return

  const runId = ++activeRunId
  const intervalMs =
    Math.max(1, Math.min(1440, config.scanIntervalMin || DEFAULT_SCAN_INTERVAL_MIN)) *
    60 *
    1000

  void scanProject(project, { runId })
  scanTimer = setInterval(() => {
    void scanProject(project, { runId })
  }, intervalMs)
}

export function stopScheduledRefresh(): void {
  activeRunId += 1
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}

/**
 * Walk `wiki/` and run refresh for every page that's due.
 *
 * Exposed so the Settings UI can offer a "Refresh now" button without
 * waiting for the next scheduled tick.
 */
export async function scanProject(
  project: WikiProject,
  opts: { runId?: number } = {},
): Promise<{ ran: number; skipped: number; errored: number }> {
  if (scanning) return { ran: 0, skipped: 0, errored: 0 }
  scanning = true
  const myRun = opts.runId ?? activeRunId

  let ran = 0
  let skipped = 0
  let errored = 0
  try {
    const wikiRoot = `${project.path}/wiki`
    const pages = await collectMarkdown(wikiRoot)
    for (const p of pages) {
      if (myRun !== activeRunId) break // stop was called or a newer run started
      try {
        const content = await readFile(p)
        const fm = parseFrontmatter(content).frontmatter ?? {}
        const cfg = readRefreshConfig(fm)
        if (!isDue(cfg)) {
          skipped += 1
          continue
        }
        await runPageRefresh(p)
        ran += 1
      } catch (err) {
        console.error(`[scheduled-refresh] page ${p} failed:`, err)
        errored += 1
      }
    }
  } finally {
    scanning = false
  }
  return { ran, skipped, errored }
}

async function collectMarkdown(root: string): Promise<string[]> {
  const out: string[] = []
  let top: FileNode[] = []
  try {
    top = await listDirectory(root)
  } catch {
    return out
  }
  await walk(top, out)
  return out
}

async function walk(nodes: FileNode[], out: string[]): Promise<void> {
  for (const n of nodes) {
    if (n.is_dir) {
      try {
        const children = await listDirectory(n.path)
        await walk(children, out)
      } catch {
        // skip unreadable subdir
      }
    } else if (n.name.toLowerCase().endsWith(".md")) {
      out.push(n.path)
    }
  }
}
