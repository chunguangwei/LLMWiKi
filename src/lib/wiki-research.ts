import { readFile } from "@/commands/fs"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { extractFrontmatterTitle } from "@/lib/wiki-cleanup"
import { resolveRelatedSlug, type ProjectPathIndex } from "@/lib/wiki-page-resolver"
import { searchWiki, type SearchResult } from "@/lib/search"
import type { WebSearchResult } from "@/lib/web-search"

const MAX_WIKI_SOURCES = 12
const MAX_PAGE_CHARS = 16_000

export interface WikiResearchOptions {
  projectPath: string
  queries: readonly string[]
  affectedPages: readonly string[]
  llmConfig?: LlmConfig
}

export interface WikiResearchCollection {
  results: WebSearchResult[]
  errors: string[]
  candidateCount: number
  rejectedCount: number
}

interface WikiResearchDeps {
  read: (path: string) => Promise<string>
  search: (projectPath: string, query: string) => Promise<SearchResult[]>
  index?: ProjectPathIndex
}

export function resolveWikiResearchPath(
  projectPath: string,
  reference: string,
  index: ProjectPathIndex = useWikiStore.getState().projectPathIndex,
): string | null {
  const ref = reference.trim()
  if (!ref || /[\u0000-\u001f\u007f]/u.test(ref)) return null
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const wikiRoot = `${root}/wiki`
  const normalized = normalizePath(ref)
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    const entry = index.byPath.get(normalized)
    if (!entry || !normalizePath(entry.path).startsWith(`${wikiRoot}/`)) return null
    return entry.path
  }
  return resolveRelatedSlug(index, normalized, wikiRoot)
}

export function collectWikiResearchLinks(content: string): string[] {
  const links = new Set<string>()
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    if (match[1].trim()) links.add(match[1].trim())
  }
  return [...links]
}

export async function collectWikiResearchSources(
  options: WikiResearchOptions,
  deps: WikiResearchDeps = { read: readFile, search: searchWiki },
): Promise<WikiResearchCollection> {
  const root = normalizePath(options.projectPath).replace(/\/+$/, "")
  const index = deps.index ?? useWikiStore.getState().projectPathIndex
  const errors: string[] = []
  const candidates: string[] = []
  const seen = new Set<string>()
  const contents = new Map<string, Promise<string>>()
  const read = (path: string) => {
    let pending = contents.get(path)
    if (!pending) {
      pending = deps.read(path)
      contents.set(path, pending)
    }
    return pending
  }
  const add = (reference: string, missingMessage: boolean) => {
    const path = resolveWikiResearchPath(root, reference, index)
    if (!path) {
      if (missingMessage) errors.push(`Wiki page is missing or outside the project: ${reference}`)
      return
    }
    const key = normalizePath(path)
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(path)
    }
  }

  options.affectedPages.forEach((reference) => add(reference, true))
  for (const path of candidates.slice(0, 6)) {
    try {
      const content = await read(path)
      collectWikiResearchLinks(content).slice(0, 4).forEach((link) => add(link, false))
    } catch (error) {
      errors.push(`Could not read Wiki page ${path}: ${String(error)}`)
    }
  }
  for (const query of options.queries.map((query) => query.trim()).filter(Boolean).slice(0, 3)) {
    try {
      const matches = await deps.search(root, query)
      matches.slice(0, 6).forEach((match) => add(match.path, false))
    } catch (error) {
      errors.push(`Wiki search failed for "${query}": ${String(error)}`)
    }
  }

  const configuredContext = options.llmConfig?.maxContextSize ?? 128_000
  let remaining = Math.max(4_000, Math.min(120_000, Math.floor(configuredContext * 0.35)))
  const results: WebSearchResult[] = []
  for (const path of candidates.slice(0, MAX_WIKI_SOURCES)) {
    if (remaining < 2_000) break
    try {
      const content = await read(path)
      if (!content.trim()) continue
      const snippet = content.slice(0, Math.min(MAX_PAGE_CHARS, remaining))
      if (!snippet) continue
      const normalizedPath = normalizePath(path)
      const relativePath = normalizedPath.startsWith(`${root}/`)
        ? normalizedPath.slice(root.length + 1)
        : normalizedPath.replace(/^wiki\//, "")
      results.push({
        title: extractFrontmatterTitle(content) || getFileStem(path),
        url: relativePath,
        wikiPath: relativePath,
        snippet,
        source: "Wiki",
      })
      remaining -= snippet.length
    } catch (error) {
      errors.push(`Could not read Wiki page ${path}: ${String(error)}`)
    }
  }
  return { results, errors, candidateCount: candidates.length, rejectedCount: 0 }
}

export function parseWikiResearchResolution(content: string): {
  resolution: "resolved" | "unresolved" | null
  cleaned: string
} {
  const match = /^\s*RESOLUTION:\s*(RESOLVED|UNRESOLVED)\s*(?:\r?\n|$)/i.exec(content)
  if (!match) return { resolution: null, cleaned: content.trim() }
  return {
    resolution: match[1].toUpperCase() === "RESOLVED" ? "resolved" : "unresolved",
    cleaned: content.slice(match[0].length).trim(),
  }
}

export function formatResearchReference(result: WebSearchResult, index: number): string {
  if (result.wikiPath) return `${index}. [[${result.wikiPath}|${result.title}]] — Wiki`
  return `${index}. [${result.title}](${result.url}) — ${result.source}`
}
