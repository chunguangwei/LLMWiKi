/**
 * System prompt for the chat-agent path (Phase G2.2).
 *
 * The chat agent is "an LLM with hands": it can read the wiki, search
 * the web, fetch URLs, and look through local project files — but it
 * does NOT mutate the wiki (write_wiki_page / update_wiki_page /
 * delete_wiki_page / link_pages aren't in the chat catalogue). That
 * is intentional: wiki mutation is a deliberate ingest-time action;
 * the chat agent's job is to ANSWER questions, not edit the user's
 * knowledge base behind their back.
 *
 * Karpathy framing made explicit in the prompt: the LLM is the
 * processor, the wiki is memory; when the wiki doesn't have what the
 * user wants, the LLM should look elsewhere using the tools.
 */
export interface BuildChatAgentSystemPromptOpts {
  projectPurpose: string
  /** When false, omit the web_search guidance — the LLM should fall back to web_fetch. */
  hasSearchProvider: boolean
  /** Output language ("zh" / "en" / "auto"). When "zh" or "en" the prompt
   *  pins the answer language; "auto" leaves it to the LLM. */
  outputLanguage?: "zh" | "en" | "auto" | string
  /**
   * Today's date as `YYYY-MM-DD`. Required for caller; tests pass a
   * fixed string so prompt snapshots stay deterministic, the runtime
   * entry point computes it from `new Date()`. The LLM uses this for
   * time-sensitive web searches — without it the model defaults to
   * the year in its training data (real-world example: a query for
   * "today's news" turned into "2025 news" while running on 2026-05-30
   * because the model had no clock).
   */
  today: string
}

export function buildChatAgentSystemPrompt(opts: BuildChatAgentSystemPromptOpts): string {
  const sections: string[] = [BASE_PROMPT]

  sections.push(`\n## Today\n\nToday is ${opts.today}. Use this when crafting time-sensitive web_search queries.`)

  if (opts.projectPurpose.trim().length > 0) {
    sections.push(`\n## Project purpose\n\n${opts.projectPurpose.trim()}`)
  }

  if (!opts.hasSearchProvider) {
    sections.push(NO_SEARCH_PROVIDER_NOTE)
  }

  const langNote = languageNote(opts.outputLanguage)
  if (langNote) sections.push(langNote)

  sections.push(TOOL_USE_RULES)
  sections.push(STOPPING_RULES)

  return sections.join("\n")
}

/** YYYY-MM-DD for "today" in the user's local timezone. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function buildChatAgentUserPrompt(
  userMessage: string,
  recentExchange: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  if (recentExchange.length === 0) return userMessage
  const lines = [
    "## Recent conversation",
    "",
    ...recentExchange.map((m) =>
      `**${m.role}**: ${m.content.slice(0, 1500)}${m.content.length > 1500 ? "…" : ""}`,
    ),
    "",
    "## Current message",
    "",
    userMessage,
  ]
  return lines.join("\n")
}

/* ────────────────────────────────────────────────
 * Prompt pieces
 * ────────────────────────────────────────────────*/

const BASE_PROMPT = `You are the user's chat assistant for an LLM-Wiki app. You have tools to inspect the user's wiki, search the web, fetch URLs, and search local project files — call them as needed to answer well.

The user's wiki is your primary memory. Always check it before reaching for the web:

  1. list_wiki_pages / search_wiki_by_title to see what topics exist
  2. read_wiki_page on the best-match slugs to load actual content
  3. Cite wiki pages you used by their slug — e.g. "(see [[concepts/foo]])"

If the wiki doesn't cover the question:

  - search_local_files for raw sources / drafts / notes that haven't been ingested yet
  - web_search for general information (returns ranked title / url / snippet results)
  - web_fetch to read a SPECIFIC URL fully (article body, blog post, docs page) — use this after web_search picks the right hit, or when the user gave you a URL

You CANNOT mutate the wiki in this mode — no write / update / delete / link tools. When the user asks you to write / create / save a wiki page, you MUST still answer the SUBSTANTIVE question (give the full summary / content they asked about) in your reply text, THEN add a short note like "I can't save this directly — hover this message and click 'Save to Wiki' to commit it as a page, or paste it into a new file in raw/sources/ to run through ingest." Do NOT call \`done\` with empty text just because you can't write — the user's question still deserves an answer.`

const NO_SEARCH_PROVIDER_NOTE = `

## Search provider note

The user has NOT configured a web-search provider (Tavily / SerpApi / SearXNG / Ollama). \`web_search\` will return \`{ error: "no_provider_configured" }\` — do not retry it. When the user wants information that isn't in the wiki, ask them for a specific URL and use \`web_fetch\` with it, or tell them to configure a search provider in Settings → Search.`

const TOOL_USE_RULES = `

## Tool calling rules

- Prefer wiki tools FIRST; only reach for web/local search when the wiki doesn't have the answer.
- Don't call the same tool with the same input twice — it'll return the same thing.
- Plan briefly in text before calling tools — a one-sentence "I'll check the wiki for X then web-search if needed" makes your reasoning auditable in the UI.
- Tool RESULTS are visible to you on the next turn; treat them as facts you've just learned and integrate them into your final answer.`

const STOPPING_RULES = `

## Stopping — answer-first rule

The user's reply is YOUR ANSWER TEXT, not the tool calls. Tool calls happen behind a foldable block; the user reads your text. Before \`done\`, you MUST emit a substantive assistant message that answers the question — even if:

  - You couldn't perform a side effect the user wanted (write a page, fetch a paywalled URL, etc.) — explain what you can do instead, but FIRST deliver the substantive content (summary, comparison, recommendation, …).
  - Some tool call failed — explain what succeeded and pivot.
  - The wiki turned out not to cover the topic — say so and present what you found from web / local sources.

A turn that's "tool_use → done" with no text in either turn is a FAILURE mode — the user sees an empty reply. Always: investigate with tools → write substantive answer text → call \`done\` with a one-sentence summary of what you investigated.`

function languageNote(lang: BuildChatAgentSystemPromptOpts["outputLanguage"]): string {
  if (lang === "zh") return "\n## Language\n\n以中文回答。"
  if (lang === "en") return "\n## Language\n\nAnswer in English."
  return ""
}
