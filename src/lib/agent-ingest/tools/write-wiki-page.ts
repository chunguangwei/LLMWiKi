/**
 * Tool: `write_wiki_page` — create a new wiki page.
 *
 * First write tool to land. Validates the slug, hands off to
 * `ctx.wikiAccess.writePage()`, and records the create with the
 * coverage tracker.
 *
 * Validation order (each returns invalid_input and short-circuits):
 *
 *   1. slug — via shared validateSlug (path traversal, Windows-
 *      reserved names, `.md` extension, illegal chars). The agent
 *      MUST send the slug WITHOUT `.md`.
 *   2. type — non-empty string. Schema-level type validation
 *      (must be in the 34-type taxonomy + project schema.md
 *      additions) happens INSIDE WikiAccess.writePage; failures
 *      surface as `validation_failed`.
 *   3. title — non-empty string after trim.
 *   4. body — non-empty string after trim. Empty pages are
 *      rejected at this layer because an LLM producing
 *      `body: ""` is almost certainly a hallucination, not an
 *      intentional placeholder.
 *   5. related / tags — when present, must be string arrays of
 *      non-empty strings. Empty arrays are tolerated; null
 *      values silently dropped (same defence as
 *      mark_section_covered).
 *
 * Result surface:
 *
 *   - `{ ok: true, path, slug }`           — page created. Tracker
 *                                             records the create
 *                                             (no fromChunks yet —
 *                                             coverage tracking is
 *                                             via mark_section_covered).
 *   - `{ error: "slug_taken", detail }`    — page already exists.
 *                                             Hint at update_wiki_page.
 *   - `{ error: "invalid_input", detail }` — schema-level reject.
 *   - `{ error: "validation_failed", ... }` — WikiAccess rejected
 *                                             (type not in schema,
 *                                             frontmatter conflict, ...).
 *
 * No throws (except signal abort). All errors travel as result
 * shapes so the LLM can self-correct.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"
import { validateSlug } from "../slug"

export interface WriteWikiPageInput {
  slug: string
  type: string
  title: string
  body: string
  related?: string[]
  tags?: string[]
}

export type WriteWikiPageResult =
  | { ok: true; path: string; slug: string }
  | { error: "slug_taken"; detail: string }
  | { error: "invalid_input"; detail: string }
  | { error: "validation_failed"; detail: string }

export const writeWikiPageTool: ToolDefinition<WriteWikiPageInput, WriteWikiPageResult> = {
  name: "write_wiki_page",
  description:
    "Create a new wiki page. The slug is wiki-relative without .md " +
    "('concepts/foo'). type must be one of the project's allowed types " +
    "(see purpose.md / schema.md). title becomes the H1 and the page's " +
    "frontmatter title. body is the markdown after the closing ---. " +
    "related is an array of slugs to link to; tags are free-form. " +
    "Before calling, use list_wiki_pages to check for duplicates — if " +
    "a page on this topic already exists, prefer update_wiki_page. " +
    "Returns { error: 'slug_taken' } when the slug is already used.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Wiki-relative path WITHOUT the .md extension, e.g. " +
          "'concepts/foo' or 'Books/原则-读书笔记'.",
        minLength: 1,
        maxLength: 200,
      },
      type: {
        type: "string",
        description:
          "Page type slug — must be in the project's schema (use " +
          "the 34-type defaults: concept, entity, report, note, ...).",
        minLength: 1,
      },
      title: {
        type: "string",
        description: "Human-readable title. Becomes the page's H1.",
        minLength: 1,
      },
      body: {
        type: "string",
        description:
          "Markdown body after the closing ---. Must be non-empty; " +
          "the runner prepends the frontmatter and writes the file.",
        minLength: 1,
      },
      related: {
        type: "array",
        description:
          "Slugs of related pages to link to. Becomes the " +
          "frontmatter `related:` array.",
        items: { type: "string", minLength: 1 },
      },
      tags: {
        type: "array",
        description: "Free-form tags. Becomes the frontmatter `tags:` array.",
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["slug", "type", "title", "body"],
    additionalProperties: false,
  },
  async execute(input: WriteWikiPageInput, ctx: AgentContext): Promise<WriteWikiPageResult> {
    if (ctx.signal.aborted) {
      throw new Error("write_wiki_page aborted by signal")
    }

    const slugReason = validateSlug(input?.slug)
    if (slugReason) return { error: "invalid_input", detail: `slug: ${slugReason}` }
    const slug = (input.slug as string).trim()

    if (typeof input?.type !== "string" || input.type.trim().length === 0) {
      return { error: "invalid_input", detail: "type must be a non-empty string" }
    }
    if (typeof input?.title !== "string" || input.title.trim().length === 0) {
      return { error: "invalid_input", detail: "title must be a non-empty string" }
    }
    if (typeof input?.body !== "string" || input.body.trim().length === 0) {
      return { error: "invalid_input", detail: "body must be a non-empty string" }
    }

    const related = sanitizeStringArray(input.related, "related")
    if ("error" in related) return related.error
    const tags = sanitizeStringArray(input.tags, "tags")
    if ("error" in tags) return tags.error

    const result = await ctx.wikiAccess.writePage({
      slug,
      type: input.type.trim(),
      title: input.title.trim(),
      body: input.body,  // body whitespace preserved — caller's call
      ...(related.value.length > 0 ? { related: related.value } : {}),
      ...(tags.value.length > 0 ? { tags: tags.value } : {}),
    })

    if (result.kind === "slug_taken") {
      return {
        error: "slug_taken",
        detail:
          `A wiki page with slug "${slug}" already exists. ` +
          "Use read_wiki_page to see its current content, then " +
          "update_wiki_page to extend it.",
      }
    }
    if (result.kind === "validation_failed") {
      return { error: "validation_failed", detail: result.detail }
    }

    // Coverage tracker — record the create. fromChunks is empty here
    // because the agent attributes chunks to pages via separate
    // mark_section_covered calls; we don't want to guess.
    ctx.tracker.markCreated(slug, [])
    return { ok: true, path: result.path, slug }
  },
}

/**
 * Strict string-array sanitiser shared between `related` and `tags`.
 * Returns either the validated array (with non-string / empty
 * entries dropped, same defence as mark_section_covered) or a
 * structured error if the field is present but not an array.
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
