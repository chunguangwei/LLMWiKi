/**
 * Tool: `search_local_files` — project-scoped file content search.
 *
 * Walks the user's project directory and returns paths whose names
 * match an optional glob AND whose body contains `query` (plain
 * substring, case-insensitive). Used by the chat-agent when the user
 * asks about something that lives in their own files but isn't yet
 * in the wiki — raw sources, drafts, scratch notes, etc.
 *
 * Returns EVERY matching line (one entry per line, up to
 * `max_matches_per_file`), not just the first hit per file. This is
 * what makes "list all the times I mention X" answerable in a single
 * call: a long diary page with 30 badminton entries yields 30 dated
 * snippets, so the agent can enumerate them directly instead of
 * re-reading the whole page or re-searching with different keywords
 * (the failure mode that used to burn the chat-agent turn budget).
 *
 * Strict project-scope: every result lives under `ctx.project.path`.
 * `root` is a project-relative subdirectory; traversal-escape inputs
 * (".." segments, absolute paths, "wiki" / "raw/sources" are fine,
 * "/etc" is not) are rejected as invalid_input.
 *
 * No shell: pure JS walker via the existing listDirectory command.
 * Slower than ripgrep, but it works on all 4 PC platforms with zero
 * Rust changes. If perf becomes a problem, swap in a Tauri Rust
 * command later — the interface here doesn't change.
 *
 * Limits (intentional, soft):
 *   - max_matches per call:        50  (across all files)
 *   - max_matches_per_file:        50  (one entry per matching line)
 *   - max_files_scanned:           500 (early-exit even if matches < max)
 *   - max_file_size_bytes:         200_000 (skip larger files)
 *   - snippet_chars:               200 (the trimmed matching line)
 *
 * Skipped subdirs (always): node_modules / .git / dist / target /
 * .next / __pycache__ / .venv / venv — covers the noisy
 * developer-tree case. The agent can override via `root` if it
 * specifically WANTS to search one of those.
 */
import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { AgentContext } from "../types"
import type { FileNode } from "@/types/wiki"
import type { ToolDefinition } from "./index"

export interface SearchLocalFilesInput {
  query: string
  /** Project-relative subdirectory to search under. Default: project root. */
  root?: string
  /** Glob to filter file names. Default: `*` (any). Supports `*` and `?` only. */
  glob?: string
  /** Max matches to return. Default 20, max 50. */
  limit?: number
  /** Case-sensitive match. Default false. */
  case_sensitive?: boolean
}

export type SearchLocalFilesResult =
  | {
      ok: true
      query: string
      root: string
      matches: Array<{
        /** Project-relative path with forward slashes. */
        path: string
        /** The matching line, trimmed to snippet_chars. */
        snippet: string
        /** 1-indexed line number of this match. */
        line: number
      }>
      files_scanned: number
      truncated: boolean
    }
  | { error: "invalid_input"; detail: string }
  | { error: "scan_failed"; detail: string }

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50
const MAX_MATCHES_PER_FILE = 50
const MAX_FILES_SCANNED = 500
const MAX_FILE_SIZE_BYTES = 200_000
const SNIPPET_CHARS = 200

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".llm-wiki",
  ".llm-wiki-local",
])

export const searchLocalFilesTool: ToolDefinition<SearchLocalFilesInput, SearchLocalFilesResult> = {
  name: "search_local_files",
  description:
    "Search file CONTENTS inside the user's current project for a plain " +
    "substring. Returns EVERY matching line (one entry per line, with its " +
    "line number + snippet), up to `limit` total (default 30, max 50). " +
    "This is the right tool to ENUMERATE all mentions of something — e.g. " +
    "'list every time I played badminton' — in one call: search `wiki` (or " +
    "the relevant file) and you get all the dated lines at once, so you do " +
    "NOT need to read the whole page or re-search with different keywords. " +
    "If the result is `truncated`, narrow the query or raise `limit`.\n\n" +
    "Scoped strictly to the project directory — relative subroots " +
    "(`raw/sources`, `wiki`) are allowed, absolute paths and path traversal " +
    "(../) are rejected. Use this for anything in the user's files: ingested " +
    "wiki pages, raw sources, drafts, scratch notes — before falling back to " +
    "web_fetch / web_search.\n\n" +
    "Search is plain-text + case-insensitive by default. Provide a `glob` " +
    "(e.g. '*.md' or 'notes-*.txt') to filter by filename. The walk skips " +
    "noisy directories (node_modules, .git, dist, etc.) automatically.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Plain-text substring to search for in file contents.",
        minLength: 1,
        maxLength: 200,
      },
      root: {
        type: "string",
        description:
          "Project-relative subdirectory to search under (e.g. 'wiki', " +
          "'raw/sources'). Empty / omitted = project root.",
      },
      glob: {
        type: "string",
        description:
          "Filename glob to filter results. Only `*` and `?` are supported " +
          "(no character classes, no `**`). Default `*` matches all files.",
      },
      limit: {
        type: "integer",
        description: `Max matching lines to return across all files (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
      case_sensitive: {
        type: "boolean",
        description: "Match case-sensitively. Default false.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(
    input: SearchLocalFilesInput,
    ctx: AgentContext,
  ): Promise<SearchLocalFilesResult> {
    if (ctx.signal.aborted) {
      throw new Error("search_local_files aborted by signal")
    }
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return { error: "invalid_input", detail: "query must be a non-empty string" }
    }
    const query = input.query
    const limit = clampLimit(input.limit)
    const caseSensitive = input.case_sensitive === true
    const needle = caseSensitive ? query : query.toLowerCase()

    const projectRoot = normalizePath(ctx.project.path)
    const rootInput = (input.root ?? "").trim()
    const rootCheck = validateProjectRelative(rootInput)
    if (rootCheck) return { error: "invalid_input", detail: rootCheck }
    const scanRoot = rootInput.length === 0
      ? projectRoot
      : `${projectRoot}/${rootInput.replace(/^\/+|\/+$/g, "")}`

    const glob = (input.glob ?? "*").trim()
    const globRe = compileSimpleGlob(glob)
    if (!globRe) {
      return {
        error: "invalid_input",
        detail: `glob "${glob}" not supported (only * and ? metacharacters allowed)`,
      }
    }

    let tree: FileNode[]
    try {
      tree = await listDirectory(scanRoot)
    } catch (err) {
      return {
        error: "scan_failed",
        detail: `failed to list ${rootInput || "(project root)"}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }

    const matches: Array<{ path: string; snippet: string; line: number }> = []
    let filesScanned = 0
    let truncated = false

    const walk = async (nodes: FileNode[]): Promise<void> => {
      for (const node of nodes) {
        if (ctx.signal.aborted) return
        if (matches.length >= limit) return
        if (filesScanned >= MAX_FILES_SCANNED) {
          truncated = true
          return
        }
        if (node.is_dir) {
          if (SKIP_DIRS.has(node.name)) continue
          if (node.children) {
            await walk(node.children)
          }
          continue
        }
        if (!globRe.test(node.name)) continue
        filesScanned += 1
        const content = await readFile(node.path).catch(() => null)
        if (content === null) continue
        if (content.length > MAX_FILE_SIZE_BYTES) continue
        const rel = node.path.startsWith(projectRoot + "/")
          ? node.path.slice(projectRoot.length + 1)
          : node.path
        // Collect EVERY matching line in this file (one entry per line),
        // up to MAX_MATCHES_PER_FILE. A line containing the needle more
        // than once still yields a single entry. This is what lets the
        // agent enumerate "all mentions of X" from one call.
        // Split on \r?\n so Windows CRLF files don't leave a trailing \r
        // in the snippet (the user's diary case came from the Windows build).
        const lines = content.split(/\r?\n/)
        let fileMatches = 0
        for (let li = 0; li < lines.length; li++) {
          if (matches.length >= limit) {
            truncated = true
            return
          }
          const rawLine = lines[li]
          const hay = caseSensitive ? rawLine : rawLine.toLowerCase()
          if (!hay.includes(needle)) continue
          const trimmed = rawLine.trim()
          matches.push({
            path: rel,
            snippet:
              trimmed.length > SNIPPET_CHARS ? trimmed.slice(0, SNIPPET_CHARS) + "…" : trimmed,
            line: li + 1,
          })
          fileMatches += 1
          if (fileMatches >= MAX_MATCHES_PER_FILE) {
            // More hits may exist in this file; flag it so the agent can
            // narrow the query if it needs the rest.
            truncated = true
            break
          }
        }
      }
    }

    try {
      await walk(tree)
    } catch (err) {
      return {
        error: "scan_failed",
        detail: err instanceof Error ? err.message : String(err),
      }
    }

    return {
      ok: true,
      query,
      root: rootInput || "",
      matches,
      files_scanned: filesScanned,
      truncated: truncated || matches.length >= limit,
    }
  },
}

/* ────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────*/

/** Returns null if OK, error message otherwise. */
function validateProjectRelative(p: string): string | null {
  if (!p) return null
  if (p.startsWith("/") || p.startsWith("\\")) {
    return "root must be project-relative (no leading / or \\)"
  }
  const segments = p.split(/[/\\]/)
  for (const seg of segments) {
    if (seg === "..") return "root contains parent-directory segment '..'"
    if (seg === ".") return "root contains current-directory segment '.'"
  }
  return null
}

/** `*` → `.*`, `?` → `.`, anchored. Returns null for unsupported metachars. */
function compileSimpleGlob(glob: string): RegExp | null {
  // Reject any other regex-meaningful char; we want plain glob semantics.
  let re = "^"
  for (const ch of glob) {
    if (ch === "*") re += ".*"
    else if (ch === "?") re += "."
    else if (/[.+^$\\|()[\]{}]/.test(ch)) re += "\\" + ch
    else re += ch
  }
  re += "$"
  try {
    return new RegExp(re, "i")
  } catch {
    return null
  }
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT
  if (raw < 1) return 1
  if (raw > MAX_LIMIT) return MAX_LIMIT
  return Math.floor(raw)
}
