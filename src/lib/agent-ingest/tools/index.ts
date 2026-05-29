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
 * Phase A implements these one at a time, in this order:
 *   1. read_outline   — pure read, simplest possible test bed
 *   2. read_chunk     — pure read, no LLM in the loop yet
 *   3. search_source  — wires in vector index, still no mutation
 *   4. list_wiki_pages, read_wiki_page — wiki inspection (no writes)
 *   5. mark_section_covered, surface_gap — tracker mutation only
 *   6. write_wiki_page, update_wiki_page, link_pages — wiki mutation
 *   7. done — loop control
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

// Phase A — tools register here as they land. Order matches the
// implementation order in docs/agent-ingest-design.md §9 Phase A.
// The runner iterates this array to build the tool catalogue passed
// to the LLM API; getTool() (below) is the dispatch on the LLM's
// chosen tool_use name.
export const TOOLS: Array<ToolDefinition<unknown, unknown>> = [
  readOutlineTool as ToolDefinition<unknown, unknown>,
  readChunkTool as ToolDefinition<unknown, unknown>,
  searchSourceTool as ToolDefinition<unknown, unknown>,
]

/**
 * Look up a tool by name. Returns undefined for unknown tools — the
 * runner translates that into a structured error result for the LLM
 * instead of crashing.
 */
export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return TOOLS.find((t) => t.name === name)
}
