/**
 * Tool: `link_pages` — add a wikilink from one page to another.
 *
 * Used by the agent to thread the knowledge graph as it goes:
 * "this report mentions [concept X] which already has a page →
 * add the link both ways". Without explicit linking, the wiki's
 * graph-based retrieval (4-signal relevance) sees the pages as
 * unrelated even when they're about the same subject.
 *
 * Semantics:
 *
 *   - `from`'s `related:` frontmatter array gains `to` (if missing).
 *   - `bidirectional` (default false): when true, `to` also gains
 *     `from`. Each direction is independent — the runner reports
 *     `from_was_new` / `to_was_new` so the agent knows whether the
 *     call actually changed the file (telemetry; re-linking is
 *     safe / idempotent).
 *
 * Validation:
 *
 *   - Both slugs go through validateSlug (path traversal, Windows-
 *     reserved names, .md extension all rejected).
 *   - `from === to` is rejected as invalid_input — self-links don't
 *     make sense in a knowledge graph and almost always indicate
 *     an LLM tool-call typo.
 *
 * Error contract:
 *
 *   - `slug_not_found` reports which slug was missing
 *     (`missing: "from" | "to"`) so the LLM can fix the right one
 *     without having to test each independently.
 *   - `validation_failed` forwards impl detail.
 *
 * No tracker hook — linking is a wiki-shape change, not a
 * source-coverage change. mark_section_covered is the right tool
 * for "I extracted this chunk and produced page X"; link_pages is
 * purely about cross-referencing already-existing pages.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"
import { validateSlug } from "../slug"

export interface LinkPagesInput {
  from_slug: string
  to_slug: string
  bidirectional?: boolean
}

export type LinkPagesResult =
  | { ok: true; from_was_new: boolean; to_was_new?: boolean }
  | { error: "slug_not_found"; detail: string; missing: "from" | "to" }
  | { error: "invalid_input"; detail: string }
  | { error: "validation_failed"; detail: string }

export const linkPagesTool: ToolDefinition<LinkPagesInput, LinkPagesResult> = {
  name: "link_pages",
  description:
    "Add a wikilink from one existing page to another. Updates the " +
    "`related:` frontmatter on `from_slug` to include `to_slug`. " +
    "If bidirectional=true, also adds `from_slug` to `to_slug`'s " +
    "`related:`. Idempotent — re-linking an already-linked pair is " +
    "a no-op. The result reports `from_was_new` (and `to_was_new` " +
    "when bidirectional) so you can avoid redundant calls. Both " +
    "slugs must point at existing pages; `slug_not_found.missing` " +
    "tells you which side was wrong.",
  inputSchema: {
    type: "object",
    properties: {
      from_slug: {
        type: "string",
        description: "Slug of the source page (wiki-relative, no .md).",
        minLength: 1,
        maxLength: 200,
      },
      to_slug: {
        type: "string",
        description: "Slug of the target page (wiki-relative, no .md).",
        minLength: 1,
        maxLength: 200,
      },
      bidirectional: {
        type: "boolean",
        description:
          "When true, also add from_slug to to_slug's `related:`. Default false.",
      },
    },
    required: ["from_slug", "to_slug"],
    additionalProperties: false,
  },
  async execute(input: LinkPagesInput, ctx: AgentContext): Promise<LinkPagesResult> {
    if (ctx.signal.aborted) {
      throw new Error("link_pages aborted by signal")
    }

    const fromReason = validateSlug(input?.from_slug)
    if (fromReason) return { error: "invalid_input", detail: `from_slug: ${fromReason}` }
    const toReason = validateSlug(input?.to_slug)
    if (toReason) return { error: "invalid_input", detail: `to_slug: ${toReason}` }

    const from = (input.from_slug as string).trim()
    const to = (input.to_slug as string).trim()

    if (from === to) {
      return {
        error: "invalid_input",
        detail:
          `Self-links are not allowed: from_slug and to_slug both = "${from}". ` +
          "A page linking to itself doesn't add information to the graph.",
      }
    }

    const bidirectional =
      typeof input.bidirectional === "boolean" ? input.bidirectional : false

    const result = await ctx.wikiAccess.linkPages({ from, to, bidirectional })

    if (result.kind === "slug_not_found") {
      const which = result.missing
      const missingSlug = which === "from" ? from : to
      return {
        error: "slug_not_found",
        missing: which,
        detail:
          `${which}_slug "${missingSlug}" has no wiki page. ` +
          "Call list_wiki_pages to confirm the slug, or write_wiki_page " +
          "to create the missing page first.",
      }
    }
    if (result.kind === "validation_failed") {
      return { error: "validation_failed", detail: result.detail }
    }

    // Project only the documented fields. to_was_new is included
    // only when bidirectional — same convention as the WikiAccess
    // return shape so the LLM doesn't see a misleading "false" for
    // a direction it didn't ask about.
    return {
      ok: true,
      from_was_new: result.from_was_new,
      ...(bidirectional ? { to_was_new: result.to_was_new ?? false } : {}),
    }
  },
}
