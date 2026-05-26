/**
 * Best-effort sync of `wiki/index.md` when a page's `type:` is changed
 * from the preview panel's type selector.
 *
 * `index.md` is an LLM-maintained catalog: pages are listed as
 * `* [[slug]] — description` bullets under `## <category>` headings,
 * where the heading text is the page type's localized label (e.g.
 * `## 书籍`, or the English legacy names `## Sources` / `## Concepts`).
 * A source page also appears a second time under the `## Sources`
 * listing — that occurrence is left untouched.
 *
 * This relocates the page's *category* bullet to the section matching
 * its new type, creating that section if needed. It is deliberately
 * best-effort: if the page can't be found it is added fresh, and if
 * nothing actually changes the original string is returned so the
 * caller can skip the write.
 *
 * Pure string transform (no I/O) so it's unit-testable.
 */
export interface RecategorizeArgs {
  /** Page filename without extension — the `[[wikilink]]` target. */
  slug: string
  /** Heading text to create when the target section doesn't exist. */
  targetLabel: string
  /** Existing headings that count as the target section (e.g. localized + English label). */
  targetAliases: string[]
  /** Headings treated as the Sources listing — never moved out of. */
  sourcesAliases: string[]
  /** Description for a freshly-created bullet when the page wasn't listed. */
  fallbackDescription?: string
}

interface Section {
  heading: string
  lines: string[]
}

const BULLET_RE = /^\s*[-*]\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/

function matchesSlug(line: string, slug: string): boolean {
  const m = line.match(BULLET_RE)
  if (!m) return false
  return m[1].trim().toLowerCase() === slug.trim().toLowerCase()
}

function headingIn(heading: string, names: string[]): boolean {
  const h = heading.trim().toLowerCase()
  return names.some((n) => n.trim().toLowerCase() === h)
}

export function recategorizeIndexEntry(indexContent: string, args: RecategorizeArgs): string {
  const { slug, targetLabel, targetAliases, sourcesAliases, fallbackDescription } = args
  const lines = indexContent.split("\n")

  // Split into a preamble (frontmatter + title, before the first `##`)
  // and a list of `## ` sections.
  const preamble: string[] = []
  const sections: Section[] = []
  let cur: Section | null = null
  for (const line of lines) {
    const hm = line.match(/^##\s+(.+?)\s*$/)
    if (hm) {
      cur = { heading: hm[1], lines: [] }
      sections.push(cur)
    } else if (cur) {
      cur.lines.push(line)
    } else {
      preamble.push(line)
    }
  }

  const isSources = (s: Section) => headingIn(s.heading, sourcesAliases)
  const isTarget = (s: Section) => headingIn(s.heading, targetAliases)

  // Locate the page's category bullet: first matching bullet in a
  // non-Sources section. (The Sources duplicate stays put.)
  let foundSection: Section | null = null
  let foundLineIdx = -1
  for (const s of sections) {
    if (isSources(s)) continue
    const idx = s.lines.findIndex((l) => matchesSlug(l, slug))
    if (idx !== -1) {
      foundSection = s
      foundLineIdx = idx
      break
    }
  }

  // Already in the right place → nothing to do.
  if (foundSection && isTarget(foundSection)) return indexContent

  // The bullet text to place under the new section.
  let entryLine = foundSection ? foundSection.lines[foundLineIdx] : ""
  if (!entryLine) {
    // Page wasn't listed under a category. Reuse a Sources description if
    // one exists, else the caller's fallback.
    let desc = fallbackDescription?.trim() ?? ""
    for (const s of sections) {
      if (!isSources(s)) continue
      const srcLine = s.lines.find((l) => matchesSlug(l, slug))
      if (srcLine) {
        const dm = srcLine.match(/—\s*(.+?)\s*$/)
        if (dm) desc = dm[1]
        break
      }
    }
    entryLine = desc ? `* [[${slug}]] — ${desc}` : `* [[${slug}]]`
  }

  // Remove the old category bullet (and a trailing blank line, if any).
  if (foundSection) {
    foundSection.lines.splice(foundLineIdx, 1)
    if (foundSection.lines[foundLineIdx] === "") {
      foundSection.lines.splice(foundLineIdx, 1)
    }
  }

  // Find or create the target section, then append the bullet.
  let target = sections.find(isTarget) ?? null
  if (!target) {
    target = { heading: targetLabel, lines: [] }
    sections.push(target)
  }
  // Avoid duplicating if it's somehow already there.
  if (!target.lines.some((l) => matchesSlug(l, slug))) {
    // Keep the blank-line-separated bullet style.
    while (target.lines.length && target.lines[target.lines.length - 1] === "") {
      target.lines.pop()
    }
    if (target.lines.length) target.lines.push("")
    target.lines.push(entryLine)
    target.lines.push("")
  }

  // Reassemble.
  const out: string[] = [...preamble]
  for (const s of sections) {
    out.push(`## ${s.heading}`)
    out.push(...s.lines)
  }
  const result = out.join("\n")
  return result === indexContent ? indexContent : result
}
