/**
 * Interface between the agent runner and whatever drives the LLM.
 *
 * The runner doesn't care WHICH LLM it talks to — Anthropic
 * Messages, OpenAI Chat Completions, a recorded transcript replay
 * for tests — only that something fulfils `AgentLlm.chat()`. This
 * boundary buys us:
 *
 *   - **Testability.** Phase B.2 wires a `ScriptedLlm` here that
 *     returns pre-canned turns from an array. Loop logic gets
 *     covered without burning API tokens or mocking HTTP.
 *   - **Provider parity.** Anthropic uses `tool_use` / `tool_result`
 *     blocks; OpenAI uses `tool_calls` / role:"tool" messages. By
 *     normalising to our own message shape, Phase B.3's two
 *     provider adapters convert at the seam, and the runner stays
 *     provider-agnostic forever.
 *   - **Transcript record / replay.** A future "save this run for
 *     regression testing" feature just intercepts AgentLlm.chat()
 *     and writes the turns to disk.
 *
 * Types deliberately mirror the Anthropic Messages shape (it's the
 * cleaner of the two for tool calling). The OpenAI adapter
 * translates on its side. Reverse direction — Anthropic → OpenAI —
 * is one place; OpenAI → ours is the other.
 */

/**
 * One conversational message in the agent transcript. The runner
 * grows this array turn by turn; each LLM call gets the full
 * history (tools + their results included so the model knows what
 * it has and hasn't done).
 */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: AgentUserContent }
  | { role: "assistant"; content: AgentAssistantContent }

/**
 * User-side content. Initial prompt is plain text (source outline
 * + wiki state summary). Subsequent user turns carry tool_result
 * blocks — one per tool the assistant called in its previous turn.
 */
export type AgentUserContent =
  | string
  | Array<{ type: "text"; text: string } | ToolResultBlock>

/**
 * Assistant-side content. Always an array because tool_use blocks
 * interleave with optional text reasoning ("Let me check the
 * outline first…" then a tool_use). Even a pure-text reply is
 * one [{type:"text"}] block — keeps downstream logic uniform.
 */
export type AgentAssistantContent = Array<
  { type: "text"; text: string } | ToolUseBlock
>

export interface ToolUseBlock {
  type: "tool_use"
  /** Unique id chosen by the LLM. The runner echoes it back in the
   *  matching tool_result so the model can correlate. */
  id: string
  name: string
  /** Parsed JSON object — the LLM API gives us the object, not a
   *  raw JSON string. */
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  /** Stringified or structured result. Anthropic accepts either
   *  string or block[]; we always send string (JSON-stringified for
   *  structured results) to keep the runner deterministic. */
  content: string
  /** Whether the tool returned an `error: ...` discriminator. The
   *  LLM uses this signal to decide whether to retry; we set it
   *  whenever the tool's return matches { error: string }. */
  is_error?: boolean
}

/**
 * Tool definition formatted for the LLM API. The Anthropic and
 * OpenAI shapes happen to be identical at this level (name +
 * description + JSON schema) — provider adapters wrap this in the
 * outer envelope each API expects.
 */
export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Sampling controls forwarded to the LLM. Optional everything;
 * sensible defaults applied by the runner.
 */
export interface ChatOptions {
  /** Bound the model's per-turn output. */
  max_tokens?: number
  /** Temperature in [0, 1]. Default 0 — agent loops want determinism. */
  temperature?: number
  /** Override the tool catalog for this turn. Default: ctx-wide TOOLS[]. */
  tools?: ToolSchema[]
}

/**
 * One turn's output from the LLM as the runner sees it.
 *
 * - `content` is the assistant's structured response (text blocks +
 *   tool_use blocks interleaved). Empty content means the LLM
 *   refused / streamed nothing — the runner treats this as
 *   `stop_reason: "end_turn"` with no tools called.
 * - `stop_reason` mirrors Anthropic's terminology:
 *     - "end_turn"    — model finished its turn (possibly with tools).
 *     - "tool_use"    — model wants tools called; runner dispatches
 *                       and re-enters the loop. (Some Anthropic
 *                       versions don't surface this — `tool_use`
 *                       blocks in content imply it; the runner
 *                       checks content first.)
 *     - "max_tokens"  — model hit max_tokens mid-response. Runner
 *                       surfaces this as a budget warning but doesn't
 *                       abort (the partial response can still be
 *                       useful — e.g. a `done` tool call that fits
 *                       inside the truncation).
 *     - "stop_sequence" — currently unused.
 * - `usage` is per-turn token accounting. The runner aggregates
 *   into the AgentIngestResult.tokensSpent and enforces the global
 *   token budget.
 */
export interface AssistantTurn {
  content: AgentAssistantContent
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

/**
 * The single seam the runner depends on. Provider adapters
 * (`AnthropicAgentLlm`, `OpenAiAgentLlm` in Phase B.3) and the
 * test driver (`ScriptedLlm` in Phase B.2) both implement this.
 */
export interface AgentLlm {
  chat(
    messages: AgentMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    options?: ChatOptions,
  ): Promise<AssistantTurn>
}
