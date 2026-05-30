/**
 * Real-LLM adapters that implement AgentLlm for the agent runner.
 *
 * Two shapes cover every provider that supports tool calling today:
 *
 *   - **Anthropic Messages** — `provider="anthropic"` / `"minimax"` /
 *     `"custom"` with `apiMode="anthropic_messages"`. Native
 *     `tool_use` / `tool_result` blocks inside `content`. System
 *     goes at the body's top level.
 *   - **OpenAI Chat Completions** — `provider="openai"` / `"azure"` /
 *     `"ollama"` / `"custom"` with default `apiMode`. Tools come
 *     back as `choices[0].message.tool_calls` and the matching
 *     user reply uses `role:"tool"` messages.
 *
 * Both adapters use `getProviderConfig()` for URL + auth headers so
 * Azure v1 endpoints, MiniMax bearer auth, Ollama CORS workarounds —
 * every quirk the chat path already knows — applies here for free.
 * Only the body shape and the response parser are local to each
 * adapter.
 *
 * NON-STREAMING for tool calling. Streaming tool_use blocks have to
 * be reassembled from chunked input deltas — adds complexity for no
 * UX benefit (the agent loop only acts on a complete turn anyway).
 *
 * Google Gemini and the subprocess providers (claude-code /
 * codex-cli) are intentionally NOT supported here yet:
 *
 *   - Gemini uses `function_call` with a different schema; future
 *     `GoogleAgentLlm` would be a third class.
 *   - Subprocess providers don't expose a tool-calling surface
 *     compatible with this shape; if you want them, the runner
 *     needs a different transport.
 *
 * Errors:
 *   - Non-2xx response → throws an Error with the status + body
 *     prefix. The runner catches at the loop boundary.
 *   - JSON parse failure → throws with the raw body prefix so the
 *     user can see what came back.
 */
import { getHttpFetch } from "@/lib/tauri-fetch"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
  isAzureOpenAiV1Endpoint,
} from "@/lib/azure-openai"
import { buildAnthropicUrl } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"
import type {
  AgentLlm,
  AgentMessage,
  AssistantTurn,
  ChatOptions,
  ToolSchema,
  ToolUseBlock,
  ToolResultBlock,
} from "./llm-interface"

const JSON_CONTENT_TYPE = "application/json"
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TEMPERATURE = 0

/* ────────────────────────────────────────────────────────────────
 * Common helpers
 * ────────────────────────────────────────────────────────────────*/

function extractSystem(messages: AgentMessage[]): {
  system: string
  rest: Exclude<AgentMessage, { role: "system" }>[]
} {
  const systems: string[] = []
  const rest: Exclude<AgentMessage, { role: "system" }>[] = []
  for (const m of messages) {
    if (m.role === "system") systems.push(m.content)
    else rest.push(m)
  }
  return { system: systems.join("\n\n"), rest }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const httpFetch = await getHttpFetch()
  const response = await httpFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    let bodyText = ""
    try {
      bodyText = await response.text()
    } catch {
      // ignore — message below is still useful
    }
    throw new Error(
      `agent LLM call failed: HTTP ${response.status} ${response.statusText}` +
        (bodyText ? ` — ${bodyText.slice(0, 800)}` : ""),
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (err) {
    throw new Error(
      `agent LLM call returned non-JSON response: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return parsed as Record<string, unknown>
}

/* ────────────────────────────────────────────────────────────────
 * Anthropic Messages adapter
 * ────────────────────────────────────────────────────────────────*/

/**
 * Translate AgentMessage[] into the Anthropic Messages body shape.
 * - User content with tool_result blocks passes through verbatim
 *   (Anthropic accepts our exact block shape — we modelled
 *   AgentMessage on it intentionally).
 * - User content that's a plain string is wrapped in a single
 *   text block for symmetry with the assistant side.
 * - Assistant content is already block[] — passes through.
 */
function toAnthropicMessages(
  messages: Exclude<AgentMessage, { role: "system" }>[],
): Array<{ role: "user" | "assistant"; content: unknown[] }> {
  return messages.map((m) => {
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : m.content
      return { role: "user", content }
    }
    return { role: "assistant", content: m.content }
  })
}

function parseAnthropicResponse(body: Record<string, unknown>): AssistantTurn {
  const content = body.content as unknown[] | undefined
  const stopReason = body.stop_reason as string | undefined
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined

  if (!Array.isArray(content)) {
    throw new Error(
      `Anthropic response missing or malformed 'content' field: ${JSON.stringify(body).slice(0, 400)}`,
    )
  }

  // Filter to the blocks the agent runner consumes. Other block
  // types (Anthropic's reasoning blocks, server-side tool blocks)
  // are SKIPPED — they shouldn't make it into the transcript we
  // hand back to the model on subsequent turns.
  const projected: AssistantTurn["content"] = []
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string") {
        projected.push({ type: "text", text: b.text })
      } else if (
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        typeof b.name === "string" &&
        typeof b.input === "object" &&
        b.input !== null
      ) {
        projected.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        } satisfies ToolUseBlock)
      }
    }
  }

  return {
    content: projected,
    stop_reason: mapAnthropicStopReason(stopReason),
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  }
}

function mapAnthropicStopReason(raw: string | undefined): AssistantTurn["stop_reason"] {
  if (raw === "tool_use") return "tool_use"
  if (raw === "max_tokens") return "max_tokens"
  if (raw === "stop_sequence") return "stop_sequence"
  return "end_turn"
}

export class AnthropicAgentLlm implements AgentLlm {
  constructor(private readonly config: LlmConfig) {}

  async chat(
    messages: AgentMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    options: ChatOptions = {},
  ): Promise<AssistantTurn> {
    const { system, rest } = extractSystem(messages)
    const baseUrl = pickAnthropicBase(this.config)
    const url = buildAnthropicUrl(baseUrl)
    const headers = buildAnthropicAgentHeaders(this.config.apiKey, url)

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toAnthropicMessages(rest),
      max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    }
    if (system) body.system = system

    const response = await postJson(url, headers, body, signal)
    return parseAnthropicResponse(response)
  }
}

function pickAnthropicBase(config: LlmConfig): string {
  if (config.provider === "anthropic") return "https://api.anthropic.com"
  if (config.provider === "minimax") {
    return config.customEndpoint || "https://api.minimax.io/anthropic"
  }
  // custom with apiMode=anthropic_messages. Guard at createAgentLlm
  // already rejects an empty customEndpoint, so this is just a
  // defence-in-depth assertion against a code path that bypasses
  // the factory.
  if (!config.customEndpoint) {
    throw new Error(
      'agent ingest: provider="custom" with apiMode="anthropic_messages" requires ' +
        "customEndpoint to be set. Open Settings → LLM and fill in the endpoint URL.",
    )
  }
  return config.customEndpoint
}

function buildAnthropicAgentHeaders(
  apiKey: string,
  url: string,
): Record<string, string> {
  // Match the existing chat path's auth choice — MiniMax / Bailian /
  // Xiaomi MiMo gateways take Bearer; vanilla Anthropic takes
  // x-api-key + anthropic-version. We inline the logic from
  // llm-providers.ts's requiresBearerAuth() so this module stays
  // self-contained and doesn't reach into a private function.
  const normalized = url.toLowerCase().replace(/\/+$/, "")
  const wantsBearer =
    normalized.startsWith("https://api.minimax.io/anthropic") ||
    normalized.startsWith("https://api.minimaxi.com/anthropic") ||
    normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic") ||
    /(^https:\/\/|^)token-plan-cn\.xiaomimimo\.com\/anthropic(?:\/|$)/i.test(normalized)
  const base: Record<string, string> = { "Content-Type": JSON_CONTENT_TYPE }
  if (wantsBearer) {
    base.Authorization = `Bearer ${apiKey}`
  } else {
    base["x-api-key"] = apiKey
    base["anthropic-version"] = "2023-06-01"
    base["anthropic-dangerous-direct-browser-access"] = "true"
  }
  return base
}

/* ────────────────────────────────────────────────────────────────
 * OpenAI Chat Completions adapter
 * ────────────────────────────────────────────────────────────────*/

/**
 * OpenAI flattens tool_use into a sibling field of `content`:
 *
 *   { role: "assistant", content: "optional text", tool_calls: [...] }
 *
 * Round-trip from AgentAssistantContent (where tool_use blocks
 * interleave with text) requires us to split them apart on the
 * way out and merge them back on the way in.
 *
 * Tool RESULTS use a separate role "tool" — one message per
 * tool_call_id. AgentMessage groups them into a single user turn
 * with multiple tool_result blocks, so we unroll them into N
 * role:"tool" messages here.
 */
function toOpenAiMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content })
      continue
    }
    if (m.role === "assistant") {
      const texts: string[] = []
      const toolCalls: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }> = []
      for (const block of m.content) {
        if (block.type === "text") texts.push(block.text)
        else
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })
      }
      const msg: Record<string, unknown> = {
        role: "assistant",
        // OpenAI requires `content` even when there are tool_calls;
        // empty string is the documented "no text" form.
        content: texts.join(""),
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      out.push(msg)
      continue
    }
    // role === "user"
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content })
      continue
    }
    // Multi-block user content. Tool results split off into
    // role:"tool" messages; plain text blocks merge into ONE
    // role:"user" message (OpenAI accepts string content there).
    const userTexts: string[] = []
    const toolBlocks: ToolResultBlock[] = []
    for (const block of m.content) {
      if (block.type === "text") userTexts.push(block.text)
      else toolBlocks.push(block)
    }
    if (userTexts.length > 0) {
      out.push({ role: "user", content: userTexts.join("") })
    }
    for (const tb of toolBlocks) {
      out.push({
        role: "tool",
        tool_call_id: tb.tool_use_id,
        content: tb.content,
      })
    }
  }
  return out
}

function parseOpenAiResponse(body: Record<string, unknown>): AssistantTurn {
  const choices = body.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  if (!choice) {
    throw new Error(
      `OpenAI response missing choices: ${JSON.stringify(body).slice(0, 400)}`,
    )
  }
  const message = choice.message as
    | { content?: string | null; tool_calls?: unknown[] }
    | undefined
  if (!message) {
    throw new Error("OpenAI response missing message in choices[0]")
  }

  const projected: AssistantTurn["content"] = []
  if (typeof message.content === "string" && message.content.length > 0) {
    projected.push({ type: "text", text: message.content })
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call && typeof call === "object") {
        const c = call as Record<string, unknown>
        const fn = c.function as
          | { name?: string; arguments?: string }
          | undefined
        if (
          typeof c.id === "string" &&
          fn &&
          typeof fn.name === "string" &&
          typeof fn.arguments === "string"
        ) {
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = JSON.parse(fn.arguments) as Record<string, unknown>
          } catch {
            // Malformed JSON in arguments — surface as empty object;
            // the tool layer's invalid_input check will flag missing
            // required fields and the LLM self-corrects.
            parsedInput = {}
          }
          projected.push({
            type: "tool_use",
            id: c.id,
            name: fn.name,
            input: parsedInput,
          })
        }
      }
    }
  }

  const usage = body.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined

  return {
    content: projected,
    stop_reason: mapOpenAiFinishReason(choice.finish_reason as string | undefined),
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  }
}

function mapOpenAiFinishReason(raw: string | undefined): AssistantTurn["stop_reason"] {
  if (raw === "tool_calls") return "tool_use"
  if (raw === "length") return "max_tokens"
  if (raw === "stop") return "end_turn"
  return "end_turn"
}

export class OpenAiAgentLlm implements AgentLlm {
  constructor(private readonly config: LlmConfig) {}

  async chat(
    messages: AgentMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
    options: ChatOptions = {},
  ): Promise<AssistantTurn> {
    const url = pickOpenAiUrl(this.config)
    const headers = buildOpenAiAgentHeaders(this.config)

    const isAzureV1 =
      this.config.provider === "custom" &&
      isAzureOpenAiV1Endpoint(this.config.customEndpoint)
    const isClassicAzure =
      this.config.provider === "azure" ||
      (this.config.provider === "custom" &&
        isAzureOpenAiEndpoint(this.config.customEndpoint) &&
        !isAzureV1)

    const body: Record<string, unknown> = {
      messages: toOpenAiMessages(messages),
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
    }
    // Classic Azure puts the deployment in the URL — body.model is
    // implicit. Every other path needs the model field.
    if (!isClassicAzure) body.model = this.config.model
    // gpt-5 / o-series / Azure v1 use max_completion_tokens; everything
    // else uses max_tokens. Match the chat path's heuristic.
    const useMaxCompletion =
      isAzureV1 ||
      /^(gpt-5|o\d+)/i.test(this.config.model)
    if (useMaxCompletion) {
      body.max_completion_tokens = options.max_tokens ?? DEFAULT_MAX_TOKENS
      // Strict models reject non-default temperature.
      delete body.temperature
    } else {
      body.max_tokens = options.max_tokens ?? DEFAULT_MAX_TOKENS
    }

    const response = await postJson(url, headers, body, signal)
    return parseOpenAiResponse(response)
  }
}

function pickOpenAiUrl(config: LlmConfig): string {
  if (config.provider === "openai") return "https://api.openai.com/v1/chat/completions"
  if (config.provider === "azure") {
    return buildAzureOpenAiUrl(
      config.customEndpoint,
      config.model,
      config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
    )
  }
  if (config.provider === "ollama") {
    let base = config.ollamaUrl.replace(/\/+$/, "")
    if (/\/v1\/chat\/completions$/i.test(base))
      base = base.replace(/\/v1\/chat\/completions$/i, "")
    else if (/\/v1$/i.test(base)) base = base.replace(/\/v1$/i, "")
    return `${base}/v1/chat/completions`
  }
  // custom
  const base = config.customEndpoint.replace(/\/+$/, "")
  if (isAzureOpenAiV1Endpoint(base)) {
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
  }
  if (isAzureOpenAiEndpoint(base)) {
    return buildAzureOpenAiUrl(
      base,
      config.model,
      config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
    )
  }
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

function buildOpenAiAgentHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": JSON_CONTENT_TYPE }
  if (config.provider === "openai") {
    headers.Authorization = `Bearer ${config.apiKey}`
  } else if (config.provider === "azure") {
    headers["api-key"] = config.apiKey
  } else if (config.provider === "custom") {
    const isAzure = isAzureOpenAiEndpoint(config.customEndpoint)
    if (config.apiKey) {
      headers[isAzure ? "api-key" : "Authorization"] = isAzure
        ? config.apiKey
        : `Bearer ${config.apiKey}`
    }
  }
  // Ollama: no auth header. Local LLM CORS workaround lives in the
  // existing chat path; the agent path goes via plugin-http which
  // doesn't enforce browser CORS, so it's not needed here.
  return headers
}

/* ────────────────────────────────────────────────────────────────
 * Factory
 * ────────────────────────────────────────────────────────────────*/

/**
 * Pick the right adapter for the user's LLM config.
 *
 * Throws for providers we don't support yet — better to fail loud
 * at agent startup than at the first tool-call turn.
 */
export function createAgentLlm(config: LlmConfig): AgentLlm {
  const { provider } = config
  if (provider === "anthropic" || provider === "minimax") {
    return new AnthropicAgentLlm(config)
  }
  if (provider === "custom" && config.apiMode === "anthropic_messages") {
    // Fail fast with a clear, user-fixable message instead of letting
    // the first HTTP request hit an empty URL and surface as
    // "fetch failed" / "invalid URL". Same guard for Azure-shape
    // custom is in pickOpenAiUrl's downstream callers.
    if (!config.customEndpoint || config.customEndpoint.trim().length === 0) {
      throw new Error(
        'agent ingest: provider="custom" with apiMode="anthropic_messages" ' +
          "requires customEndpoint to be set. Open Settings → LLM and fill " +
          "in the Anthropic-compatible endpoint URL.",
      )
    }
    return new AnthropicAgentLlm(config)
  }
  if (provider === "custom" && (!config.customEndpoint || config.customEndpoint.trim().length === 0)) {
    throw new Error(
      'agent ingest: provider="custom" requires customEndpoint to be set. ' +
        "Open Settings → LLM and fill in the endpoint URL.",
    )
  }
  if (
    provider === "openai" ||
    provider === "azure" ||
    provider === "ollama" ||
    provider === "custom"
  ) {
    return new OpenAiAgentLlm(config)
  }
  throw new Error(
    `agent ingest doesn't support provider "${provider}" yet. ` +
      "Use Anthropic, OpenAI, Azure OpenAI, Ollama, MiniMax, or " +
      "a Custom OpenAI/Anthropic-compatible endpoint.",
  )
}
