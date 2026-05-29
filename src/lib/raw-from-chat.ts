import {
  copyFile,
  createDirectory,
  fileExists,
  preprocessFile,
  readFile,
  writeFile,
} from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getFileCategory, isTextReadable } from "@/lib/file-types"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"
import { fetchAndExtract, slugFromTitle, type WebFetchResult } from "@/lib/web-fetch"
import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export interface AddFilesFromChatResult {
  imported: string[]
  contextApplied: number
  failed: string[]
}

// Marker comment that delimits chat-originated context so future tooling can
// strip / rewrite it without ambiguity. Must match the open token used by
// buildContextBlock() and the sidecar prepend in ingest.ts.
export const CHAT_CONTEXT_MARKER = "<!-- llmwiki:chat-context"

// Sidecar lives next to the binary source as ".<basename>.context.md". The
// dot prefix hides it in the file tree AND makes isIngestableSourcePath()
// skip it so it never becomes its own ingest target.
export function contextSidecarPath(rawDestPath: string): string {
  const norm = normalizePath(rawDestPath)
  const slash = norm.lastIndexOf("/")
  const dir = slash >= 0 ? norm.slice(0, slash) : ""
  const name = slash >= 0 ? norm.slice(slash + 1) : norm
  return `${dir}/.${name}.context.md`
}

/**
 * Read a source file the same way ingest used to (via `read_file`, which
 * extracts text for PDF/Office on the Rust side), but if a sibling
 * `.<name>.context.md` exists, prepend it to the returned text.
 *
 * Text sources don't need this — their context was already inlined into
 * the file at chat-drop time. Sidecars only exist for binaries that we
 * couldn't safely mutate at drop time.
 */
export async function readSourceWithSidecar(sourcePath: string): Promise<string> {
  let content = ""
  try {
    content = await readFile(sourcePath)
  } catch {
    content = ""
  }
  try {
    const sidecar = await readFile(contextSidecarPath(sourcePath))
    if (sidecar && sidecar.trim()) {
      return `${sidecar.replace(/\s+$/, "")}\n\n${content}`
    }
  } catch {
    // No sidecar — the common case.
  }
  return content
}

export function buildContextBlock(note: string): string {
  const trimmed = note.trim()
  if (!trimmed) return ""
  const date = new Date().toISOString().slice(0, 10)
  return `${CHAT_CONTEXT_MARKER} added=${date} -->
## Context (added via chat)

${trimmed}

---

`
}

async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`
  if (!(await fileExists(basePath))) return basePath
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  if (!(await fileExists(withDate))) return withDate
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    if (!(await fileExists(withCounter))) return withCounter
  }
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

/**
 * Copy user-dropped files into raw/sources/, attaching the chat message as
 * "## Context" so the wiki has the WHY alongside the WHAT.
 *
 *   - Text-readable (md/txt/csv/code/...): prepend the block inline into
 *     the file. The source on disk now leads with `<!-- llmwiki:chat-context ... -->`.
 *   - Binary (pdf/docx/xlsx/...): write a sibling `.<name>.context.md` sidecar.
 *     ingest.readSourceWithSidecar() prepends it to the extracted text at
 *     parse time, so binaries see the same merged shape as text without
 *     having to mutate the binary itself.
 */
export async function addFilesToRawWithContext(
  project: WikiProject,
  sourcePaths: string[],
  contextNote: string,
  llmConfig: LlmConfig,
): Promise<AddFilesFromChatResult> {
  const pp = normalizePath(project.path)
  const block = buildContextBlock(contextNote)
  const imported: string[] = []
  const failed: string[] = []
  let contextApplied = 0

  for (const sourcePath of sourcePaths) {
    const originalName = getFileName(sourcePath) || "unknown"
    const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
    try {
      await copyFile(sourcePath, destPath)

      if (block) {
        const category = getFileCategory(destPath)
        if (isTextReadable(category)) {
          try {
            const existing = await readFile(destPath).catch(() => "")
            await writeFile(destPath, block + existing)
            contextApplied++
          } catch (err) {
            console.warn(
              `[raw-from-chat] inline prepend failed for ${destPath}:`,
              err instanceof Error ? err.message : err,
            )
          }
        } else {
          try {
            await writeFile(contextSidecarPath(destPath), block)
            contextApplied++
          } catch (err) {
            console.warn(
              `[raw-from-chat] sidecar write failed for ${destPath}:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
      }

      imported.push(destPath)
      preprocessFile(destPath).catch(() => {})
    } catch (err) {
      console.error(`[raw-from-chat] copy failed for ${originalName}:`, err)
      failed.push(sourcePath)
    }
  }

  if (imported.length > 0 && hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, imported, llmConfig)
  }

  return { imported, contextApplied, failed }
}

export interface UrlIngestFailure {
  url: string
  error: string
}

export interface AddUrlsFromChatResult {
  imported: string[]
  failed: UrlIngestFailure[]
}

const RAW_WEB_SUBDIR = "raw/sources/web"

function buildWebMarkdownFile(fetched: WebFetchResult, contextBlock: string): string {
  // Minimal YAML frontmatter — keeps the original URL machine-readable so a
  // future "re-fetch" action can just look at this field, and keeps title /
  // fetched-at out of the prose so wiki search doesn't index timestamps.
  const fm = [
    "---",
    `source_url: ${fetched.finalUrl}`,
    `title: ${JSON.stringify(fetched.title)}`,
    `fetched_at: ${fetched.fetchedAt}`,
    fetched.byline ? `byline: ${JSON.stringify(fetched.byline)}` : "",
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n")
  return `${fm}${contextBlock}# ${fetched.title}\n\n${fetched.markdown}\n`
}

export async function addUrlsToRawWithContext(
  project: WikiProject,
  urls: string[],
  contextNote: string,
  llmConfig: LlmConfig,
  options: { onProgress?: (url: string, status: "fetching" | "done" | "failed") => void } = {},
): Promise<AddUrlsFromChatResult> {
  const pp = normalizePath(project.path)
  const webDir = `${pp}/${RAW_WEB_SUBDIR}`
  const block = buildContextBlock(contextNote)
  const imported: string[] = []
  const failed: UrlIngestFailure[] = []

  // Best-effort dir create. createDirectory is idempotent.
  try {
    await createDirectory(webDir)
  } catch {
    // If write_file is happy to mkdir-p, this is redundant; if not, the
    // first writeFile will surface the same error.
  }

  for (const url of urls) {
    options.onProgress?.(url, "fetching")
    try {
      const fetched = await fetchAndExtract(url, { timeoutMs: 30000 })
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      const slug = slugFromTitle(fetched.title, "web")
      let destPath = `${webDir}/${slug}-${date}.md`
      let n = 2
      while (await fileExists(destPath)) {
        destPath = `${webDir}/${slug}-${date}-${n}.md`
        n++
        if (n > 99) {
          destPath = `${webDir}/${slug}-${date}-${Date.now()}.md`
          break
        }
      }
      await writeFile(destPath, buildWebMarkdownFile(fetched, block))
      imported.push(destPath)
      options.onProgress?.(url, "done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed.push({ url, error: msg })
      options.onProgress?.(url, "failed")
      console.warn(`[raw-from-chat] URL fetch failed (${url}):`, msg)
    }
  }

  if (imported.length > 0 && hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, imported, llmConfig)
  }

  return { imported, failed }
}
