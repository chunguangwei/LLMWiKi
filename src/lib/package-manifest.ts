/**
 * Mirrors the Rust types in `src-tauri/src/commands/package.rs`.
 * Keep in sync — these cross the Tauri IPC boundary.
 */

export interface PackageFileEntry {
  path: string
  sha256: string
  size: number
}

export interface PackageIncludes {
  page_history: boolean
  embeddings: boolean
}

export interface PackageManifest {
  schema_version: number
  app_version: string
  exported_at: string
  exported_by: string | null
  project_name: string
  includes: PackageIncludes
  files: PackageFileEntry[]
}

export interface ExportOptions {
  app_version: string
  project_name: string
  exported_by: string | null
  includes: PackageIncludes
}

export type ConflictStrategy = "skip-existing" | "overwrite-all"

export interface ImportOptions {
  conflict_strategy: ConflictStrategy
}

export interface ImportResult {
  manifest: PackageManifest
  files_written: number
  files_skipped: number
  checksum_mismatches: string[]
}
