import { create } from "zustand"

/**
 * Runtime status of the GitHub-backup UI, lifted OUT of the settings
 * section component on purpose.
 *
 * Why a store and not component state: the "Backup now" / "Pull now" /
 * "Restore" operations are long-running, but the settings section
 * UNMOUNTS the moment the user switches to another settings category or
 * view. If the in-flight status lived in the component's `useState`, the
 * backup would keep running in Rust while the UI silently reset to blank
 * on the next mount — exactly the "切到别的页再切回来就看不到了" bug.
 *
 * Keeping `busy` / `progress` / `result` here means the async operation
 * (which closes over these stable setters) keeps updating them after the
 * component is gone, and a freshly-remounted section reads the current
 * values — so live progress and the final result survive navigation.
 */

/** Which operation is currently running (null = idle). */
export type GithubBackupOp =
  | "savePat"
  | "disconnect"
  | "verifyRepo"
  | "backup"
  | "pull"
  | "versions"
  | "restore"
  | null

/** Per-file upload progress emitted by the Rust backup command. */
export interface GithubBackupProgressState {
  current: number
  total: number
  file: string
}

/** Result banner shown after an operation finishes. */
export interface GithubBackupResultState {
  kind: "ok" | "err" | "warn"
  message: string
}

interface GithubBackupRuntimeState {
  busy: GithubBackupOp
  result: GithubBackupResultState | null
  progress: GithubBackupProgressState | null
  setBusy: (busy: GithubBackupOp) => void
  setResult: (result: GithubBackupResultState | null) => void
  setProgress: (progress: GithubBackupProgressState | null) => void
}

export const useGithubBackupRuntime = create<GithubBackupRuntimeState>((set) => ({
  busy: null,
  result: null,
  progress: null,
  setBusy: (busy) => set({ busy }),
  setResult: (result) => set({ result }),
  setProgress: (progress) => set({ progress }),
}))
