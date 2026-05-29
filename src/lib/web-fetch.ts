import { fetch } from "@tauri-apps/plugin-http"
import { Readability } from "@mozilla/readability"
import TurndownService from "turndown"

export interface WebFetchResult {
  url: string
  finalUrl: string
  title: string
  markdown: string
  contentType: string
  fetchedAt: string
  byline?: string
  excerpt?: string
}

export interface FetchAndExtractOptions {
  signal?: AbortSignal
  userAgent?: string
  timeoutMs?: number
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 LLMWiki"

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g

export function extractUrls(text: string): string[] {
  if (!text) return []
  const matches = text.match(URL_REGEX) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of matches) {
    // Trim trailing punctuation that's almost certainly not part of the URL
    // ("see https://example.com." or "...com)." etc.)
    const cleaned = raw.replace(/[.,;:!?)\]}"']+$/g, "")
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}

export function isLikelyUrl(text: string): boolean {
  const t = text.trim()
  if (!/^https?:\/\//i.test(t)) return false
  if (/\s/.test(t)) return false
  try {
    new URL(t)
    return true
  } catch {
    return false
  }
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
    emDelimiter: "_",
  })
  // Strip script / style noise that occasionally slips past Readability.
  td.remove(["script", "style", "noscript", "iframe"])
  return td.turndown(html).trim()
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split("/").filter(Boolean)
    const last = segs[segs.length - 1] ?? u.hostname
    return decodeURIComponent(last.replace(/[-_]+/g, " ")).trim() || u.hostname
  } catch {
    return "untitled"
  }
}

/**
 * Fetch a URL through tauri-plugin-http (Rust-side, CORS-free), extract the
 * main article with Readability, and convert to markdown. Falls back to a
 * plain body-to-markdown pass when Readability can't find an article (e.g.
 * the page is a list, an SPA, or already-markdown content like a raw .md).
 *
 * Non-HTML responses (PDFs, images, JSON) return their raw body as
 * "markdown" so the caller can still save something useful — most often
 * the user wanted a JSON API response or a plain-text page, and treating
 * that as the body is more helpful than throwing.
 */
export async function fetchAndExtract(
  url: string,
  options: FetchAndExtractOptions = {},
): Promise<WebFetchResult> {
  const ac = options.timeoutMs
    ? AbortSignal.timeout(options.timeoutMs)
    : undefined
  const signal = options.signal ?? ac

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal,
  })

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`)
  }

  const finalUrl = resp.url || url
  const contentType = resp.headers.get("content-type") ?? ""
  const body = await resp.text()
  const fetchedAt = new Date().toISOString()

  const isHtml = /html|xml/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(body)
  if (!isHtml) {
    return {
      url,
      finalUrl,
      title: deriveTitleFromUrl(finalUrl),
      markdown: body.trim(),
      contentType,
      fetchedAt,
    }
  }

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(body, "text/html")
  } catch {
    return {
      url,
      finalUrl,
      title: deriveTitleFromUrl(finalUrl),
      markdown: body.trim(),
      contentType,
      fetchedAt,
    }
  }

  // Readability mutates the DOM in-place, so we hand it a clone and keep
  // the original around for the fallback path.
  let article: ReturnType<Readability["parse"]> | null = null
  try {
    const cloned = doc.cloneNode(true) as Document
    article = new Readability(cloned).parse()
  } catch (err) {
    console.warn("[web-fetch] Readability threw:", err)
  }

  if (article && article.content) {
    return {
      url,
      finalUrl,
      title: article.title?.trim() || doc.title?.trim() || deriveTitleFromUrl(finalUrl),
      markdown: htmlToMarkdown(article.content),
      contentType,
      fetchedAt,
      byline: article.byline ?? undefined,
      excerpt: article.excerpt ?? undefined,
    }
  }

  // Fallback — couldn't extract a single "article", convert the whole body
  // and let the ingest LLM make sense of it.
  const fallbackHtml = doc.body?.innerHTML ?? body
  return {
    url,
    finalUrl,
    title: doc.title?.trim() || deriveTitleFromUrl(finalUrl),
    markdown: htmlToMarkdown(fallbackHtml),
    contentType,
    fetchedAt,
  }
}

/**
 * URL-safe slug for the raw filename — keep enough of the original title
 * (or path) that the file is recognisable in the source tree, drop the
 * scary characters that confuse the file watcher / file pickers, and cap
 * length so a particularly verbose title doesn't blow past path limits.
 */
export function slugFromTitle(title: string, fallback: string): string {
  const slugify = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
  const primary = slugify((title || "").trim())
  if (primary) return primary
  const fb = slugify(fallback.trim())
  return fb || "untitled"
}
