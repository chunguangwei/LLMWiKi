export interface WikiProject {
  /** Stable UUID, persisted inside the project at .llm-wiki/project.json.
   *  Survives the user moving or renaming the project folder. */
  id: string
  name: string
  path: string
}

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

export interface WikiPage {
  path: string
  content: string
  frontmatter: Record<string, unknown>
}

/**
 * Page-level "refresh from the web" settings, persisted in the page's
 * own frontmatter using flat keys (so the existing parser, which doesn't
 * preserve nested objects, can roundtrip them):
 *
 *   refresh-enabled: true
 *   refresh-interval-days: 7
 *   refresh-queries: ["mixture of experts 2026"]   # optional
 *   refresh-last-refreshed: 2026-05-18T03:00:00Z   # set by the runner
 *   refresh-last-result: ok | no-change | pending-review | error
 *
 * See `lib/refresh-runner.ts` and `lib/scheduled-refresh.ts`.
 */
export type RefreshLastResult = "ok" | "no-change" | "pending-review" | "error"

export interface RefreshConfig {
  enabled: boolean
  intervalDays: number
  queries: string[]
  lastRefreshed: string | null
  lastResult: RefreshLastResult | null
}
