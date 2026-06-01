/**
 * LLM-driven annotation for `wiki/index.md` bullets.
 *
 * Karpathy frame: reconcile gives index its COMPLETENESS guarantee
 * (every page listed); this layer gives index its SEMANTIC layer
 * (one-line "what's this about" per entry). The mechanical pass
 * ensures correctness, the LLM pass adds meaning — two independent
 * concerns sharing the same target file.
 *
 *   - **Idempotent**: if every bullet already has `— description`,
 *     no LLM call fires. The annotator is safe to invoke after
 *     every reconcile.
 *
 *   - **Cached by content hash**: a `.llm-wiki/index-annotations.json`
 *     stores `slug → { hash, description }`. Pages with unchanged
 *     content reuse the cached description; only newly-written or
 *     edited pages get re-annotated. This keeps token cost
 *     proportional to drift, not to wiki size.
 *
 *   - **Batched**: all un-annotated bullets go to the LLM in ONE
 *     call (or N batches when the token budget is tight). For 100
 *     pages that's one round-trip vs. 100.
 *
 *   - **Best-effort**: a failed LLM call leaves the index as-is.
 *     The Karpathy-frame invariant (every page listed) is upheld
 *     by reconcile; descriptions are a quality-of-life layer that
 *     a transient provider hiccup shouldn't block.
 */
import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"

export interface AnnotateResult {
  /** How many bullets the function attempted to annotate. */
  attempted: number
  /** How many descriptions came back from the LLM call. */
  produced: number
  /** Bullets already cached (no LLM call). */
  cached: number
  /** Bullets the LLM returned an empty / unusable string for. */
  failed: number
  /** True when the LLM call itself failed (caught + logged). */
  llmError: boolean
}

interface CacheEntry {
  hash: string  // sha256 of body
  description: string
  updatedAt: string  // ISO date
}

type Cache = Record<string, CacheEntry>  // keyed by slug

/** Bullet pattern: `- [[slug]]` or `- [[slug|title]]`, optionally
 *  followed by ` — description` (em-dash) or ` -- description`. */
const BULLET_RE = /^(\s*[-*+]\s+\[\[)([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]([ \t]*[—-]{1,2}[ \t]*(.+))?$/

/**
 * Pure parsing helper — extracts (slug, title, existing description)
 * from a single line. Returns null when the line isn't a wikilink
 * bullet. Exported for tests.
 */
export function parseBullet(line: string): {
  prefix: string
  slug: string
  alias: string | null
  description: string | null
} | null {
  const m = line.match(BULLET_RE)
  if (!m) return null
  return {
    prefix: m[1],
    slug: m[2].trim(),
    alias: m[3]?.trim() ?? null,
    description: m[5]?.trim() ?? null,
  }
}

/** Pure formatter — composes the bullet back. Always uses ` — `
 *  (em dash with surrounding spaces) so newly-annotated and
 *  hand-curated bullets render identically. */
export function formatBullet(args: {
  prefix: string
  slug: string
  alias: string | null
  description: string | null
}): string {
  const linkPart = args.alias
    ? `${args.prefix}${args.slug}|${args.alias}]]`
    : `${args.prefix}${args.slug}]]`
  if (!args.description || args.description.length === 0) return linkPart
  return `${linkPart} — ${args.description}`
}

/* ────────────────────────────────────────────────
 * Page reading + hashing
 * ────────────────────────────────────────────────*/

/** Cheap, browser-safe content hash. We don't need cryptographic
 *  guarantees — just "did this body change since the last
 *  annotation" — so FNV-1a is enough and avoids the SubtleCrypto
 *  async dance. Hex-encoded for human-friendly diffs. */
function hashBody(body: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** Read a page's body + frontmatter title. Returns null when the
 *  file doesn't exist (caller filters those bullets out). */
async function readPageForAnnotation(
  wikiRoot: string,
  slug: string,
): Promise<{ title: string; body: string; hash: string } | null> {
  const path = `${wikiRoot}/${slug}.md`
  if (!(await fileExists(path))) return null
  let raw: string
  try {
    raw = await readFile(path)
  } catch {
    return null
  }
  const { frontmatter, body } = parseFrontmatter(raw)
  const fm = (frontmatter ?? {}) as Record<string, unknown>
  const title = typeof fm.title === "string" && fm.title.length > 0
    ? fm.title
    : slug.split("/").pop() ?? slug
  return { title, body, hash: hashBody(body) }
}

/* ────────────────────────────────────────────────
 * Cache I/O
 * ────────────────────────────────────────────────*/

function cachePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/index-annotations.json`
}

async function loadCache(projectPath: string): Promise<Cache> {
  try {
    const text = await readFile(cachePath(projectPath))
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object") return parsed as Cache
  } catch {
    // missing / corrupt — start fresh
  }
  return {}
}

async function saveCache(projectPath: string, cache: Cache): Promise<void> {
  try {
    await writeFileAtomic(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch (err) {
    console.warn("[index-annotate] could not persist cache:", err)
  }
}

/* ────────────────────────────────────────────────
 * LLM call
 * ────────────────────────────────────────────────*/

const SYSTEM_PROMPT = `You write one-line descriptions for wiki index entries.

For each page you are given:
  - The page slug (used as the key in your JSON response)
  - The page title
  - An excerpt of the page body

Write a SHORT description that captures the page's key fact / value.
Length: 10-25 Chinese characters OR 30-80 English characters. Match
the language of the title (Chinese title → Chinese description, mixed
→ Chinese, English → English).

DO NOT:
  - Repeat the title verbatim
  - Start with "This page" / "本页" / "About"
  - Add quotes around the description
  - Write multiple sentences

DO:
  - Lead with the most distinctive fact
  - Use noun phrases ending in a period-free phrase
  - Stay concrete and specific

Output JSON ONLY: {"<slug>": "<description>", ...}
Each slug maps to its description string. No prose, no markdown
fence, no other keys.`

interface AnnotationRequest {
  slug: string
  title: string
  excerpt: string
}

async function callLlm(
  llmConfig: LlmConfig,
  requests: AnnotationRequest[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  if (requests.length === 0) return {}
  const userBlock = requests
    .map(
      (r, i) =>
        `${i + 1}. slug: ${r.slug}\n   title: ${r.title}\n   excerpt: ${r.excerpt.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n\n")
  const user = `Pages to describe:\n\n${userBlock}\n\nRespond with JSON {"<slug>": "<description>", ...} for every slug above.`
  let collected = ""
  let hadError = false
  try {
    const { streamChat } = await import("@/lib/llm-client")
    await streamChat(
      llmConfig,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      {
        onToken: (t) => { collected += t },
        onDone: () => {},
        onError: (err) => {
          hadError = true
          console.warn(
            `[index-annotate] LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        },
      },
      signal,
      { temperature: 0, max_tokens: 2048, reasoning: { mode: "off" } },
    )
  } catch (err) {
    console.warn(
      `[index-annotate] LLM call threw: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
  if (hadError) return {}
  return parseLlmResponse(collected)
}

/** Extracts the slug→description map from the LLM's response. Tolerates
 *  a wrapping code fence and trailing prose. Exported for tests. */
export function parseLlmResponse(text: string): Record<string, string> {
  if (!text) return {}
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return {}
  const slice = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0) {
        out[k] = v.trim()
      }
    }
    return out
  } catch {
    return {}
  }
}

/* ────────────────────────────────────────────────
 * Public entry point
 * ────────────────────────────────────────────────*/

export interface AnnotateOpts {
  projectPath: string
  llmConfig: LlmConfig
  signal?: AbortSignal
  /** Cap per-LLM-call batch size. The LLM degrades on very long
   *  prompts, so we slice once the request hits this many entries
   *  (~6KB of prompt at body excerpt 300 chars each). */
  batchSize?: number
  /** Cap per-page body excerpt length sent to the LLM. */
  excerptChars?: number
}

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_EXCERPT_CHARS = 300

/**
 * Scan `wiki/index.md`, identify bullets with no description, batch
 * the under-described ones to the LLM, write back the augmented
 * index. Idempotent.
 */
export async function annotateIndex(opts: AnnotateOpts): Promise<AnnotateResult> {
  const projectPath = normalizePath(opts.projectPath)
  const wikiRoot = `${projectPath}/wiki`
  const indexPath = `${wikiRoot}/index.md`
  if (!(await fileExists(indexPath))) {
    return { attempted: 0, produced: 0, cached: 0, failed: 0, llmError: false }
  }
  const indexText = await readFile(indexPath)
  const lines = indexText.split("\n")

  // Step 1: parse each line, identify un-annotated bullets.
  type BulletState = {
    lineIdx: number
    parsed: NonNullable<ReturnType<typeof parseBullet>>
  }
  const unAnnotated: BulletState[] = []
  const parsedLines: Array<{ parsed: ReturnType<typeof parseBullet>; raw: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseBullet(lines[i])
    parsedLines.push({ parsed, raw: lines[i] })
    if (parsed && (!parsed.description || parsed.description.length === 0)) {
      unAnnotated.push({ lineIdx: i, parsed })
    }
  }
  if (unAnnotated.length === 0) {
    return { attempted: 0, produced: 0, cached: 0, failed: 0, llmError: false }
  }

  // Step 2: load cache, partition into cache-hit vs needs-LLM.
  const cache = await loadCache(projectPath)
  let cachedHits = 0
  const needsLlm: BulletState[] = []
  const pageInfo = new Map<string, { title: string; body: string; hash: string }>()
  for (const b of unAnnotated) {
    const info = await readPageForAnnotation(wikiRoot, b.parsed.slug)
    if (!info) continue  // page missing — leave the bullet alone; reconcile will drop it if truly broken
    pageInfo.set(b.parsed.slug, info)
    const cached = cache[b.parsed.slug]
    if (cached && cached.hash === info.hash) {
      // Cache hit: inject the cached description directly.
      lines[b.lineIdx] = formatBullet({ ...b.parsed, description: cached.description })
      cachedHits += 1
    } else {
      needsLlm.push(b)
    }
  }

  // Step 3: batch-call the LLM for remaining bullets.
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const excerptChars = opts.excerptChars ?? DEFAULT_EXCERPT_CHARS
  let produced = 0
  let failed = 0
  let llmError = false
  for (let start = 0; start < needsLlm.length; start += batchSize) {
    const batch = needsLlm.slice(start, start + batchSize)
    const requests: AnnotationRequest[] = batch.map((b) => {
      const info = pageInfo.get(b.parsed.slug)!
      return {
        slug: b.parsed.slug,
        title: info.title,
        excerpt: info.body.slice(0, excerptChars),
      }
    })
    const responses = await callLlm(opts.llmConfig, requests, opts.signal)
    if (Object.keys(responses).length === 0 && batch.length > 0) {
      // LLM gave us nothing for this batch — record the failure and
      // bail without retrying further batches.
      llmError = true
      failed += batch.length
      break
    }
    for (const b of batch) {
      const description = responses[b.parsed.slug]
      if (description && description.length > 0) {
        lines[b.lineIdx] = formatBullet({ ...b.parsed, description })
        cache[b.parsed.slug] = {
          hash: pageInfo.get(b.parsed.slug)!.hash,
          description,
          updatedAt: new Date().toISOString().slice(0, 10),
        }
        produced += 1
      } else {
        failed += 1
      }
    }
  }

  // Step 4: write the updated index + cache.
  const newText = lines.join("\n")
  if (newText !== indexText) {
    await writeFileAtomic(indexPath, newText)
  }
  await saveCache(projectPath, cache)
  return {
    attempted: unAnnotated.length,
    produced,
    cached: cachedHits,
    failed,
    llmError,
  }
}
