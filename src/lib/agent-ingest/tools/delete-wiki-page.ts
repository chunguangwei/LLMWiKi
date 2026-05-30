/**
 * Tool: `delete_wiki_page` — remove an existing wiki page.
 *
 * Added for the agent-lint-fix path (Phase G1). agent-ingest never
 * deletes — extraction only adds — so this tool is gated by the
 * lint-fix prompts which explicitly say "you may delete when the
 * target page is genuinely stale".
 *
 * Why a separate tool rather than reusing direct fs delete: the
 * structural-page guard, the validateSlug pass, and the tracker
 * hook all need to ride along, and a tool keeps the LLM's mental
 * model consistent with the rest of the catalogue (every wiki
 * mutation goes through `*_wiki_page`).
 *
 * Validation order:
 *
 *   1. slug → validateSlug (path traversal, Windows-reserved,
 *      `.md` extension, illegal chars). The agent MUST pass the
 *      slug WITHOUT `.md`.
 *   2. reason → required non-empty string. The deletion is
 *      load-bearing — we want the LLM to state WHY for the
 *      activity log + future audit. Empty is rejected to
 *      pressure the LLM into a real justification.
 *   3. WikiAccess.deletePage also rejects structural pages
 *      (index / log / overview) — see types.ts deletePage docs.
 *
 * Result surface:
 *
 *   - `{ ok: true, path, slug, reason }`        — deleted.
 *   - `{ error: "slug_not_found", detail }`     — no such page.
 *   - `{ error: "invalid_input", detail }`      — schema reject.
 *   - `{ error: "validation_failed", detail }`  — WikiAccess
 *                                                 reject (structural
 *                                                 page, fs error, ...).
 *
 * No throws (except signal abort). Tracker.markDeleted is called on
 * success — that hook is optional (see types.ts CoverageTracker) so
 * agent-ingest's in-memory tracker silently no-ops; the lint-fix
 * tracker uses it for the activity report.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"
import { validateSlug } from "../slug"

export interface DeleteWikiPageInput {
  slug: string
  reason: string
}

export type DeleteWikiPageResult =
  | { ok: true; path: string; slug: string; reason: string }
  | { error: "slug_not_found"; detail: string }
  | { error: "invalid_input"; detail: string }
  | { error: "validation_failed"; detail: string }

export const deleteWikiPageTool: ToolDefinition<DeleteWikiPageInput, DeleteWikiPageResult> = {
  name: "delete_wiki_page",
  description:
    "Delete an existing wiki page. Use ONLY when the page is genuinely " +
    "stale — its topic is no longer relevant, OR a broken-link target was " +
    "always wrong and shouldn't exist. The `reason` field is REQUIRED and " +
    "becomes part of the activity log; state why this page should disappear " +
    "in one sentence. Structural pages (index.md / log.md / overview.md) " +
    "are rejected — they cannot be deleted via this tool. Prefer " +
    "update_wiki_page over delete + write_wiki_page when the page is just " +
    "out of date.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "Wiki-relative slug WITHOUT the .md extension.",
        minLength: 1,
        maxLength: 200,
      },
      reason: {
        type: "string",
        description:
          "One-sentence rationale for the delete. Required — the activity " +
          "log shows this so the user can audit why the page disappeared.",
        minLength: 1,
      },
    },
    required: ["slug", "reason"],
    additionalProperties: false,
  },
  async execute(input: DeleteWikiPageInput, ctx: AgentContext): Promise<DeleteWikiPageResult> {
    if (ctx.signal.aborted) {
      throw new Error("delete_wiki_page aborted by signal")
    }

    const slugReason = validateSlug(input?.slug)
    if (slugReason) return { error: "invalid_input", detail: `slug: ${slugReason}` }
    const slug = (input.slug as string).trim()

    if (typeof input?.reason !== "string" || input.reason.trim().length === 0) {
      return {
        error: "invalid_input",
        detail: "reason must be a non-empty string; state why the page should be removed.",
      }
    }
    const reason = input.reason.trim()

    const result = await ctx.wikiAccess.deletePage({ slug, reason })

    if (result.kind === "slug_not_found") {
      return {
        error: "slug_not_found",
        detail:
          `No wiki page with slug "${slug}". ` +
          "Call list_wiki_pages or search_wiki_by_title to confirm the slug.",
      }
    }
    if (result.kind === "validation_failed") {
      return { error: "validation_failed", detail: result.detail }
    }

    // Tracker hook — optional. agent-ingest's tracker doesn't have
    // markDeleted (deletion isn't part of extraction); the lint-fix
    // tracker uses it for the activity log. Optional-chain so missing
    // impls silently no-op.
    const trackerWithDelete = ctx.tracker as unknown as {
      markDeleted?: (slug: string, reason: string) => void
    }
    trackerWithDelete.markDeleted?.(slug, reason)

    return { ok: true, path: result.path, slug, reason }
  },
}
