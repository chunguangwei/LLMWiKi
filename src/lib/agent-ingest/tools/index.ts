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

// Phase A — tool stubs land here as they're implemented.
// Empty for now so the test harness can grow incrementally without
// the loop runner needing a complete catalogue.
export const TOOLS: Array<ToolDefinition<unknown, unknown>> = []

/**
 * Look up a tool by name. Returns undefined for unknown tools — the
 * runner translates that into a structured error result for the LLM
 * instead of crashing.
 */
export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return TOOLS.find((t) => t.name === name)
}
