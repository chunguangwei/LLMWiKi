/**
 * Tool catalogue — one entry per tool the agent can call.
 *
 * Each tool is { name, description, inputSchema, execute() }. The
 * runner registers them with the LLM client's tool-call API and
 * dispatches on the LLM's tool_use blocks.
 *
 * Implementation note: tool execute() functions are intentionally
 * thin wrappers over existing primitives (smart-split chunks, fs
 * commands, source-lifecycle) so the agent layer doesn't reimplement
 * what's already battle-tested. The tool contract is the **isolation
 * boundary** — schema-validated input, structured output, no
 * exceptions surface to the LLM.
 *
 * Tools split into mental-model groups (no runtime enforcement — the
 * filter argument to toolSchemasForLlm() is what gates which group
 * each caller exposes to its LLM):
 *
 *   - Source inspection: read_outline, read_chunk, search_source
 *   - Wiki inspection:   list_wiki_pages, read_wiki_page, search_wiki_by_title
 *   - Tracker mutation:  mark_section_covered, surface_gap
 *   - Wiki mutation:     write_wiki_page, update_wiki_page, link_pages, delete_wiki_page
 *   - External (chat):   web_fetch, web_search, search_local_files
 *   - Loop control:      done
 *
 * Order in the TOOLS array below matches the LLM-facing catalogue
 * order; it's stable so prompt-cache hashes don't churn.
 */
import type { AgentContext } from "../types"

export interface ToolDefinition<TInput, TOutput> {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema for the LLM API
  execute(input: TInput, ctx: AgentContext): Promise<TOutput>
}

import { readOutlineTool } from "./read-outline"
import { readChunkTool } from "./read-chunk"
import { searchSourceTool } from "./search-source"
import { listWikiPagesTool } from "./list-wiki-pages"
import { readWikiPageTool } from "./read-wiki-page"
import { searchWikiByTitleTool } from "./search-wiki-by-title"
import { markSectionCoveredTool } from "./mark-section-covered"
import { surfaceGapTool } from "./surface-gap"
import { writeWikiPageTool } from "./write-wiki-page"
import { updateWikiPageTool } from "./update-wiki-page"
import { linkPagesTool } from "./link-pages"
import { deleteWikiPageTool } from "./delete-wiki-page"
import { webFetchTool } from "./web-fetch"
import { webSearchTool } from "./web-search"
import { searchLocalFilesTool } from "./search-local-files"
import { doneTool } from "./done"

// The runner iterates this array to build the tool catalogue passed
// to the LLM API; getTool() (below) is the dispatch on the LLM's
// chosen tool_use name.
export const TOOLS: Array<ToolDefinition<unknown, unknown>> = [
  readOutlineTool as ToolDefinition<unknown, unknown>,
  readChunkTool as ToolDefinition<unknown, unknown>,
  searchSourceTool as ToolDefinition<unknown, unknown>,
  listWikiPagesTool as ToolDefinition<unknown, unknown>,
  readWikiPageTool as ToolDefinition<unknown, unknown>,
  searchWikiByTitleTool as ToolDefinition<unknown, unknown>,
  markSectionCoveredTool as ToolDefinition<unknown, unknown>,
  surfaceGapTool as ToolDefinition<unknown, unknown>,
  writeWikiPageTool as ToolDefinition<unknown, unknown>,
  updateWikiPageTool as ToolDefinition<unknown, unknown>,
  linkPagesTool as ToolDefinition<unknown, unknown>,
  deleteWikiPageTool as ToolDefinition<unknown, unknown>,
  webFetchTool as ToolDefinition<unknown, unknown>,
  webSearchTool as ToolDefinition<unknown, unknown>,
  searchLocalFilesTool as ToolDefinition<unknown, unknown>,
  doneTool as ToolDefinition<unknown, unknown>,
]

/**
 * Look up a tool by name. Returns undefined for unknown tools — the
 * runner translates that into a structured error result for the LLM
 * instead of crashing.
 */
export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return TOOLS.find((t) => t.name === name)
}
