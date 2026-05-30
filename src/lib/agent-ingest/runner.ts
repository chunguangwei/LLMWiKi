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
  /**
   * Hard cap on cumulative BILLED tokens across every turn — i.e.
   * the same number the LLM provider charges for. Each turn's
   * `usage.input_tokens` counts the FULL conversation re-sent that
   * turn, so a 20-turn loop with a 5K system prompt + growing
   * transcript easily reaches 100K+ even though the unique-content
   * size is far smaller. Treat this as a money/quota ceiling, not
   * a "conversation capacity" budget. Default 200_000.
   */
  maxTokens?: number
  /** Hook fired after each turn — useful for tests / activity-panel
   *  progress. */
  onTurn?: (turn: AssistantTurn, turnIndex: number) => void
  /**
   * Fired immediately after each turn's tool_results are appended to
   * the message history — gives the entry-point a chance to persist
   * a checkpoint without re-implementing the loop's state machine.
   *
   * The runner doesn't await this hook; it fires-and-forgets so a
   * slow disk doesn't stretch the loop's wall-clock. Callers that
   * want strict ordering can chain promises in their hook impl.
   */
  onCheckpoint?: (snapshot: {
    messages: AgentMessage[]
    turnsUsed: number
    tokensSpent: number
  }) => void
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
    const turnTokens = turn.usage.input_tokens + turn.usage.output_tokens
    turnsUsed += 1
    tokensSpent += turnTokens
    // Push usage into the tracker too so checkpoint snapshots carry
    // per-run accounting (turnsUsed, tokensSpent). recordTurn is an
    // optional interface method — test mocks generally don't implement
    // it. Without this call the snapshot reports 0/0 on resume —
    // purely cosmetic for the activity panel but confusing in the
    // saved JSON.
    opts.ctx.tracker.recordTurn?.(turnTokens)
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
    // happened. Two short-circuits inside the batch:
    //
    //   - Abort signal: drop the remaining tools, push whatever
    //     we have so the transcript stays well-formed (the API
    //     requires a tool_result per tool_use it just received).
    //   - `done` tool: stop dispatching the rest of the batch.
    //     The LLM almost never INTENDS for "[surface_gap, done,
    //     write_wiki_page]" to write the page after declaring done
    //     — that pattern is a tool-call ordering glitch, not a
    //     considered sequence. We still emit tool_results for the
    //     undispatched calls (filler "skipped: done was called")
    //     so the assistant turn's tool_use blocks all have
    //     matching tool_result blocks — the API rejects partial
    //     dispatches.
    const toolResults: ToolResultBlock[] = []
    let doneDispatched = false
    for (const use of toolUses) {
      if (opts.ctx.signal.aborted) break
      if (doneDispatched) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify({
            error: "skipped",
            detail: "done was called earlier in this batch; the rest of the batch is intentionally skipped.",
          }),
          is_error: true,
        })
        continue
      }
      toolResults.push(await dispatchTool(use, opts.ctx))
      if (use.name === "done") doneDispatched = true
    }
    messages.push({ role: "user", content: toolResults })

    // Fire the checkpoint hook now — message history is in its
    // post-tool-result state, tracker mutations from this turn's
    // dispatch are committed. The next iteration is the natural
    // resume point.
    opts.onCheckpoint?.({
      messages: messages.slice(),
      turnsUsed,
      tokensSpent,
    })

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
