/**
 * Slug validation for wiki page identifiers.
 *
 * The agent's tools (write_wiki_page / update_wiki_page / link_pages /
 * read_wiki_page) accept slugs as wiki-relative paths without the
 * `.md` extension — e.g. "concepts/foo", "Books/原则-读书笔记".
 *
 * Untrusted slugs (from a fresh LLM tool call) need to be rejected
 * BEFORE they reach the WikiAccess impl, because:
 *
 *   - The impl builds an on-disk path by joining the slug to the
 *     project's wiki/ root. A slug like "../../etc/passwd" would
 *     escape the project — every wiki writer MUST reject path
 *     traversal at the tool layer.
 *   - Windows reserves characters (<>:"|?*) and names (CON, NUL,
 *     COM1, PRN, AUX, ...) that crash file operations even when
 *     the rest of the path is valid. Rejecting these centrally
 *     means each tool isn't reimplementing the same checklist.
 *   - Empty / pure-whitespace slugs round-trip through `readPage`
 *     as plain-string lookups but never resolve to a file, which
 *     burns an LLM round-trip on a guaranteed slug_not_found.
 *
 * Returns `null` when the slug is acceptable, otherwise a short
 * human-readable reason the tool can surface back to the LLM
 * verbatim ("slug cannot start with '/'", etc).
 */

const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])

// Characters that crash filesystem ops on Windows (and break the
// markdown wikilink syntax on every platform). Backslash IS
// included — Windows allows it as a path separator but our slug
// convention is forward-slash only, and accepting both creates a
// trivial path-confusion bug.
const ILLEGAL_CHARS_RE = /[<>:"|?*\\\x00-\x1f]/

/**
 * Validate a slug. Returns null on accept, or a short reason on
 * reject. Caller treats reject as { error: "invalid_input", detail }.
 */
export function validateSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return "slug must be a string"
  const slug = raw.trim()
  if (slug.length === 0) return "slug must be non-empty"
  if (slug.length > 200) return "slug is too long (max 200 chars)"

  if (slug.startsWith("/")) return "slug must be relative (cannot start with '/')"
  if (slug.startsWith("\\")) return "slug must use forward slashes (cannot start with '\\\\')"
  if (slug.endsWith("/")) return "slug must point at a file, not a directory (trailing '/')"

  // Slug must not look like an existing .md file — the agent has
  // already stripped the extension by convention. Check up front
  // because otherwise a slug like "con.md" would first trip the
  // Windows-reserved-name check on "con" and emit a confusing
  // reason for what's really an extension issue.
  if (slug.endsWith(".md")) {
    return "slug must NOT include the '.md' extension"
  }

  // Path traversal — split on `/` and check no segment is `..` or `.`
  // (which would resolve outside the wiki root after normalization).
  const segments = slug.split("/")
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      return `slug contains an invalid path segment "${seg}"`
    }
    if (ILLEGAL_CHARS_RE.test(seg)) {
      return `slug contains a reserved character (one of <>:"|?*\\\\ or control char)`
    }
    // Windows reserved name match is case-insensitive and ignores
    // the optional extension suffix (CON.txt is also reserved).
    const lower = seg.toLowerCase().split(".")[0]
    if (WINDOWS_RESERVED_NAMES.has(lower)) {
      return `slug uses Windows-reserved name "${seg}"`
    }
  }
  return null
}

/**
 * Slugify a human title into a slug-safe segment. Used by the
 * write_wiki_page tool's "no slug provided, infer from title"
 * pathway. NOT applied to user-provided slugs — those go through
 * validateSlug strict.
 *
 * Rules:
 *   - lowercase ASCII letters / digits / `-` / `_` kept as-is
 *   - CJK characters preserved (the fork's wiki convention)
 *   - other punctuation / whitespace runs collapsed to single `-`
 *   - leading / trailing `-` trimmed
 *   - capped at 60 chars to leave headroom inside the 200-char slug budget
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9_一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled"
}
