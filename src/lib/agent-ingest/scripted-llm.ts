/**
 * ScriptedLlm — test harness for the agent runner.
 *
 * Implements AgentLlm with a pre-canned array of AssistantTurns;
 * each call to `.chat()` returns the next one. Lets the runner's
 * loop logic be tested deterministically without burning real LLM
 * tokens or maintaining an HTTP-level mock.
 *
 * Two ways to use it:
 *
 *   1. Static script — pass an array up front:
 *
 *        new ScriptedLlm([
 *          { content: [{ type: "tool_use", id: "1", name: "read_outline", input: {} }],
 *            stop_reason: "end_turn",
 *            usage: { input_tokens: 50, output_tokens: 10 } },
 *          { content: [{ type: "tool_use", id: "2", name: "done", input: { reason: "ok" } }],
 *            stop_reason: "end_turn",
 *            usage: { input_tokens: 60, output_tokens: 5 } },
 *        ])
 *
 *   2. Dynamic script — pass a function that's called with the
 *      message history and produces the next turn. Useful for
 *      tests that assert the model can SEE what the previous tool
 *      returned:
 *
 *        new ScriptedLlm((messages) => {
 *          if (messages.some((m) => contains "outline")) return doneTurn
 *          return readOutlineTurn
 *        })
 *
 * `chat()` records every call's args (messages + tools snapshot)
 * on `this.calls` so tests can assert what the runner forwarded.
 *
 * Throws when the script is exhausted — the runner reaching beyond
 * the planned turn count is almost always a bug; tests want to know.
 */
import type {
  AgentLlm,
  AgentMessage,
  AssistantTurn,
  ToolSchema,
  ChatOptions,
} from "./llm-interface"

export interface ScriptedCall {
  messages: AgentMessage[]
  tools: ToolSchema[]
  options?: ChatOptions
}

export type ScriptedTurnSource =
  | AssistantTurn[]
  | ((messages: AgentMessage[], callIndex: number) => AssistantTurn)

export class ScriptedLlm implements AgentLlm {
  readonly calls: ScriptedCall[] = []
  private callIndex = 0

  constructor(private readonly source: ScriptedTurnSource) {}

  async chat(
    messages: AgentMessage[],
    tools: ToolSchema[],
    _signal: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantTurn> {
    // Snapshot — deep clone the messages so a test asserting on
    // `calls[0].messages` doesn't see later runner mutations.
    this.calls.push({
      messages: structuredClone(messages),
      tools: structuredClone(tools),
      options: options ? structuredClone(options) : undefined,
    })

    if (Array.isArray(this.source)) {
      if (this.callIndex >= this.source.length) {
        throw new Error(
          `[ScriptedLlm] script exhausted at call ${this.callIndex + 1}; ` +
            `the runner is asking for more turns than the test planned. ` +
            `Did you forget a 'done' tool call in the script?`,
        )
      }
      const turn = this.source[this.callIndex++]
      return turn
    }
    const turn = this.source(messages, this.callIndex)
    this.callIndex++
    return turn
  }
}

/**
 * Convenience builder for a single-tool-use assistant turn. Most
 * tests want "the LLM called tool X with input Y"; saves writing
 * the {content: [{type:"tool_use",...}], stop_reason, usage}
 * boilerplate every time.
 */
export function toolUseTurn(opts: {
  id?: string
  name: string
  input: Record<string, unknown>
  /** Optional text reasoning before the tool call. */
  text?: string
  inputTokens?: number
  outputTokens?: number
}): AssistantTurn {
  const content: AssistantTurn["content"] = []
  if (opts.text) content.push({ type: "text", text: opts.text })
  content.push({
    type: "tool_use",
    id: opts.id ?? `tu_${Math.floor(performance.now() * 1000).toString(36)}`,
    name: opts.name,
    input: opts.input,
  })
  return {
    content,
    stop_reason: "tool_use",
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 20,
    },
  }
}

/** Pure-text assistant turn (no tool calls). The runner stops the
 *  loop when it sees one of these — interpreted as implicit done. */
export function textTurn(text: string, opts: { inputTokens?: number; outputTokens?: number } = {}): AssistantTurn {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 20,
    },
  }
}
