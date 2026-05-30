/**
 * Tool: `update_wiki_page` — extend an existing wiki page.
 *
 * Companion to write_wiki_page. The agent calls this when
 * list_wiki_pages / read_wiki_page reveal a page already exists on
 * the topic — instead of duplicating (which would split the wiki's
 * knowledge across two pages), the agent re-writes the body and the
 * runner replaces the previous content atomically.
 *
 * Semantic contract (mirrors WikiAccess.updatePage):
 *
 *   - `body` is the COMPLETE new body. The runner replaces the
 *     previous body, preserves the frontmatter type/title/created,
 *     bumps `updated:`, and reports the diff in chars as
 *     `added_chars` (clamped at 0; shrinks aren't reported as
 *     negative — that would surprise the LLM looking for a
 *     "growth" signal).
 *   - `related` (if provided): the runner UNION-merges with the
 *     existing list. Empty array is a no-op (clearing requires
 *     direct file edit, not this tool).
 *   - `tags` (if provided): same union-merge semantics.
 *   - `type:` and `title:` are NOT changeable via this tool — the
 *     agent's mental model is "this page IS about topic X, I'm
 *     just adding more to it". Retyping is a delete+write.
 *
 * Error contract:
 *
 *   - `slug_not_found` is the documented failure when the agent
 *     tries to update a page that doesn't exist. The detail message
 *     points at write_wiki_page as the recovery — same self-
 *     correction pattern as read_wiki_page.
 *   - `validation_failed` for impl-side rejections (invalid related
 *     slug references, body too large, ...). Detail is forwarded
 *     verbatim from WikiAccess so the LLM sees the actual reason.
 *
 * Tracker hook: on success, tracker.markUpdated(slug, []). Empty
 * fromChunks for the same reason write_wiki_page passes empty —
 * chunk attribution is via mark_section_covered, not inferred from
 * write/update calls.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"
import { validateSlug } from "../slug"

export interface UpdateWikiPageInput {
  slug: string
  body: string
  related?: string[]
  tags?: string[]
}

export type UpdateWikiPageResult =
  | { ok: true; path: string; slug: string; added_chars: number }
  | { error: "slug_not_found"; detail: string }
  | { error: "invalid_input"; detail: string }
  | { error: "validation_failed"; detail: string }

export const updateWikiPageTool: ToolDefinition<UpdateWikiPageInput, UpdateWikiPageResult> = {
  name: "update_wiki_page",
  description:
    "Replace the body of an existing wiki page with new markdown. " +
    "Use this when list_wiki_pages / read_wiki_page reveal a page " +
    "already exists on this topic — extending preserves the wiki's " +
    "single-source-of-truth invariant instead of duplicating. body " +
    "is the COMPLETE new body (the runner replaces atomically); " +
    "frontmatter type/title/created are preserved. related and tags, " +
    "if provided, are UNION-merged with existing values (empty array " +
    "is a no-op; clearing requires direct edit). Returns " +
    "{ error: 'slug_not_found' } when the slug has no page — call " +
    "write_wiki_page in that case.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "Wiki-relative slug WITHOUT the .md extension, e.g. 'concepts/foo'.",
        minLength: 1,
        maxLength: 200,
      },
      body: {
        type: "string",
        description: "Complete new markdown body. Replaces the previous body atomically.",
        minLength: 1,
      },
      related: {
        type: "array",
        description: "Slugs to UNION-add to the page's `related:` frontmatter array.",
        items: { type: "string", minLength: 1 },
      },
      tags: {
        type: "array",
        description: "Tags to UNION-add to the page's `tags:` frontmatter array.",
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["slug", "body"],
    additionalProperties: false,
  },
  async execute(input: UpdateWikiPageInput, ctx: AgentContext): Promise<UpdateWikiPageResult> {
    if (ctx.signal.aborted) {
      throw new Error("update_wiki_page aborted by signal")
    }

    const slugReason = validateSlug(input?.slug)
    if (slugReason) return { error: "invalid_input", detail: `slug: ${slugReason}` }
    const slug = (input.slug as string).trim()

    if (typeof input?.body !== "string" || input.body.trim().length === 0) {
      return { error: "invalid_input", detail: "body must be a non-empty string" }
    }

    const related = sanitizeStringArray(input.related, "related")
    if ("error" in related) return related.error
    const tags = sanitizeStringArray(input.tags, "tags")
    if ("error" in tags) return tags.error

    const result = await ctx.wikiAccess.updatePage({
      slug,
      body: input.body,  // preserve caller's whitespace, same as write
      ...(related.value.length > 0 ? { related: related.value } : {}),
      ...(tags.value.length > 0 ? { tags: tags.value } : {}),
    })

    if (result.kind === "slug_not_found") {
      return {
        error: "slug_not_found",
        detail:
          `No wiki page with slug "${slug}". ` +
          "Call write_wiki_page to create it instead, or " +
          "list_wiki_pages to find the right slug.",
      }
    }
    if (result.kind === "validation_failed") {
      return { error: "validation_failed", detail: result.detail }
    }

    // Tracker — record the update. Empty fromChunks for the same
    // reason write_wiki_page passes empty: chunk attribution is via
    // mark_section_covered, not inferred from mutations.
    ctx.tracker.markUpdated(slug, [])
    return {
      ok: true,
      path: result.path,
      slug,
      added_chars: result.added_chars,
    }
  },
}

/**
 * Reused from write-wiki-page.ts shape — kept local rather than
 * imported because the function is short and exporting from a
 * sibling tool creates a coupling we don't want (tools are
 * independent units). If this grows we'll lift to a helpers file.
 */
function sanitizeStringArray(
  input: unknown,
  fieldName: string,
):
  | { value: string[] }
  | { error: { error: "invalid_input"; detail: string } } {
  if (input === undefined || input === null) {
    return { value: [] }
  }
  if (!Array.isArray(input)) {
    return {
      error: {
        error: "invalid_input",
        detail: `${fieldName} must be an array of strings`,
      },
    }
  }
  const value = input.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  )
  return { value }
}
