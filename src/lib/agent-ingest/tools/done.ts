/**
 * Tool: `done` — signal that the agent has finished.
 *
 * The runner's loop terminates as soon as `done` is called (after
 * processing any remaining tool calls in the same assistant turn).
 * The `reason` field is the agent's stated rationale ("source fully
 * extracted", "coverage at 92%, remainder is boilerplate", ...);
 * it surfaces in the activity-panel result and the wiki log.
 *
 * Why an explicit tool rather than inferring completion:
 *
 *   Without `done`, the runner would have to guess when the agent
 *   has finished — e.g. "no tool calls this turn = done" — which
 *   misfires on think-only turns. Pure-text replies are a normal
 *   part of long agent loops (the model narrating its plan), not a
 *   stop signal. An explicit `done` tool removes the ambiguity and
 *   matches Claude Code's same pattern.
 *
 * Validation:
 *
 *   - reason: required non-empty string. Short is fine ("source
 *     fully covered"); long is also fine — the activity panel
 *     truncates for display. Empty is rejected because a missing
 *     reason removes the only diagnostic the user has for "why
 *     did the agent stop here?".
 *
 * No abort throw — `done` is intentionally cheap and side-effect-
 * free except for tracker.markCompleted. The runner checks
 * signal.aborted at the loop boundary, not per-tool, so an aborted
 * loop can still call done() to flush partial state.
 */
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface DoneInput {
  reason: string
}

export type DoneResult =
  | {
      ok: true
      reason: string
      coverage_percent: number
      created_pages: number
      updated_pages: number
      gaps: number
    }
  | { error: "invalid_input"; detail: string }

export const doneTool: ToolDefinition<DoneInput, DoneResult> = {
  name: "done",
  description:
    "Signal that you have finished processing this source. The loop " +
    "terminates after this turn. `reason` is your stated rationale — " +
    "use it to explain why you stopped (source fully extracted, " +
    "coverage threshold hit, remaining content is boilerplate, etc); " +
    "it surfaces in the run result and the wiki log. Only call this " +
    "once you've also called mark_section_covered for each chunk you " +
    "processed and surface_gap for anything you saw but didn't extract.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short rationale for stopping. Becomes part of the run report.",
        minLength: 1,
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
  async execute(input: DoneInput, ctx: AgentContext): Promise<DoneResult> {
    if (typeof input?.reason !== "string" || input.reason.trim().length === 0) {
      return { error: "invalid_input", detail: "reason must be a non-empty string" }
    }
    const reason = input.reason.trim()
    ctx.tracker.markCompleted(reason)
    // Return a digest of the tracker's final state so the agent
    // (and the runner's last-message log) sees the outcome of its
    // own work. coverage_percent is rounded to two decimals because
    // the LLM doesn't need machine precision and integers display
    // cleaner in the activity panel.
    return {
      ok: true,
      reason,
      coverage_percent: Math.round(ctx.tracker.coveragePercent() * 10000) / 100,
      created_pages: ctx.tracker.createdPages().length,
      updated_pages: ctx.tracker.updatedPages().length,
      gaps: ctx.tracker.gaps().length,
    }
  },
}
