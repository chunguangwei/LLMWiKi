import { invoke } from "@tauri-apps/api/core"
import { writeFile, readFile, createDirectory, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode, WikiProject } from "@/types/wiki"

/**
 * GitHub versioned-backup & multi-device-sync — frontend glue.
 *
 * The heavy lifting (git tree diffing, push/pull, oversize skipping,
 * token storage in the OS keychain) lives entirely on the Rust side; this
 * module is three thin layers:
 *
 *   1. Typed `invoke` wrappers for the backend commands. Tauri
 *      snake_cases our camelCase arg keys automatically, so we pass the
 *      camelCase names the Rust handlers expect post-conversion and the
 *      responses come back already camelCased.
 *
 *   2. Per-device config persistence to `.llm-wiki-local/github-backup.json`.
 *      This file is per-user/per-device on purpose — it carries the
 *      lastSyncSha cursor and the user's interval/enabled choice, which
 *      must NOT be shared via iCloud/Dropbox (each device tracks its own
 *      sync position). It deliberately mirrors persist.ts's local-dir
 *      pattern (createDirectory + writeFile/readFile, dir = LOCAL_DIR).
 *
 *   3. A module-scope scheduler (mirrors scheduled-refresh.ts): an
 *      immediate pull on start, then periodic backups (backup pulls-first
 *      internally), with a runId stale-guard and a `running` re-entry
 *      guard so ticks never overlap.
 */

// ── Config ──────────────────────────────────────────────────────────

export interface GithubBackupConfig {
  owner: string
  repo: string
  branch: string
  /** Scheduler period in minutes; clamped to [1, 1440] before use. */
  intervalMinutes: number
  /** Whether to push raw/ + sources/ too (repo can grow large). */
  includeRawSources: boolean
  /** Master switch for the background scheduler. */
  enabled: boolean
  /** Last commit SHA this device successfully synced to — the pull/push
   *  cursor. Backend uses it to compute incremental diffs. */
  lastSyncSha: string
  /** Epoch-ms timestamp of the last successful sync (for the status line). */
  lastSyncAt: number
}

export const DEFAULT_GITHUB_BACKUP_CONFIG: GithubBackupConfig = {
  owner: "",
  repo: "",
  branch: "main",
  intervalMinutes: 30,
  includeRawSources: true,
  enabled: false,
  lastSyncSha: "",
  lastSyncAt: 0,
}

// ── Backend response types (all camelCase, per the contract) ─────────

export interface GithubBackupResult {
  newSha: string
  pushedFiles: string[]
  skippedOversize: string[]
  pulledFirst: boolean
}

export interface GithubPullResult {
  newSha: string
  changedFiles: string[]
  deletedFiles: string[]
  conflicts: string[]
}

export interface GithubVersion {
  sha: string
  message: string
  date: string
  author: string
}

export interface GithubRestoreResult {
  restoredFiles: string[]
}

export interface GithubValidateResult {
  login: string
  created: boolean
}

export interface GithubTokenStatus {
  hasToken: boolean
  login?: string
}

// ── Typed invoke wrappers ────────────────────────────────────────────
//
// One per backend command. Kept as thin pass-throughs so callers don't
// repeat the magic string command names and get response typing for free.

export async function githubBackupNow(args: {
  projectDir: string
  owner: string
  repo: string
  branch: string
  includeRawSources: boolean
  lastSyncSha: string
}): Promise<GithubBackupResult> {
  return invoke<GithubBackupResult>("github_backup_now", args)
}

export async function githubPullNow(args: {
  projectDir: string
  owner: string
  repo: string
  branch: string
  includeRawSources: boolean
  lastSyncSha: string
}): Promise<GithubPullResult> {
  return invoke<GithubPullResult>("github_pull_now", args)
}

export async function githubListVersions(args: {
  owner: string
  repo: string
  branch: string
  limit: number
}): Promise<GithubVersion[]> {
  return invoke<GithubVersion[]>("github_list_versions", args)
}

export async function githubRestoreVersion(args: {
  projectDir: string
  owner: string
  repo: string
  sha: string
  includeRawSources: boolean
}): Promise<GithubRestoreResult> {
  return invoke<GithubRestoreResult>("github_restore_version", args)
}

export async function githubValidateAndPrepare(args: {
  owner: string
  repo: string
  private: boolean
}): Promise<GithubValidateResult> {
  return invoke<GithubValidateResult>("github_validate_and_prepare", args)
}

export async function githubSaveToken(args: { token: string }): Promise<void> {
  return invoke<void>("github_save_token", args)
}

export async function githubTokenStatus(): Promise<GithubTokenStatus> {
  return invoke<GithubTokenStatus>("github_token_status")
}

export async function githubClearToken(): Promise<void> {
  return invoke<void>("github_clear_token")
}

// ── Config persistence (.llm-wiki-local/github-backup.json) ──────────
//
// Mirrors persist.ts's LOCAL_DIR pattern exactly: a per-device dir that
// MUST NOT be cloud-synced. We keep it here (rather than in persist.ts)
// for cohesion — everything GitHub-sync lives in this one lib.

const LOCAL_DIR = ".llm-wiki-local"

function localDir(pp: string): string {
  return `${pp}/${LOCAL_DIR}`
}

function configFile(pp: string): string {
  return `${localDir(pp)}/github-backup.json`
}

async function ensureLocalDir(projectPath: string): Promise<void> {
  // Best-effort: createDirectory throws if it already exists on some
  // platforms — same swallow-the-error approach as persist.ts.
  await createDirectory(localDir(projectPath)).catch(() => {})
}

/**
 * Load this device's GitHub-backup config. Always merges the persisted
 * JSON OVER the defaults so a config written by an older app version
 * (missing newer fields) is still safe to use — new fields fall back to
 * their default instead of arriving as `undefined`.
 */
export async function loadGithubBackupConfig(
  projectPath: string,
): Promise<GithubBackupConfig> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(configFile(pp))
    const parsed = JSON.parse(content) as Partial<GithubBackupConfig>
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_GITHUB_BACKUP_CONFIG }
    }
    return { ...DEFAULT_GITHUB_BACKUP_CONFIG, ...parsed }
  } catch {
    // Missing / unreadable / malformed → fall back to defaults.
    return { ...DEFAULT_GITHUB_BACKUP_CONFIG }
  }
}

export async function saveGithubBackupConfig(
  projectPath: string,
  cfg: GithubBackupConfig,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureLocalDir(pp)
  await writeFile(configFile(pp), JSON.stringify(cfg, null, 2))
}

// ── pullAndApply helper ──────────────────────────────────────────────

/**
 * Run a one-shot pull, persist the advanced sha + timestamp, and return
 * the changed/deleted/conflicts lists so the caller can refresh the UI
 * (rebuild the file tree, reload the open file, surface conflicts).
 *
 * Used both by the focus-driven sync in App.tsx and the "Pull now"
 * button in the settings section.
 */
export async function pullAndApply(
  project: WikiProject,
  cfg: GithubBackupConfig,
): Promise<GithubPullResult> {
  const result = await githubPullNow({
    projectDir: project.path,
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    includeRawSources: cfg.includeRawSources,
    lastSyncSha: cfg.lastSyncSha,
  })
  // Advance the local cursor so the next pull/backup diffs from here.
  const next: GithubBackupConfig = {
    ...cfg,
    lastSyncSha: result.newSha || cfg.lastSyncSha,
    lastSyncAt: Date.now(),
  }
  await saveGithubBackupConfig(project.path, next).catch((err) =>
    console.error("[github-backup] failed to persist pull cursor:", err),
  )
  return result
}

// ── Scheduler ────────────────────────────────────────────────────────
//
// Module-scope singleton, same shape as scheduled-refresh.ts:
//   - `timer`     the setInterval handle (null when stopped)
//   - `running`   re-entry guard so a long sync never overlaps the next tick
//   - `activeRunId` monotonic counter; a stale tick (from a previous
//                 start* call) bails the moment a newer run begins
//
// Only ONE project's backup runs at a time — starting a new one stops the
// previous, which matches the app's single-active-project model.

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let activeRunId = 0

const MIN_INTERVAL_MIN = 1
const MAX_INTERVAL_MIN = 1440

function clampIntervalMs(intervalMinutes: number): number {
  return (
    Math.max(
      MIN_INTERVAL_MIN,
      Math.min(MAX_INTERVAL_MIN, intervalMinutes || DEFAULT_GITHUB_BACKUP_CONFIG.intervalMinutes),
    ) *
    60 *
    1000
  )
}

/**
 * Start (or restart) the background backup scheduler for `project`.
 *
 * Sequence:
 *   1. Stop any prior scheduler (invalidates its runId, clears the timer).
 *   2. If the config is disabled, stay stopped.
 *   3. Do ONE immediate pull so a freshly-opened device catches up with
 *      whatever other devices pushed while it was offline.
 *   4. Schedule periodic BACKUPS — backup pulls-first internally on the
 *      Rust side, so each tick both ingests remote changes and pushes
 *      local ones.
 *
 * `onSynced` fires after every successful backup tick (and is given the
 * backup result) so the UI can rebuild its file tree / reload the open
 * file. It does NOT fire for the initial pull — App.tsx wires its own
 * refresh around that path via pullAndApply.
 */
export function startGithubBackup(
  project: WikiProject,
  cfg: GithubBackupConfig,
  onSynced?: (result: GithubBackupResult) => void,
): void {
  stopGithubBackup()
  if (!cfg.enabled) return

  const runId = ++activeRunId
  const intervalMs = clampIntervalMs(cfg.intervalMinutes)

  // 1) Immediate catch-up pull. Best-effort — a failure here must not
  //    stop the periodic backups from being scheduled.
  void pullAndApply(project, cfg).catch((err) =>
    console.error("[github-backup] initial pull failed:", err),
  )

  // 2) Periodic backups.
  timer = setInterval(() => {
    void runBackupTick(project, runId, onSynced)
  }, intervalMs)
}

export function stopGithubBackup(): void {
  // Bump the runId so any in-flight tick sees it's stale and bails after
  // its current await, then clear the timer.
  activeRunId += 1
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * One scheduler tick: run a backup unless one is already running or this
 * tick has been superseded by a newer start/stop call. On success,
 * persist the advanced sha/timestamp and notify `onSynced`.
 *
 * Exported so callers (and tests) can drive a single tick deterministically.
 */
export async function runBackupTick(
  project: WikiProject,
  runId: number,
  onSynced?: (result: GithubBackupResult) => void,
): Promise<void> {
  // Re-entry guard: a previous tick is still mid-flight. Skip — the next
  // interval will pick it up.
  if (running) return
  // Stale guard: this tick belongs to a scheduler that's since been
  // stopped or replaced.
  if (runId !== activeRunId) return

  running = true
  try {
    // Re-read the freshest config off disk so we always backup against
    // the latest cursor — the previous tick may have advanced lastSyncSha,
    // and the user may have toggled includeRawSources mid-session.
    const cfg = await loadGithubBackupConfig(project.path)
    if (runId !== activeRunId) return // stopped while we were loading

    const result = await githubBackupNow({
      projectDir: project.path,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch,
      includeRawSources: cfg.includeRawSources,
      lastSyncSha: cfg.lastSyncSha,
    })

    if (runId !== activeRunId) return // stopped while the backup ran

    const next: GithubBackupConfig = {
      ...cfg,
      lastSyncSha: result.newSha || cfg.lastSyncSha,
      lastSyncAt: Date.now(),
    }
    await saveGithubBackupConfig(project.path, next).catch((err) =>
      console.error("[github-backup] failed to persist backup cursor:", err),
    )
    onSynced?.(result)
  } catch (err) {
    console.error("[github-backup] backup tick failed:", err)
  } finally {
    running = false
  }
}

// ── File-tree helper (shared with App.tsx's refresh path) ────────────

/**
 * Recursively rebuild the project's file tree the same way App.tsx does
 * on project-open (top-level listDirectory). Exposed so the post-sync
 * refresh and the settings "Pull/Restore" buttons can reuse the exact
 * same tree-build instead of inventing a parallel path.
 *
 * Note: App.tsx only lists the top level on open (the tree lazy-loads
 * children), so we match that — a single top-level listDirectory.
 */
export async function rebuildFileTree(project: WikiProject): Promise<FileNode[]> {
  return listDirectory(project.path)
}
