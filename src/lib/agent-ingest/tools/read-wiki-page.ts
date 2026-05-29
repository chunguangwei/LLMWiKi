/**
 * Tool: `read_wiki_page` — fetch one wiki page's full content.
 *
 * Pure read over `ctx.wikiAccess.readPage(slug)`. The natural
 * follow-up to `list_wiki_pages`: the agent sees there's already
 * a "concepts/foo" page, reads it, and decides whether the new
 * source material warrants an update.
 *
 * Returns parsed frontmatter + raw body so the agent can:
 *   - Check `related: [...]` to see which wikilinks already exist
 *     (avoid redundant link_pages calls)
 *   - Check `sources: [...]` to see which raw sources have already
 *     informed this page (avoid double-counting)
 *   - Read the body to know what's already covered
 *
 * Error contract:
 *
 *   `slug_not_found` is the documented response for a missing
 *   page. The LLM almost always self-corrects by calling
 *   list_wiki_pages — same self-correction pattern as
 *   read_chunk's chunk_not_found.
 */
import type { AgentContext, WikiPageFull } from "../types"
import type { ToolDefinition } from "./index"

export interface ReadWikiPageInput {
  slug: string
}

export type ReadWikiPageResult =
  | WikiPageFull
  | { error: "slug_not_found"; detail: string }
  | { error: "invalid_input"; detail: string }

export const readWikiPageTool: ToolDefinition<ReadWikiPageInput, ReadWikiPageResult> = {
  name: "read_wiki_page",
  description:
    "Read one wiki page's full content by its slug (wiki-relative path " +
    "without .md, as returned by list_wiki_pages). Returns the slug, " +
    "type, title, parsed frontmatter (with `related: [...]` and " +
    "`sources: [...]` if present), and the markdown body. Use this to " +
    "decide between update_wiki_page (extend an existing page) and " +
    "write_wiki_page (create a new one). Returns " +
    "{ error: 'slug_not_found', ... } when no page matches; call " +
    "list_wiki_pages to find valid slugs.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Wiki-relative path without the .md extension, e.g. " +
          "'concepts/foo' or 'Books/原则-读书笔记'. Must be non-empty.",
        minLength: 1,
      },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  async execute(input: ReadWikiPageInput, ctx: AgentContext): Promise<ReadWikiPageResult> {
    if (ctx.signal.aborted) {
      throw new Error("read_wiki_page aborted by signal")
    }
    if (typeof input?.slug !== "string" || input.slug.trim().length === 0) {
      return {
        error: "invalid_input",
        detail: "slug must be a non-empty string",
      }
    }
    const page = await ctx.wikiAccess.readPage(input.slug.trim())
    if (!page) {
      return {
        error: "slug_not_found",
        detail:
          `No wiki page with slug "${input.slug.trim()}". ` +
          "Call list_wiki_pages to find valid slugs.",
      }
    }
    // Project to the documented surface.
    return {
      slug: page.slug,
      type: page.type,
      title: page.title,
      frontmatter: page.frontmatter,
      body: page.body,
    }
  },
}
