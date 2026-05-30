/**
 * Convert the agent's tool catalogue into the LLM-facing
 * `ToolSchema[]` shape that AgentLlm.chat() takes.
 *
 * The transformation is mechanical (same fields, renamed
 * `inputSchema` → `input_schema` to match Anthropic / OpenAI's
 * snake-case convention), but keeping it in a named function gives
 * us:
 *
 *   - A single seam where Phase B.3's provider adapters can
 *     intervene if a future LLM wants a subtly different shape
 *     (e.g. OpenAI's `parameters` instead of `input_schema`).
 *   - A place to drop validation — assertSchemasUnique() catches
 *     a duplicate registration bug at startup instead of
 *     mid-loop.
 *
 * The catalogue's order is preserved. Some LLM providers weight
 * earlier tools more in ambiguous "which tool should I call"
 * decisions; matching design-doc §9's listed order keeps that
 * predictable.
 */
import type { ToolSchema } from "./llm-interface"
import { TOOLS } from "./tools"

/**
 * Convert the catalogue into the LLM-facing shape.
 *
 * When `filter` is provided, only the named tools are included AND
 * the original catalogue order is preserved (filter doesn't reorder).
 * Names in `filter` that don't match any registered tool are silently
 * ignored — assertSchemasUnique should have caught registration bugs
 * upstream.
 *
 * Use cases for the filter:
 *
 *   - agent-ingest: omit filter, ship all tools (default)
 *   - agent-lint-fix: omit filter, all tools are reachable (the
 *     prompt narrows the agent's choices)
 *   - chat-agent: pass `getChatAgentToolNames()` so the LLM only
 *     sees web/wiki tools, not source-chunk / coverage tools that
 *     have no chunks to operate on
 */
export function toolSchemasForLlm(filter?: readonly string[]): ToolSchema[] {
  const allow = filter ? new Set(filter) : null
  return TOOLS.filter((t) => (allow ? allow.has(t.name) : true)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

/**
 * Catalogue selector for the chat-agent path.
 *
 * Chat doesn't have a source document or coverage tracker — so
 * read_outline / read_chunk / search_source / mark_section_covered
 * don't apply. write/update/delete/link are also off-limits in chat
 * to keep wiki mutation a deliberate ingest-time action (the user
 * has to opt into the agent-ingest path for those). What chat DOES
 * need:
 *
 *   - inspection: list_wiki_pages, read_wiki_page, search_wiki_by_title
 *   - external: web_fetch, web_search, search_local_files
 *   - control: done
 *
 * Excludes: surface_gap (chat doesn't surface lint items).
 */
export function getChatAgentToolNames(): readonly string[] {
  return CHAT_AGENT_TOOL_NAMES
}

const CHAT_AGENT_TOOL_NAMES = [
  "list_wiki_pages",
  "read_wiki_page",
  "search_wiki_by_title",
  "web_fetch",
  "web_search",
  "search_local_files",
  "done",
] as const

/**
 * Throw if the catalogue contains two tools with the same name.
 * Cheap startup check that prevents a class of subtle bugs:
 * `getTool(name)` returns the FIRST match, so a duplicate
 * registration silently shadows the second one — the LLM would
 * see the duplicate in its tool list (different descriptions
 * even) but every call would dispatch to the first. Surfaces as
 * "this tool randomly seems to behave wrong" — exactly the kind
 * of bug humans can't reproduce.
 */
export function assertSchemasUnique(): void {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const t of TOOLS) {
    if (seen.has(t.name)) dups.push(t.name)
    seen.add(t.name)
  }
  if (dups.length > 0) {
    throw new Error(
      `[agent-ingest] duplicate tool registrations: ${dups.join(", ")}. ` +
        "Check tools/index.ts TOOLS[].",
    )
  }
}
