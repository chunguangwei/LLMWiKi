import { fileExists, listDirectory } from "@/commands/fs"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import {
  importSourceFiles,
  importSourceFolder,
  type SkippedSourceImport,
  type SourceImportResult,
} from "@/lib/source-lifecycle"
import type { LlmConfig, SourceWatchConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export interface SourceDropResult extends SourceImportResult {
  error: string | null
}

export function createImportGuard() {
  let locked = false
  return {
    tryAcquire(): boolean {
      if (locked) return false
      locked = true
      return true
    },
    release() {
      locked = false
    },
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function importDroppedSourcePaths(
  project: WikiProject,
  paths: string[],
  llmConfig: LlmConfig,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<SourceDropResult> {
  const filePaths: string[] = []
  const folderPaths: string[] = []
  const skipped: SkippedSourceImport[] = []
  const errors: string[] = []
  const uniquePaths = [...new Set(paths.map(normalizePath))]

  for (const path of uniquePaths) {
    if (!isAbsolutePath(path)) {
      skipped.push({ name: getFileName(path) || path, reason: "unreadable", detail: "Dropped path is not absolute" })
      continue
    }
    try {
      await listDirectory(path, { includeHidden: true, maxDepth: 0 })
      folderPaths.push(path)
      continue
    } catch {}
    try {
      if (await fileExists(path)) {
        filePaths.push(path)
      } else {
        skipped.push({ name: getFileName(path) || path, reason: "unreadable", detail: "Path does not exist" })
      }
    } catch (error) {
      skipped.push({ name: getFileName(path) || path, reason: "unreadable", detail: errorDetail(error) })
    }
  }

  const imported: string[] = []
  if (filePaths.length > 0) {
    try {
      const result = await importSourceFiles(project, filePaths, llmConfig, sourceWatchConfig)
      imported.push(...result.imported)
      skipped.push(...result.skipped)
    } catch (error) {
      errors.push(errorDetail(error))
    }
  }

  for (const folderPath of folderPaths) {
    try {
      const result = await importSourceFolder(project, folderPath, llmConfig, sourceWatchConfig)
      imported.push(...result.imported)
      skipped.push(...result.skipped)
    } catch (error) {
      errors.push(errorDetail(error))
    }
  }

  return { imported, skipped, error: errors.length > 0 ? errors.join("; ") : null }
}
