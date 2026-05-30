/**
 * Tool: `web_fetch` — fetch a URL, extract its main content as markdown.
 *
 * Added for the chat-agent path (Phase G2.1). Lets the agent pull in
 * external context when the wiki doesn't cover what the user is
 * asking about — Karpathy framing: the wiki is the LLM's memory, the
 * web is its outside-the-room source. NO API KEY REQUIRED — this
 * works out of the box, unlike web_search which depends on a
 * configured provider.
 *
 * Wraps `src/lib/web-fetch.ts` `fetchAndExtract`, which is the same
 * pipeline the user already uses to ingest pasted URLs. Same trust
 * boundaries, same User-Agent, same Readability + Turndown path.
 *
 * Validation:
 *
 *   - url MUST start with http:// or https://. file://, data://,
 *     javascript:, etc. are rejected up front — letting the LLM
 *     traverse the filesystem via file:// URLs is a sandbox break.
 *   - We also reject URLs whose host resolves to obvious private
 *     ranges (127.0.0.0/8, 10/8, 192.168/16, 169.254/16) by host
 *     STRING match. This is a best-effort guard; a malicious URL
 *     can still bypass via DNS — the real protection is that this
 *     is a USER-INITIATED chat session, not a server endpoint, so
 *     the threat model is "LLM accidentally fetches sensitive
 *     internal URL", not "LLM is adversarial". For server-side
 *     deployments, a stricter resolver is needed.
 *   - Length cap on URL to keep schemas reasonable.
 *
 * Result surface:
 *
 *   - { ok: true, url, finalUrl, title, markdown, content_type, fetched_at, byline?, excerpt? }
 *   - { error: "invalid_input", detail }    — URL parse / scheme reject
 *   - { error: "blocked_target", detail }   — private/loopback host
 *   - { error: "fetch_failed", detail }     — network / HTTP error
 *
 * Truncates `markdown` to MAX_MARKDOWN_CHARS so a runaway page can't
 * blow the LLM's context budget in one tool call.
 */
import { fetchAndExtract } from "@/lib/web-fetch"
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface WebFetchInput {
  url: string
  /** Default false. When true, returns up to MAX_MARKDOWN_CHARS_FULL chars instead of MAX_MARKDOWN_CHARS. */
  full?: boolean
}

export type WebFetchResult =
  | {
      ok: true
      url: string
      finalUrl: string
      title: string
      markdown: string
      content_type: string
      fetched_at: string
      truncated: boolean
      byline?: string
      excerpt?: string
    }
  | { error: "invalid_input"; detail: string }
  | { error: "blocked_target"; detail: string }
  | { error: "fetch_failed"; detail: string }

const MAX_URL_LENGTH = 2048
const MAX_MARKDOWN_CHARS = 20_000
const MAX_MARKDOWN_CHARS_FULL = 80_000
const FETCH_TIMEOUT_MS = 30_000

export const webFetchTool: ToolDefinition<WebFetchInput, WebFetchResult> = {
  name: "web_fetch",
  description:
    "Fetch a single web URL and return its main content as markdown. Use " +
    "this when the wiki doesn't have the information the user is asking " +
    "about and you have a specific URL to consult (or you got the URL from " +
    "a prior web_search call). Returns the article body, title, and any " +
    "Readability-detected byline / excerpt. No configuration required.\n\n" +
    "Only http:// and https:// URLs are accepted; file://, data:// and " +
    "similar schemes are rejected. Markdown is truncated to ~20k chars by " +
    "default (~80k with `full: true`) so one call can't exhaust the budget.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The exact URL to fetch — must include the http(s):// scheme. " +
          "Max 2048 chars.",
        minLength: 1,
        maxLength: MAX_URL_LENGTH,
      },
      full: {
        type: "boolean",
        description:
          "Default false. Set true ONLY when you need the full article and " +
          "are willing to spend the extra tokens; truncates at ~80k chars " +
          "instead of ~20k.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(input: WebFetchInput, ctx: AgentContext): Promise<WebFetchResult> {
    if (ctx.signal.aborted) {
      throw new Error("web_fetch aborted by signal")
    }
    if (typeof input?.url !== "string" || input.url.length === 0) {
      return { error: "invalid_input", detail: "url must be a non-empty string" }
    }
    const url = input.url.trim()
    if (url.length > MAX_URL_LENGTH) {
      return { error: "invalid_input", detail: `url exceeds ${MAX_URL_LENGTH} chars` }
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { error: "invalid_input", detail: `url is not parseable: ${url.slice(0, 80)}` }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        error: "invalid_input",
        detail: `url scheme "${parsed.protocol}" not allowed; use http:// or https://`,
      }
    }
    if (isBlockedHost(parsed.hostname)) {
      return {
        error: "blocked_target",
        detail:
          `host "${parsed.hostname}" looks like a private / loopback address. ` +
          "web_fetch only allows public hosts to avoid LLM-driven SSRF.",
      }
    }

    const full = typeof input.full === "boolean" ? input.full : false
    const cap = full ? MAX_MARKDOWN_CHARS_FULL : MAX_MARKDOWN_CHARS

    try {
      const result = await fetchAndExtract(url, {
        signal: ctx.signal,
        timeoutMs: FETCH_TIMEOUT_MS,
      })
      const truncated = result.markdown.length > cap
      const markdown = truncated
        ? result.markdown.slice(0, cap) + `\n\n[... truncated at ${cap} chars; pass full:true to extend ...]`
        : result.markdown
      return {
        ok: true,
        url: result.url,
        finalUrl: result.finalUrl,
        title: result.title,
        markdown,
        content_type: result.contentType,
        fetched_at: result.fetchedAt,
        truncated,
        ...(result.byline ? { byline: result.byline } : {}),
        ...(result.excerpt ? { excerpt: result.excerpt } : {}),
      }
    } catch (err) {
      return {
        error: "fetch_failed",
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  },
}

/**
 * Best-effort host-string match against private / loopback / link-local
 * ranges. Does NOT resolve DNS — a malicious host could still point at
 * an internal IP. The threat model here is "LLM accidentally fetches
 * an internal admin panel" not "adversarial LLM with DNS attack",
 * which this catches.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "localhost" || h === "localhost.localdomain") return true
  if (h === "::1" || h === "[::1]") return true
  if (h.startsWith("127.")) return true
  if (h.startsWith("10.")) return true
  if (h.startsWith("169.254.")) return true
  if (h.startsWith("192.168.")) return true
  // 172.16.0.0 – 172.31.255.255
  const m172 = /^172\.(\d{1,3})\./.exec(h)
  if (m172) {
    const second = Number(m172[1])
    if (second >= 16 && second <= 31) return true
  }
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan")) return true
  return false
}
