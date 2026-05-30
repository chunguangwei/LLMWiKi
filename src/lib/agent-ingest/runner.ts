/**
 * Agent loop runner.
 *
 * Drives the multi-turn conversation between an LLM and the tool
 * catalogue. Stateless w.r.t. file I/O — every persistent side
 * effect happens via `ctx.wikiAccess` or `ctx.tracker`, both of
 * which are injected. This is what lets Phase B.2's tests run
 * the entire loop deterministically with a scripted LLM.
 *
 * What the runner does NOT do:
 *
 *   - Pre-processing (smart-split, vectorize, outline extraction).
 *     The caller hands us a fully-populated AgentContext. The
 *     public `runAgentIngest()` entry point in `index.ts` runs
 *     pre-process and then calls into here.
 *   - LLM transport. The runner takes an `AgentLlm` and assumes
 *     it knows how to talk to a real (or scripted) backend.
 *
 * Loop algorithm (mirrors design doc §4):
 *
 *   while not stop:
 *     turn = llm.chat(messages, tools, signal, options)
 *     append assistant content to messages
 *     update budget counters
 *
 *     if signal aborted    → stop with "aborted"
 *     if no tool_use blocks → stop with "no_tools_called"
 *                              (implicit done)
 *     dispatch every tool_use → tool_result blocks
 *     append user turn (tool_results) to messages
 *     if tracker.isComplete() → stop with "done_called"
 *     if tokens spent ≥ budget → stop with "max_tokens"
 *     if turns used ≥ budget   → stop with "max_turns"
 *
 *   return { finalMessages, turnsUsed, tokensSpent, stopReason }
 *
 * Tool dispatch invariants:
 *
 *   - An unknown tool name returns an `invalid_tool` error result;
 *     the LLM almost always self-corrects by calling a known tool
 *     on the next turn (Claude Code's same pattern).
 *   - A tool that THROWS becomes a `runtime_error` result. We
 *     don't propagate — one bad tool call shouldn't kill the
 *     whole run; the LLM either retries or surface_gaps it.
 *   - Tools dispatch SEQUENTIALLY. The design doc explicitly
 *     forbids parallel dispatch in v1 (Phase B) — it makes
 *     wiki writes race-free and the loop's state easier to
 *     reason about.
 */
import type { AgentContext } from "./types"
import type {
  AgentLlm,
  AgentMessage,
  AssistantTurn,
  AgentAssistantContent,
  ToolResultBlock,
  ToolSchema,
} from "./llm-interface"
import { getTool } from "./tools"

export interface RunAgentLoopOpts {
  llm: AgentLlm
  ctx: AgentContext
  /** Pre-built messages. Should include the system prompt + initial
   *  user prompt with the source outline / wiki state. */
  initialMessages: AgentMessage[]
  /** LLM-facing tool catalogue. Usually `toolSchemasForLlm()`. */
  tools: ToolSchema[]
  /** Hard cap on loop turns. Default 50. */
  maxTurns?: number
  /** Hard cap on total tokens (input + output across all turns).
   *  Default 200_000. */
  maxTokens?: number
  /** Hook fired after each turn — useful for tests / activity-panel
   *  progress. */
  onTurn?: (turn: AssistantTurn, turnIndex: number) => void
}

export interface RunAgentLoopResult {
  finalMessages: AgentMessage[]
  turnsUsed: number
  tokensSpent: number
  stopReason:
    | "done_called"
    | "no_tools_called"
    | "max_turns"
    | "max_tokens"
    | "aborted"
}

const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_TOKENS = 200_000

export async function runAgentLoop(opts: RunAgentLoopOpts): Promise<RunAgentLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const messages: AgentMessage[] = [...opts.initialMessages]
  let turnsUsed = 0
  let tokensSpent = 0
  let stopReason: RunAgentLoopResult["stopReason"] | null = null

  while (stopReason === null) {
    if (opts.ctx.signal.aborted) {
      stopReason = "aborted"
      break
    }
    if (turnsUsed >= maxTurns) {
      stopReason = "max_turns"
      break
    }
    if (tokensSpent >= maxTokens) {
      stopReason = "max_tokens"
      break
    }

    const turn = await opts.llm.chat(messages, opts.tools, opts.ctx.signal)
    turnsUsed += 1
    tokensSpent += turn.usage.input_tokens + turn.usage.output_tokens
    opts.onTurn?.(turn, turnsUsed - 1)

    // Append assistant content. Even pure-text replies get appended
    // so a final transcript review shows the model's reasoning.
    messages.push({ role: "assistant", content: turn.content })

    if (opts.ctx.signal.aborted) {
      stopReason = "aborted"
      break
    }

    const toolUses = collectToolUses(turn.content)
    if (toolUses.length === 0) {
      // Implicit done — the model decided to reply with text only.
      // The runner treats this as a stop signal (the user-facing
      // entry point reports it as the model declining to call any
      // tool, which is its own kind of "I'm finished").
      stopReason = "no_tools_called"
      break
    }

    // Dispatch tools sequentially. Each tool's result becomes a
    // tool_result block in the next user turn so the LLM sees what
    // happened. Mid-batch abort short-circuits the remaining tools
    // and pushes whatever results we have so the transcript stays
    // well-formed.
    const toolResults: ToolResultBlock[] = []
    for (const use of toolUses) {
      if (opts.ctx.signal.aborted) break
      toolResults.push(await dispatchTool(use, opts.ctx))
    }
    messages.push({ role: "user", content: toolResults })

    // Check completion AFTER tool dispatch — `done` tool call sets
    // tracker.isComplete() to true in its execute().
    if (opts.ctx.tracker.isComplete()) {
      stopReason = "done_called"
      break
    }

    // Budget guard happens at the TOP of the loop so the next turn
    // doesn't fire over the limit; fall through to the next
    // iteration's checks.
  }

  return {
    finalMessages: messages,
    turnsUsed,
    tokensSpent,
    stopReason: stopReason ?? "max_turns",
  }
}

function collectToolUses(
  content: AgentAssistantContent,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return content
    .filter(
      (block): block is Extract<typeof block, { type: "tool_use" }> =>
        block.type === "tool_use",
    )
    .map((block) => ({ id: block.id, name: block.name, input: block.input }))
}

/**
 * Execute one tool_use block and produce a tool_result block.
 *
 * The runner-side error envelope is what the LLM sees as the
 * tool's "return value" — not a thrown exception. Three shapes:
 *
 *   - Unknown tool          → "invalid_tool" error result.
 *   - Tool throws           → "runtime_error" result. The error's
 *                              message is included so the LLM can
 *                              report something to the user.
 *   - Tool returns normally → JSON-stringified value. If the value
 *                              has { error: string }, is_error=true
 *                              so the LLM knows to retry / correct.
 */
async function dispatchTool(
  use: { id: string; name: string; input: Record<string, unknown> },
  ctx: AgentContext,
): Promise<ToolResultBlock> {
  const tool = getTool(use.name)
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: JSON.stringify({
        error: "invalid_tool",
        detail:
          `No tool named "${use.name}". Pick one from the tools list. ` +
          "Common typos: 'list_wiki_page' (no s) → list_wiki_pages.",
      }),
      is_error: true,
    }
  }
  try {
    const result = await tool.execute(use.input, ctx)
    const isError =
      typeof result === "object" &&
      result !== null &&
      "error" in (result as Record<string, unknown>) &&
      typeof (result as Record<string, unknown>).error === "string"
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: JSON.stringify(result),
      ...(isError ? { is_error: true } : {}),
    }
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: JSON.stringify({
        error: "runtime_error",
        detail: err instanceof Error ? err.message : String(err),
      }),
      is_error: true,
    }
  }
}
