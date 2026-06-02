/**
 * Public entry point for the chat-agent path (Phase G2.2).
 *
 *   runChatAgent(opts) →
 *     build AgentContext with wiki + web tools (no source-side) →
 *     compose system prompt (Karpathy framing + tool rules) →
 *     compose initial user prompt (recent exchange + current message) →
 *     run the agent loop → extract final assistant text + tool call
 *     summaries → return ChatAgentResult.
 *
 * Designed to be called from chat-panel's handleSubmit when the user
 * has opted into `experimentalChatAgent`. Falls back to classic
 * streaming chat when the agent loop ends with `no_tools_called` AND
 * the response has no text (very rare; happens if the model emits
 * pure tool_use mid-loop and then gives up) — that's a signal to
 * surface a "couldn't synthesise an answer" message to the user
 * rather than commit an empty turn.
 *
 * Reuses agent-ingest's runner + LLM adapters + tool catalogue —
 * same trick as agent-lint-fix. The only chat-specific parts are
 * prompts.ts and this wiring.
 */
import { readFile } from "@/commands/fs"
import { createAgentLlm } from "@/lib/agent-ingest/agent-llm"
import { runAgentLoop } from "@/lib/agent-ingest/runner"
import {
  assertSchemasUnique,
  getChatAgentToolNames,
  toolSchemasForLlm,
} from "@/lib/agent-ingest/tool-schemas"
import { InMemoryCoverageTracker } from "@/lib/agent-ingest/tracker"
import { FileSystemWikiAccess } from "@/lib/agent-ingest/wiki-access"
import { normalizePath } from "@/lib/path-utils"
import { hasConfiguredSearchProvider } from "@/lib/web-search"
import type {
  LlmConfig,
  SearchApiConfig,
} from "@/stores/wiki-store"
import type { DisplayMessage } from "@/stores/chat-store"
import type { WikiProject } from "@/types/wiki"
import type {
  AgentContext,
  OutlineHeading,
  SourceChunk,
} from "@/lib/agent-ingest/types"
import type {
  AgentAssistantContent,
  AgentMessage,
  ToolResultBlock,
  ToolUseBlock,
} from "@/lib/agent-ingest/llm-interface"
import {
  buildChatAgentSystemPrompt,
  buildChatAgentUserPrompt,
  todayIsoDate,
} from "./prompts"

export interface RunChatAgentOpts {
  userMessage: string
  /** Recent display messages for the active conversation, oldest → newest.
   *  The agent receives a compact serialised excerpt, not raw streaming
   *  state, so tool call blocks don't pollute the model's input. */
  history: DisplayMessage[]
  project: WikiProject
  llmConfig: LlmConfig
  searchApiConfig?: SearchApiConfig
  /** Output language pin ("zh" / "en" / "auto"). */
  outputLanguage?: string
  signal?: AbortSignal
  /** Cumulative billed-tokens cap. Default 120_000 — enough headroom for
   *  enumeration tasks ("list every time I mention X") that fan out across
   *  several search_local_files + read_wiki_page calls over a long page. */
  maxTokens?: number
  /** Hard cap on turns. Default 16 — multi-step "梳理/列举" queries need a
   *  few search → read → refine rounds before synthesising; 10 was too
   *  tight and surfaced as "Hit the turn budget — answer may be partial." */
  maxTurns?: number
  /** Progress hook fired after each LLM turn. Useful for the UI to show
   *  "thinking… tool X" without re-rendering the entire chat. */
  onTurn?: (turnIndex: number, toolNames: string[]) => void
  /**
   * When true, the agent's tool catalogue includes write_wiki_page +
   * update_wiki_page in addition to the read-only set. Gated by the
   * `experimentalChatAgentCanWrite` Labs sub-flag at the caller.
   * The system prompt teaches the agent to use these tools ONLY when
   * the user explicitly asks for a wiki mutation. delete_wiki_page
   * and link_pages are NOT included — those stay in agent-ingest /
   * agent-lint-fix where the workflow context is clearer.
   */
  canWrite?: boolean
}

export interface ChatAgentResult {
  /** The assistant's final reply text. May be empty when the model
   *  hit the budget cap or returned only tool calls. */
  text: string
  /** One entry per tool_use block across all turns, in order. */
  toolCalls: Array<{
    name: string
    inputSummary: string
    resultSummary: string
  }>
  /**
   * Raw payloads of every successful `web_fetch` the agent made
   * during this run. Captured here so SaveToWiki can preserve the
   * primary sources alongside the assistant reply (the user
   * complaint was "也没有 raw 的原始内容" — the chat-only summary
   * loses the original article body). One entry per fetch; same URL
   * fetched multiple times produces multiple entries (intentional
   * — different fetches can return slightly different content).
   */
  fetchedSources: Array<{
    /** Final URL the fetcher reached (after redirects). */
    url: string
    /** Article title extracted by Readability — may be empty. */
    title: string
    /** Markdown body (already truncated by web_fetch's own cap). */
    markdown: string
    /** ISO timestamp recorded by fetchAndExtract. */
    fetchedAt: string
  }>
  turnsUsed: number
  tokensSpent: number
  budgetExhausted: boolean
  /** Human-readable stop reason ("done_called", "max_turns", ...). */
  reason: string
}

const DEFAULT_MAX_TOKENS = 120_000
const DEFAULT_MAX_TURNS = 16
const HISTORY_MAX_MESSAGES = 6  // ~3 user/assistant exchanges

export async function runChatAgent(opts: RunChatAgentOpts): Promise<ChatAgentResult> {
  assertSchemasUnique()

  const projectPath = normalizePath(opts.project.path)
  const signal = opts.signal ?? new AbortController().signal

  // Empty source-side context. The chat catalogue excludes source
  // tools (read_outline / read_chunk / search_source), so an empty
  // chunks map is fine — those tools wouldn't be called anyway. Even
  // if a future catalogue change re-includes them, they'd return
  // empty results to the LLM, which is the correct signal.
  const chunks = new Map<string, SourceChunk>()
  const outline: OutlineHeading[] = []
  const vectorIndex = { search: async () => [] }

  const wikiAccess = new FileSystemWikiAccess(projectPath)
  const tracker = new InMemoryCoverageTracker(`chat:${opts.project.id}`, "chat", 0)

  const ctx: AgentContext = {
    chunks,
    outline,
    vectorIndex,
    project: opts.project,
    wikiAccess,
    tracker,
    llmConfig: opts.llmConfig,
    searchApiConfig: opts.searchApiConfig,
    signal,
  }

  const purpose = await readFile(`${projectPath}/purpose.md`).catch(() => "")
  const hasSearchProvider = opts.searchApiConfig
    ? hasConfiguredSearchProvider(opts.searchApiConfig)
    : false
  const systemPrompt = buildChatAgentSystemPrompt({
    projectPurpose: purpose,
    hasSearchProvider,
    outputLanguage: opts.outputLanguage,
    today: todayIsoDate(),
    canWrite: opts.canWrite === true,
  })

  // Recent exchange — last N messages from this conversation, role +
  // truncated content. Tool call blocks from prior chat-agent turns
  // are intentionally NOT included; the agent doesn't need to see its
  // own past tool-call internals, just the substantive replies.
  const recent = opts.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-HISTORY_MAX_MESSAGES)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
  const userPrompt = buildChatAgentUserPrompt(opts.userMessage, recent)

  const llm = createAgentLlm(opts.llmConfig)
  const runResult = await runAgentLoop({
    llm,
    ctx,
    initialMessages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools: toolSchemasForLlm(getChatAgentToolNames({ canWrite: opts.canWrite === true })),
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    onTurn: opts.onTurn
      ? (turn, i) => {
          const toolNames = turn.content
            .filter((b): b is ToolUseBlock => b.type === "tool_use")
            .map((b) => b.name)
          opts.onTurn!(i, toolNames)
        }
      : undefined,
  })

  // Extract the final assistant text + per-tool-call summaries from
  // the run's message history. We walk EVERY assistant turn so the
  // user sees the agent's full reasoning + tool usage, not just the
  // last reply.
  const { text, toolCalls } = extractTextAndToolCalls(runResult.finalMessages)
  const fetchedSources = extractFetchedSources(runResult.finalMessages)

  return {
    text,
    toolCalls,
    fetchedSources,
    turnsUsed: runResult.turnsUsed,
    tokensSpent: runResult.tokensSpent,
    budgetExhausted: runResult.stopReason === "max_tokens",
    reason: humaniseStopReason(runResult.stopReason),
  }
}

/**
 * Pull the raw markdown of every successful web_fetch tool call out
 * of the run's message history. Used by SaveToWiki to preserve the
 * primary sources alongside the assistant reply, so the user can
 * always re-trace where a claim came from.
 *
 * Walk in two passes:
 *   1. Assistant turns → build {tool_use_id → tool name} map.
 *   2. User turns → tool_result blocks. For each result whose tool
 *      was web_fetch AND whose JSON envelope has `ok: true`, capture
 *      url + title + markdown + fetchedAt.
 *
 * Malformed JSON in a tool_result is silently dropped — the runner
 * already JSON-stringifies tool output, so a parse failure here is
 * a sign of someone monkey-patching the runner, not a real failure
 * mode the user will hit. Same for missing fields: the entry just
 * doesn't show up.
 */
function extractFetchedSources(messages: AgentMessage[]): ChatAgentResult["fetchedSources"] {
  const out: ChatAgentResult["fetchedSources"] = []
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameById.set(block.id, block.name)
      }
    }
  }
  for (const msg of messages) {
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue
      const tb = block as ToolResultBlock
      if (toolNameById.get(tb.tool_use_id) !== "web_fetch") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(tb.content)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== "object") continue
      const obj = parsed as Record<string, unknown>
      if (obj.ok !== true) continue
      const url =
        typeof obj.finalUrl === "string" && obj.finalUrl.length > 0
          ? obj.finalUrl
          : typeof obj.url === "string"
            ? obj.url
            : ""
      const markdown = typeof obj.markdown === "string" ? obj.markdown : ""
      if (url.length === 0 || markdown.length === 0) continue
      out.push({
        url,
        title: typeof obj.title === "string" ? obj.title : "",
        markdown,
        fetchedAt: typeof obj.fetched_at === "string" ? obj.fetched_at : "",
      })
    }
  }
  return out
}

/* ────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────*/

function extractTextAndToolCalls(messages: AgentMessage[]): {
  text: string
  toolCalls: ChatAgentResult["toolCalls"]
} {
  const toolCalls: ChatAgentResult["toolCalls"] = []
  // Map tool_use id → its result content (from the next user turn).
  // Walk messages once to build the index.
  const resultsByUseId = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const tb = block as ToolResultBlock
        resultsByUseId.set(tb.tool_use_id, tb.content)
      }
    }
  }

  // Then walk assistant turns: collect text + tool_use blocks in order.
  const textParts: string[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const block of msg.content as AgentAssistantContent) {
      if (block.type === "text") {
        if (block.text.trim().length > 0) textParts.push(block.text)
      } else if (block.type === "tool_use") {
        const result = resultsByUseId.get(block.id) ?? ""
        toolCalls.push({
          name: block.name,
          inputSummary: summariseInput(block.input),
          resultSummary: summariseResult(result),
        })
      }
    }
  }

  return { text: textParts.join("\n\n").trim(), toolCalls }
}

function summariseInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).map(([k, v]) => {
    const sv = typeof v === "string" ? v : JSON.stringify(v)
    return `${k}=${sv.length > 80 ? sv.slice(0, 80) + "…" : sv}`
  })
  const joined = entries.join(", ")
  return joined.length > 240 ? joined.slice(0, 240) + "…" : joined
}

function summariseResult(content: string): string {
  if (content.length === 0) return "(no result)"
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      if ("error" in obj && typeof obj.error === "string") {
        return `error: ${obj.error}`
      }
      if ("ok" in obj && obj.ok === true) {
        // Surface the most informative field by convention.
        if ("matches" in obj && Array.isArray((obj as { matches: unknown[] }).matches)) {
          return `ok · ${(obj as { matches: unknown[] }).matches.length} matches`
        }
        if ("results" in obj && Array.isArray((obj as { results: unknown[] }).results)) {
          return `ok · ${(obj as { results: unknown[] }).results.length} results`
        }
        if ("title" in obj && typeof obj.title === "string") {
          return `ok · ${obj.title.slice(0, 60)}`
        }
        if ("slug" in obj && typeof obj.slug === "string") {
          return `ok · ${obj.slug}`
        }
        return "ok"
      }
    }
  } catch {
    // not JSON, fall through to raw snippet
  }
  return content.length > 80 ? content.slice(0, 80) + "…" : content
}

function humaniseStopReason(reason: string): string {
  switch (reason) {
    case "done_called":
      return "Agent finished and called `done`."
    case "no_tools_called":
      return "Agent replied without further tool calls."
    case "max_turns":
      return "Hit the turn budget — answer may be partial."
    case "max_tokens":
      return "Hit the token budget — answer may be partial."
    case "aborted":
      return "User aborted the run."
    default:
      return `Stopped: ${reason}`
  }
}
