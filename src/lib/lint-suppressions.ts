/**
 * "Already-attempted" lint suppressions.
 *
 * UX problem: a lint finding gets a fix attempt (AI fix or bulk fix),
 * the agent reports success, but the underlying issue persists — the
 * broken-link target STILL doesn't exist, the orphan STILL has no
 * inbound links. Next lint run surfaces the same finding. User clicks
 * fix again. Loop. The user feels the app is "stuck".
 *
 * This module persists "the user (or bulk-fix) already attempted
 * this finding; if it shows up again, hide it." Persistence is
 * per-project, scoped to a stable finding key so it survives:
 *
 *   - lint reruns (which clear the in-memory store)
 *   - app restarts
 *   - branch switches (the file lives in the project's
 *     `.llm-wiki/` dir, alongside other per-project state)
 *
 * Suppressions can be cleared from the UI when the user wants a
 * fresh look. They're a TRACE of past intent, not a hard ignore.
 */
import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { LintResult } from "@/lib/lint"

export interface SuppressionRecord {
  /** First time this finding was suppressed (ISO date YYYY-MM-DD). */
  attemptedAt: string
  /** Snapshot of the page slug at attempt time — informational only.
   *  The actual matching identity is the key, not the page. */
  page: string
  /** Finding type at attempt time. */
  type: LintResult["type"]
  /** Short snapshot of the detail text so the UI can show what was
   *  attempted without joining against the live lint result. */
  detailSnippet: string
}

export type Suppressions = Record<string, SuppressionRecord>  // keyed by findingKey

/**
 * Stable per-finding key. Identities:
 *
 *   - **broken-link** → the target slug (extracted from `[[X]]`).
 *     All sources referencing the same broken target collapse to
 *     one suppression.
 *   - **orphan / no-outlinks** → the affected page itself.
 *   - **semantic** → page + truncated detail (LLM-emitted detail
 *     isn't fully stable across runs, but the first 100 chars
 *     usually are).
 */
export function findingKey(r: { type: LintResult["type"]; page: string; detail: string }): string {
  if (r.type === "broken-link") {
    const m = r.detail.match(/\[\[([^\]\n|]+)\]\]/)
    const target = (m ? m[1] : r.detail).trim().toLowerCase()
    return `broken-link::${target}`
  }
  if (r.type === "orphan" || r.type === "no-outlinks") {
    return `${r.type}::${r.page.trim().toLowerCase()}`
  }
  // semantic — combine page + detail-prefix
  const detailPrefix = r.detail.replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase()
  return `${r.type}::${r.page.trim().toLowerCase()}::${detailPrefix}`
}

function suppressionsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/lint-suppressions.json`
}

/** Read the on-disk suppressions for the project. Returns {} when
 *  the file is missing or corrupt — suppressions are advisory state,
 *  losing the file is not an error. */
export async function loadSuppressions(projectPath: string): Promise<Suppressions> {
  const path = suppressionsPath(projectPath)
  if (!(await fileExists(path))) return {}
  try {
    const text = await readFile(path)
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object") return parsed as Suppressions
  } catch {
    // corrupt — start fresh
  }
  return {}
}

/** Persist the suppressions. Best-effort: a write failure is logged
 *  but doesn't bubble — the user's fix workflow shouldn't break on
 *  a disk hiccup. */
export async function saveSuppressions(
  projectPath: string,
  suppressions: Suppressions,
): Promise<void> {
  try {
    await writeFileAtomic(
      suppressionsPath(projectPath),
      JSON.stringify(suppressions, null, 2),
    )
  } catch (err) {
    console.warn("[lint-suppressions] save failed:", err)
  }
}

/**
 * Mark a finding as attempted. Idempotent — re-recording the same
 * finding just refreshes `attemptedAt`.
 */
export async function recordAttempt(
  projectPath: string,
  finding: { type: LintResult["type"]; page: string; detail: string },
): Promise<void> {
  const suppressions = await loadSuppressions(projectPath)
  const key = findingKey(finding)
  suppressions[key] = {
    attemptedAt: new Date().toISOString().slice(0, 10),
    page: finding.page,
    type: finding.type,
    detailSnippet: finding.detail.slice(0, 200),
  }
  await saveSuppressions(projectPath, suppressions)
}

/**
 * Mark MANY findings in one round-trip. Used by bulk-fix to record
 * every attempted item once the run finishes (success or failure —
 * an attempt is an attempt).
 */
export async function recordAttempts(
  projectPath: string,
  findings: ReadonlyArray<{ type: LintResult["type"]; page: string; detail: string }>,
): Promise<void> {
  if (findings.length === 0) return
  const suppressions = await loadSuppressions(projectPath)
  const today = new Date().toISOString().slice(0, 10)
  for (const f of findings) {
    const key = findingKey(f)
    suppressions[key] = {
      attemptedAt: today,
      page: f.page,
      type: f.type,
      detailSnippet: f.detail.slice(0, 200),
    }
  }
  await saveSuppressions(projectPath, suppressions)
}

/** Pure helper — partitions a finding list against a suppression map.
 *  Caller is responsible for loading suppressions; this stays I/O free
 *  for the lint-view filtering path. */
export function partitionBySuppression<T extends { type: LintResult["type"]; page: string; detail: string }>(
  findings: ReadonlyArray<T>,
  suppressions: Suppressions,
): { visible: T[]; hidden: T[] } {
  const visible: T[] = []
  const hidden: T[] = []
  for (const f of findings) {
    if (suppressions[findingKey(f)]) {
      hidden.push(f)
    } else {
      visible.push(f)
    }
  }
  return { visible, hidden }
}

/** Wipe all suppressions for the project. Used by the "Show all" /
 *  "Clear suppressions" UI affordance. */
export async function clearSuppressions(projectPath: string): Promise<void> {
  await saveSuppressions(projectPath, {})
}
