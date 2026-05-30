/**
 * Source-outline extractor — pulls the heading tree out of a markdown
 * source document so the agent can plan its extraction order without
 * re-reading the whole file.
 *
 * Why deterministic rather than LLM-extracted:
 *
 *   The design doc (§2) mentions "1 LLM call for outline" as a hedge
 *   in case sources arrive as binary-derived plain text with no
 *   structural cues. For .md sources — which is what 99% of the
 *   ingest pipeline sees, because PDFs / DOCX have ALREADY been
 *   extracted to markdown by the Rust extractor before ingest — the
 *   headings are right there in the file (`# title`, `## section`).
 *   Parsing them is free, deterministic, and produces a stable
 *   chunk_id mapping that the LLM can rely on across turns.
 *
 *   When the source genuinely has no headings (a wall-of-text dump
 *   from a website's article body, or OCR output of a hand-written
 *   memo), the parser returns an empty outline. The agent loop must
 *   tolerate that — read_outline() returning no headings simply
 *   means "no skeleton, fall back to search_source".
 *
 * What this is NOT:
 *
 *   - Not an opinion about what counts as a "section" — every ATX
 *     heading (`#` through `######`) is captured. The agent decides
 *     which level to recurse into.
 *   - Not a content extractor — only the heading line is captured,
 *     not the body text underneath. Body lives in chunks, accessed
 *     via read_chunk.
 *   - Not aware of code blocks / front matter / HTML comments — see
 *     §2.1 below for the precise filtering rules.
 *
 * §2.1 — Filtering rules
 *
 *   1. Headings inside fenced code blocks (```...```) are SKIPPED.
 *      Otherwise a markdown tutorial showing `# Example` as code would
 *      pollute the outline. Both ``` and ~~~ fences are recognised.
 *   2. YAML frontmatter at the top of the file (between `---` markers)
 *      is skipped wholesale — no headings extracted from it.
 *   3. Setext-style underlines (`title\n====`) are NOT supported.
 *      The wiki's ingest pipeline normalises to ATX headings; if a
 *      future source bypasses that, we revisit.
 *   4. Indented headings (more than 3 spaces of leading whitespace —
 *      CommonMark's threshold for "this is a code block") are
 *      SKIPPED, same rationale as #1.
 */

/**
 * "Raw" heading from the markdown parser — has level/text/line_start
 * but no chunk_id yet. `associateOutlineWithChunks` upgrades these
 * into the full `OutlineHeading` shape from `types.ts` once smart-
 * split has produced the chunk list.
 *
 * Kept as a separate type so the parser stays a pure function over
 * markdown text, independent of the agent-ingest pipeline's other
 * primitives.
 */
export interface RawOutlineHeading {
  /** ATX heading depth: 1 = `# H1`, 2 = `## H2`, ..., 6 = `###### H6`. */
  level: number
  /** The heading text, with the leading `#` markers and surrounding
   *  whitespace stripped. Trailing `#` markers (the optional closing
   *  sequence per CommonMark §4.2) are also stripped. */
  text: string
  /** 1-based line number where this heading appears in the source. */
  line_start: number
}

/**
 * Extract every ATX heading from `source` and return them in document
 * order. Empty input → empty result; never throws.
 */
export function extractOutlineFromMarkdown(source: string): RawOutlineHeading[] {
  if (!source) return []
  const lines = source.split("\n")
  const headings: RawOutlineHeading[] = []

  // State machine for "should this line be parsed as a heading?"
  let inCodeFence: false | "```" | "~~~" = false
  let inFrontmatter = false
  let frontmatterEndsAtLine: number | null = null

  // Detect YAML frontmatter only if it starts on line 1. CommonMark
  // doesn't define frontmatter but the convention is universal in
  // our ingest output.
  if (lines[0]?.trim() === "---") {
    inFrontmatter = true
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        frontmatterEndsAtLine = i  // 0-indexed
        break
      }
    }
    if (frontmatterEndsAtLine === null) {
      // Unterminated frontmatter — treat the whole file as frontmatter,
      // produce empty outline. This is a malformed input but we don't
      // crash on it.
      return []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (inFrontmatter) {
      if (i === frontmatterEndsAtLine) inFrontmatter = false
      continue
    }
    const line = lines[i]

    // Track code fences. Both ``` and ~~~ supported. Closing fence
    // must use the SAME marker that opened the block. Info strings
    // (e.g. ```ts) after the marker are tolerated.
    const fenceMatch = line.match(/^(```|~~~)(?:\s*[a-zA-Z0-9_-]*)?\s*$/)
    if (fenceMatch) {
      const marker = fenceMatch[1] as "```" | "~~~"
      if (inCodeFence === false) {
        inCodeFence = marker
      } else if (inCodeFence === marker) {
        inCodeFence = false
      }
      // If marker differs (e.g. ~~~ inside a ``` block), don't toggle.
      continue
    }
    if (inCodeFence) continue

    // 4+ leading spaces = indented code block per CommonMark.
    // 0-3 leading spaces is fine for headings.
    const leading = line.match(/^( {0,3})(#{1,6})\s+(.+?)\s*$/)
    if (!leading) continue
    const level = leading[2].length
    let text = leading[3]
    // Strip optional closing # sequence (CommonMark §4.2).
    const closingTrail = text.match(/^(.*?)\s+#+\s*$/)
    if (closingTrail) text = closingTrail[1]
    text = text.trim()
    if (text.length === 0) continue

    headings.push({
      level,
      text,
      line_start: i + 1,  // convert 0-indexed → 1-indexed
    })
  }

  return headings
}

/**
 * Associate each outline heading with the smart-split chunk that
 * contains it, given a list of chunks with line ranges. Used by the
 * pre-process step (Phase B) to build the AgentContext's outline
 * with `chunk_id` populated.
 *
 * Headings outside every chunk's line range (shouldn't happen if
 * chunks tile the document) are silently dropped — the caller
 * should validate coverage if it cares.
 */
export function associateOutlineWithChunks<T extends { chunk_id: string; line_range: [number, number] }>(
  outline: RawOutlineHeading[],
  chunks: T[],
): Array<RawOutlineHeading & { chunk_id: string }> {
  const result: Array<RawOutlineHeading & { chunk_id: string }> = []
  for (const heading of outline) {
    const chunk = chunks.find(
      (c) => heading.line_start >= c.line_range[0] && heading.line_start <= c.line_range[1],
    )
    if (chunk) {
      result.push({ ...heading, chunk_id: chunk.chunk_id })
    }
  }
  return result
}
