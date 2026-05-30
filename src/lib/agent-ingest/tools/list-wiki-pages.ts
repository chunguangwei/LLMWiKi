/**
 * Tool: `list_wiki_pages` — survey what's already in the wiki.
 *
 * Pure read over `ctx.wikiAccess.listPages()`. The agent calls this
 * BEFORE deciding whether to create or update — without it, the
 * model has no way to know the wiki already has a page on this
 * topic and would duplicate. With it, the loop's natural cycle is:
 *
 *   read_outline → list_wiki_pages → for each concept:
 *     search existing wiki → update OR write a new page
 *
 * Filtering by `type` is optional; omitting it returns every
 * knowledge page. Structural pages (index.md / log.md /
 * overview.md) are excluded by the WikiAccess implementation.
 *
 * The output is intentionally lightweight (slug + type + title +
 * description + related) so the agent can scan many pages in one
 * tool call without burning context. For the body, the agent
 * follows up with `read_wiki_page(slug)`.
 */
import type { AgentContext, WikiPageSummary } from "../types"
import type { ToolDefinition } from "./index"

export interface ListWikiPagesInput {
  /** Optional frontmatter `type:` filter, e.g. "concept", "report",
   *  "entity". Case-sensitive (matches the actual frontmatter value).
   *  Omit to return every page. */
  type?: string
}

export interface ListWikiPagesResult {
  pages: WikiPageSummary[]
}

export const listWikiPagesTool: ToolDefinition<ListWikiPagesInput, ListWikiPagesResult> = {
  name: "list_wiki_pages",
  description:
    "List the wiki's existing knowledge pages (excluding structural " +
    "pages like index.md / log.md / overview.md). Each entry has the " +
    "page slug (wiki-relative path without .md), its type, title, a " +
    "short description, and related slugs. Pass type to filter to one " +
    "category. Use this BEFORE writing a new page to avoid duplicates — " +
    "if a relevant page exists, prefer update_wiki_page over " +
    "write_wiki_page.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description:
          "Frontmatter `type:` slug to filter by (e.g. 'concept', " +
          "'report', 'entity'). Omit for all pages.",
        minLength: 1,
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input: ListWikiPagesInput, ctx: AgentContext): Promise<ListWikiPagesResult> {
    if (ctx.signal.aborted) {
      throw new Error("list_wiki_pages aborted by signal")
    }
    const typeFilter =
      typeof input?.type === "string" && input.type.trim().length > 0
        ? input.type.trim()
        : undefined
    const pages = await ctx.wikiAccess.listPages(
      typeFilter ? { type: typeFilter } : undefined,
    )
    // Project to the documented surface — same defence against
    // future runner-attached metadata as read_outline / read_chunk.
    return {
      pages: pages.map((p) => ({
        slug: p.slug,
        type: p.type,
        title: p.title,
        description: p.description,
        ...(p.related && p.related.length > 0 ? { related: p.related } : {}),
      })),
    }
  },
}
