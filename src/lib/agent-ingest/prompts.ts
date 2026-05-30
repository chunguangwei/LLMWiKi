/**
 * System + initial-user prompt builders for the agent ingest run.
 *
 * Stays in its own module so prompt iteration (which we'll do
 * during Phase F validation) doesn't churn the runner / entry
 * point. Pure functions — no I/O.
 */
import type { OutlineHeading, WikiPageSummary } from "./types"

/** Top-level instruction the model sees before the tool catalogue. */
export function buildSystemPrompt(opts: {
  /** Project's purpose.md content if available — describes what the
   *  wiki is FOR (focus, audience, scope). Empty string when missing. */
  purpose?: string
  /** Project's schema.md / type list if available. Empty when missing. */
  schema?: string
}): string {
  const parts: string[] = []
  parts.push(
    "You are an ingestion agent for a personal knowledge wiki. Your job is " +
      "to read ONE source document and extract its content into the wiki " +
      "as a small number of focused pages. The wiki is the long-term " +
      "memory; you are the editor who adds to it incrementally.",
  )
  parts.push(
    "Available actions are the tools you have been given. Read the source " +
      "via search_source / read_chunk; consult the existing wiki via " +
      "list_wiki_pages / read_wiki_page so you don't duplicate; write new " +
      "knowledge via write_wiki_page or extend an existing page via " +
      "update_wiki_page. Use link_pages to thread the knowledge graph. " +
      "Mark each processed chunk with mark_section_covered, surface " +
      "topics you see but won't extract via surface_gap, and call done " +
      "when finished. Calling done is REQUIRED — do not stop without it.",
  )
  parts.push(
    "Default behaviour: small, focused pages over single mega-pages. One " +
      "page per concept, entity, or report — not per source. If a topic " +
      "is mentioned in passing without enough material for a stand-alone " +
      "page, surface_gap it rather than padding a thin stub.",
  )
  parts.push(
    "Quality guard rails: NEVER invent content the source doesn't support. " +
      "If you write a page, every claim should be traceable to a chunk you " +
      "read. Frontmatter `type:` must be one of the project's allowed types. " +
      "Use Chinese page titles for Chinese sources; English titles for English. " +
      "Tone matches the source — no editorialising.",
  )
  if (opts.purpose && opts.purpose.trim().length > 0) {
    parts.push(`## Wiki purpose\n\n${opts.purpose.trim()}`)
  }
  if (opts.schema && opts.schema.trim().length > 0) {
    parts.push(`## Wiki schema (allowed types)\n\n${opts.schema.trim()}`)
  }
  return parts.join("\n\n")
}

/**
 * Initial user message — feeds the model the source's outline plus
 * a summary of the wiki's existing pages, then asks it to begin.
 *
 * Why bundle outline + wiki state in the FIRST user turn rather
 * than letting the model call read_outline / list_wiki_pages:
 *
 *   - Saves two round-trips on every run (both calls would happen
 *     anyway, predictably).
 *   - Anchors the model's plan from the start — "here's what's
 *     in the source, here's what's already in the wiki, decide
 *     what to do". The alternative is the model spending its
 *     first turn reading outline blind.
 *
 * The model is still free to re-query both via tools later
 * (`list_wiki_pages` after writing a new page, etc.).
 */
export function buildInitialUserPrompt(opts: {
  sourcePath: string
  outline: OutlineHeading[]
  existingPages: WikiPageSummary[]
}): string {
  const parts: string[] = []
  parts.push(
    `You are ingesting source \`${opts.sourcePath}\`. Read it section by ` +
      "section, decide what to extract, write or update wiki pages, and " +
      "call `done` when finished.",
  )

  parts.push("## Source outline\n\n" + renderOutline(opts.outline))

  parts.push(
    "## Existing wiki pages\n\n" +
      renderExistingPages(opts.existingPages),
  )

  parts.push(
    "Begin by reviewing the outline above. For each section that warrants " +
      "extraction, use `read_chunk` to read its content, then decide between " +
      "`write_wiki_page` (new topic) and `update_wiki_page` (existing topic). " +
      "Mark every chunk you process with `mark_section_covered`. End the " +
      "session with `done` and a brief rationale.",
  )

  return parts.join("\n\n")
}

function renderOutline(outline: OutlineHeading[]): string {
  if (outline.length === 0) {
    return "_The source has no ATX headings. Use search_source to find " +
      "relevant chunks by keyword._"
  }
  const lines: string[] = []
  for (const h of outline) {
    const indent = "  ".repeat(Math.max(0, h.level - 1))
    lines.push(
      `${indent}- ${"#".repeat(h.level)} ${h.text} (chunk \`${h.chunk_id}\`, line ${h.line_start})`,
    )
  }
  return lines.join("\n")
}

function renderExistingPages(pages: WikiPageSummary[]): string {
  if (pages.length === 0) {
    return "_The wiki has no knowledge pages yet. Anything you write will be " +
      "the first._"
  }
  // Group by type for readability — the LLM scans by type.
  const byType = new Map<string, WikiPageSummary[]>()
  for (const p of pages) {
    const list = byType.get(p.type) ?? []
    list.push(p)
    byType.set(p.type, list)
  }
  const sortedTypes = Array.from(byType.keys()).sort()
  const lines: string[] = []
  for (const type of sortedTypes) {
    lines.push(`### ${type}`)
    for (const p of byType.get(type)!) {
      lines.push(`- \`${p.slug}\` — **${p.title}** — ${p.description}`)
    }
    lines.push("")
  }
  return lines.join("\n").trim()
}
