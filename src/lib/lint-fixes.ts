import { createDirectory, fileExists, writeFile } from "@/commands/fs"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { makeQuerySlug } from "@/lib/wiki-filename"

// One-click link-repair primitives used by the Lint view. These are the
// pure, file-level edits behind a lint Fix: rewrite a typo'd wikilink,
// append a "Related" link, or stub out a missing target page. Kept
// separate from lint.ts (the analysis) so they can be unit-tested
// against the fs mock without running a full structural lint.

/** Canonicalise a wikilink target for comparison: strip the optional
 *  `wiki/` prefix and `.md` suffix, then trim. Casing is preserved here
 *  (callers lowercase when they need a case-insensitive compare). */
export function lintLinkTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
}

function normalizedLintLinkTarget(target: string): string {
  return lintLinkTarget(target).toLowerCase()
}

/** Does `content` already contain a wikilink (aliased or not) to
 *  `target`? Case-insensitive match against the canonical target so we
 *  never append a duplicate link. */
function hasWikilinkToTarget(content: string, target: string): boolean {
  const normalized = normalizedLintLinkTarget(target)
  return Array.from(content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g))
    .some((match) => normalizedLintLinkTarget(match[1]) === normalized)
}

/** Add a `- [[target]]` link to `content`. No-op if the link already
 *  exists. Inserts under an existing `## Related` heading when present,
 *  otherwise appends a fresh "Related" section at the end. */
export function appendWikilink(content: string, target: string): string {
  const linkTarget = lintLinkTarget(target)
  if (hasWikilinkToTarget(content, linkTarget)) return content
  const linkLine = `- [[${linkTarget}]]`
  const relatedHeading = /^##\s+Related\s*$/im.exec(content)
  if (relatedHeading) {
    const insertAt = relatedHeading.index + relatedHeading[0].length
    return `${content.slice(0, insertAt)}\n${linkLine}${content.slice(insertAt)}`
  }
  return `${content.trimEnd()}\n\n## Related\n${linkLine}\n`
}

/** Rewrite every wikilink whose target matches `brokenTarget` to point
 *  at `suggestedTarget`, preserving any `|alias`. Non-matching links are
 *  returned byte-identical (the broken target is matched
 *  case-insensitively). */
export function rewriteWikilinkTarget(
  content: string,
  brokenTarget: string,
  suggestedTarget: string,
): string {
  const broken = normalizedLintLinkTarget(brokenTarget)
  const replacement = lintLinkTarget(suggestedTarget)
  return content.replace(
    /\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g,
    (match, rawTarget: string, rawAlias?: string) => {
      if (normalizedLintLinkTarget(rawTarget) !== broken) return match
      return `[[${replacement}${rawAlias ?? ""}]]`
    },
  )
}

/** Where would a stub for `brokenTarget` live? An explicit subfolder in
 *  the target (e.g. "concepts/Foo Bar") is honoured (slugified per
 *  segment); a bare name lands under `queries/`. Always `.md`. */
export function stubRelativePathFromBrokenTarget(brokenTarget: string): string {
  const normalized = lintLinkTarget(brokenTarget)
  const parts = normalized
    .split("/")
    .map((part) => makeQuerySlug(part))
    .filter(Boolean)
  const rel = parts.length > 1
    ? parts.join("/")
    : `queries/${parts[0] ?? "missing-page"}`
  return `${rel}.md`
}

function stubTitleFromBrokenTarget(brokenTarget: string): string {
  return getFileName(lintLinkTarget(brokenTarget))
    .replace(/[-_]+/g, " ")
    .trim() || "Missing Page"
}

/** Ensure a stub page exists for a broken wikilink target. Reuses an
 *  already-present page at the slugified path (never overwrites), else
 *  creates a minimal frontmatter+heading placeholder. Returns the
 *  resolved paths and whether a new file was written. */
export async function ensureBrokenLinkStub(
  projectPath: string,
  brokenTarget: string,
): Promise<{ fullPath: string; relativePath: string; created: boolean }> {
  const relativePath = stubRelativePathFromBrokenTarget(brokenTarget)
  const fullPath = `${projectPath}/wiki/${relativePath}`
  if (await fileExists(fullPath)) {
    return { fullPath, relativePath, created: false }
  }

  const parent = fullPath.split("/").slice(0, -1).join("/")
  await createDirectory(parent)
  const title = stubTitleFromBrokenTarget(brokenTarget)
  const date = new Date().toISOString().slice(0, 10)
  const content = [
    "---",
    "type: query",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `created: ${date}`,
    `updated: ${date}`,
    "tags: [stub, lint]",
    "related: []",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    "Created by Wiki Lint as a placeholder for a missing wikilink target.",
    "",
  ].join("\n")
  await writeFile(fullPath, content)
  return { fullPath, relativePath, created: true }
}
