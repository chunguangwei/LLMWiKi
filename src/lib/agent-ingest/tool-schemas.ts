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

export function toolSchemasForLlm(): ToolSchema[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

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
