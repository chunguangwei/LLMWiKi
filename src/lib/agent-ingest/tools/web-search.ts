/**
 * Tool: `web_search` — search the web through the user's configured provider.
 *
 * Wraps `webSearch` from src/lib/web-search.ts. Dispatches through
 * whichever provider the user has configured (tavily / serpapi /
 * searxng / ollama). Returns ranked results with title / url /
 * snippet — the LLM can then call web_fetch on any single result for
 * the full article.
 *
 * No-provider behaviour: when the user has not configured a search
 * provider (resolved.provider === "none" OR no API key / SearXNG URL
 * present), we DO NOT throw. Instead we return a structured
 * `no_provider_configured` error so the LLM can:
 *   - Tell the user to configure a search provider, OR
 *   - Fall back to web_fetch with a guessed URL if appropriate
 *
 * This was the user's explicit ask — "用户没配置 tavily，但需要通过对话让 LLM
 * 直接调用脚本、web_fetch、爬虫打开需要扫描的网站". The LLM can keep being
 * useful without a search provider; it just loses search.
 */
import { webSearch, hasConfiguredSearchProvider } from "@/lib/web-search"
import type { AgentContext } from "../types"
import type { ToolDefinition } from "./index"

export interface WebSearchInput {
  query: string
  /** Default 5, max 20. Provider may return fewer. */
  limit?: number
}

export type WebSearchResult =
  | {
      ok: true
      query: string
      results: Array<{
        title: string
        url: string
        snippet: string
        source: string
      }>
    }
  | { error: "invalid_input"; detail: string }
  | { error: "no_provider_configured"; detail: string; hint: string }
  | { error: "search_failed"; detail: string }

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

export const webSearchTool: ToolDefinition<WebSearchInput, WebSearchResult> = {
  name: "web_search",
  description:
    "Search the web for a query using the user's configured search provider " +
    "(Tavily, SerpApi, SearXNG, or Ollama). Returns ranked results with " +
    "title / url / snippet. Use this when the user asks about something the " +
    "wiki doesn't cover AND you don't already have a specific URL to fetch.\n\n" +
    "If the user has NOT configured a search provider, returns " +
    "{ error: 'no_provider_configured' } — in that case, ask the user for " +
    "a specific URL and call web_fetch with it, or tell them to configure " +
    "a provider in Settings → Search. Do NOT retry web_search after this " +
    "error in the same run.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
        minLength: 1,
        maxLength: 500,
      },
      limit: {
        type: "integer",
        description: `Max results to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input: WebSearchInput, ctx: AgentContext): Promise<WebSearchResult> {
    if (ctx.signal.aborted) {
      throw new Error("web_search aborted by signal")
    }
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return { error: "invalid_input", detail: "query must be a non-empty string" }
    }
    const query = input.query.trim()
    const limit = clampLimit(input.limit)

    if (!ctx.searchApiConfig) {
      return {
        error: "no_provider_configured",
        detail: "No search provider available in this run's context.",
        hint:
          "Ask the user for a specific URL and use web_fetch instead, or " +
          "ask the user to configure a search provider in Settings → Search.",
      }
    }
    if (!hasConfiguredSearchProvider(ctx.searchApiConfig)) {
      return {
        error: "no_provider_configured",
        detail:
          "The user has not configured a working search provider " +
          "(provider is 'none', or required API key / URL is missing).",
        hint:
          "Ask the user for a specific URL and use web_fetch instead, or " +
          "ask the user to configure Tavily / SerpApi / SearXNG / Ollama " +
          "in Settings → Search.",
      }
    }

    try {
      const results = await webSearch(query, ctx.searchApiConfig, limit)
      return {
        ok: true,
        query,
        results: results.slice(0, limit).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          source: r.source,
        })),
      }
    } catch (err) {
      return {
        error: "search_failed",
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  },
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT
  if (raw < 1) return 1
  if (raw > MAX_LIMIT) return MAX_LIMIT
  return Math.floor(raw)
}
