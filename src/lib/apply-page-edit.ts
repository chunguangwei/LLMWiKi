import { readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"

export interface ApplyPageEditResult {
  /** The page existed and was backed up before overwriting. */
  backedUp: boolean
  /** The page did not exist before — this created a new page. */
  created: boolean
}

// Mirrors ingest.ts `backupExistingPage`: snapshot the old page under
// .llm-wiki/page-history/ so an applied edit is always recoverable.
// (writeFile creates parent dirs, matching the ingest backup path.)
async function backupExistingPage(
  projectPath: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  await writeFile(`${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`, existingContent)
}

// The page's creation date is a historical fact — never let an edit
// rewrite it. If the proposed content's frontmatter omits `created`,
// re-inject the original value just after the opening fence.
function preserveCreated(newContent: string, existingCreated: string): string {
  const parsed = parseFrontmatter(newContent)
  if (parsed.frontmatter && parsed.frontmatter.created != null) return newContent
  if (/^---\s*\r?\n/.test(newContent)) {
    return newContent.replace(/^(---\s*\r?\n)/, `$1created: ${existingCreated}\n`)
  }
  return newContent
}

async function appendLog(projectPath: string, relativePath: string, created: boolean): Promise<void> {
  try {
    const logPath = `${projectPath}/wiki/log.md`
    let log = ""
    try {
      log = await readFile(logPath)
    } catch {
      log = "# Wiki Log\n\n"
    }
    const date = new Date().toISOString().slice(0, 10)
    const verb = created ? "Created" : "Edited (via chat)"
    const entry = `- ${date}: ${verb} \`${relativePath}\`\n`
    await writeFile(logPath, log.trimEnd() + "\n" + entry)
  } catch {
    // Logging is best-effort — never block the edit on it.
  }
}

/**
 * Apply an LLM-proposed edit to a wiki page: back up the existing page
 * (if any), preserve its `created` date, write the new content, and log
 * it. Pure filesystem work — the caller is responsible for refreshing
 * the UI (setFileTree / bumpDataVersion / reloading the preview).
 */
export async function applyPageEdit(
  projectPath: string,
  relativePath: string,
  newContent: string,
): Promise<ApplyPageEditResult> {
  const pp = normalizePath(projectPath)
  const rel = relativePath.replace(/^\/+/, "")
  const full = `${pp}/${rel}`

  let existing = ""
  let existed = false
  try {
    existing = await readFile(full)
    existed = true
  } catch {
    existed = false
  }

  let toWrite = newContent
  if (existed && existing.trim()) {
    await backupExistingPage(pp, rel, existing)
    const created = parseFrontmatter(existing).frontmatter?.created
    if (created != null) toWrite = preserveCreated(newContent, String(created))
  }

  await writeFile(full, toWrite)
  await appendLog(pp, rel, !existed)

  return { backedUp: existed && !!existing.trim(), created: !existed }
}
