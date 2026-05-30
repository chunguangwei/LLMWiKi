/**
 * Type surface for the agent-ingest pipeline. Defined separately from
 * the runtime so test fixtures and tool implementations can share the
 * shapes without circular imports.
 *
 * See `docs/agent-ingest-design.md` §3 (Tool Protocol) for the
 * canonical specification — types here mirror the doc 1:1.
 */
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * One smart-split chunk of the source document. The agent navigates
 * the source via chunk_id, never by raw byte offsets — that way line-
 * range translations stay inside the runner and aren't the LLM's
 * problem to compute.
 */
export interface SourceChunk {
  chunk_id: string
  line_range: [number, number]
  content: string
  prev_chunk_id?: string
  next_chunk_id?: string
}

/** Outline entry — one heading from the source. */
export interface OutlineHeading {
  level: number
  text: string
  line_start: number
  chunk_id: string
}

/** Brief summary of one wiki page, returned by list_wiki_pages. */
export interface WikiPageSummary {
  slug: string
  type: string
  title: string
  description: string
  related?: string[]
}

/** Full wiki page content + parsed frontmatter. */
export interface WikiPageFull {
  slug: string
  type: string
  title: string
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * Abstraction over the wiki filesystem that the inspection / mutation
 * tools use. The runner wires this to real `commands/fs` calls; tests
 * provide a fake so tools can be exercised without touching disk.
 *
 * Why this rather than tools calling `commands/fs` directly:
 *
 *   - Testability — vi.mock("@/commands/fs") works but every test
 *     file would re-stub the same surface. A per-context dependency
 *     keeps the seam visible.
 *   - Sandboxing — every wiki access is scoped to the AgentContext's
 *     project. If a future agent runs across multiple projects, the
 *     wiki access is the natural place to enforce isolation.
 *   - Phase E checkpoint replay — recording WikiAccess calls is
 *     enough to deterministically replay an agent turn for the
 *     recorded-transcript test (docs/agent-ingest-design.md §10).
 *
 * Slug semantics: a slug is the wiki-relative path WITHOUT the .md
 * extension. Examples:
 *
 *   wiki/concepts/foo.md         → "concepts/foo"
 *   wiki/Books/原则-读书笔记.md   → "Books/原则-读书笔记"
 *   wiki/index.md                → "index"
 */
export interface WikiAccess {
  /**
   * Return summaries of every wiki page under the project's `wiki/`
   * directory. Skips index.md, log.md, overview.md (the wiki's
   * structural pages, not knowledge pages). If `filter.type` is
   * set, only pages with matching frontmatter `type:` are returned.
   *
   * Order: stable but unspecified — callers should sort if they
   * need a specific order.
   */
  listPages(filter?: { type?: string }): Promise<WikiPageSummary[]>

  /**
   * Read one page in full. Returns `null` when the slug doesn't
   * resolve to an existing .md file (the runner translates this
   * into a tool error result; we never throw for "missing").
   *
   * The frontmatter object is the parsed YAML — typed as
   * Record<string, unknown> because frontmatter is user / LLM
   * authored and can include arbitrary keys beyond the documented
   * type/title/created/tags/related/sources.
   */
  readPage(slug: string): Promise<WikiPageFull | null>

  /**
   * Create a new wiki page. The runner generates the frontmatter
   * from the supplied fields (type, title, related, tags) and
   * inserts the `created:` / `updated:` dates server-side so the
   * agent doesn't need to know them. The body is the markdown
   * after the closing `---` of the frontmatter.
   *
   * Result discriminator:
   *   - `{ kind: "created", path }`     — success; path is the
   *                                       wiki-relative .md path.
   *   - `{ kind: "slug_taken" }`        — slug already exists; the
   *                                       agent should `read_wiki_page`
   *                                       + `updatePage` instead.
   *   - `{ kind: "validation_failed",   — type isn't in the project
   *        detail }`                      schema, frontmatter invalid,
   *                                       etc.
   *
   * Never throws; every error is reported via the result.
   */
  writePage(opts: {
    slug: string
    type: string
    title: string
    body: string
    related?: string[]
    tags?: string[]
  }): Promise<
    | { kind: "created"; path: string }
    | { kind: "slug_taken" }
    | { kind: "validation_failed"; detail: string }
  >

  /**
   * Update an existing page with new body / related / tags.
   *
   * Semantics:
   *
   *   - `body` is the COMPLETE new body (after the closing `---`).
   *     The runner replaces the previous body atomically and records
   *     `added_chars` = max(0, newBody.length - oldBody.length) for
   *     the activity log. Frontmatter `type:` and `title:` are
   *     preserved — the agent can't change them via this tool
   *     (use write_wiki_page + delete-and-recreate for that).
   *   - `related` (if provided): UNION-merged with the existing
   *     frontmatter `related:`. The runner deduplicates. Empty array
   *     is a no-op — to clear relations, the agent must specifically
   *     edit the .md outside this tool.
   *   - `tags` (if provided): same union-merge semantics.
   *   - `updated:` date is bumped server-side. `created:` is
   *     preserved.
   *
   * Result discriminator:
   *
   *   - `{ kind: "updated", path, added_chars }` — success.
   *   - `{ kind: "slug_not_found" }`             — no page at slug.
   *                                                 The agent should
   *                                                 call write_wiki_page
   *                                                 instead (the tool
   *                                                 layer surfaces that hint).
   *   - `{ kind: "validation_failed", detail }`  — schema-level
   *                                                 reject (invalid
   *                                                 related slug,
   *                                                 etc).
   *
   * Never throws.
   */
  updatePage(opts: {
    slug: string
    body: string
    related?: string[]
    tags?: string[]
  }): Promise<
    | { kind: "updated"; path: string; added_chars: number }
    | { kind: "slug_not_found" }
    | { kind: "validation_failed"; detail: string }
  >

  /**
   * Add a wikilink from one page to another.
   *
   * Semantics:
   *
   *   - `from`'s `related:` frontmatter array gains `to` (if not
   *     already present). Idempotent — re-linking a pair is a no-op
   *     in terms of file content.
   *   - When `bidirectional` is true, `to` ALSO gains `from`. Each
   *     direction is independent: if the from→to link existed but
   *     to→from didn't, the call adds only to→from and reports
   *     was_new for that direction.
   *   - `from_was_new` / `to_was_new` report whether the runner
   *     actually changed the file. Lets the agent skip redundant
   *     link calls in subsequent turns (telemetry for the loop, not
   *     a correctness signal — re-linking is safe).
   *   - When `bidirectional` is false, `to_was_new` is omitted.
   *
   * Result discriminator:
   *
   *   - `{ kind: "linked", from_was_new, to_was_new? }` — success.
   *   - `{ kind: "slug_not_found", missing: "from" | "to" }` —
   *     one of the slugs has no page. The tool layer surfaces
   *     which side is missing so the LLM can fix the right one.
   *   - `{ kind: "validation_failed", detail }` — schema-level
   *     reject (cycle detection, etc — currently unused but
   *     reserved).
   *
   * Never throws.
   */
  linkPages(opts: {
    from: string
    to: string
    bidirectional?: boolean
  }): Promise<
    | { kind: "linked"; from_was_new: boolean; to_was_new?: boolean }
    | { kind: "slug_not_found"; missing: "from" | "to" }
    | { kind: "validation_failed"; detail: string }
  >
}

/** Runtime context threaded into every tool call. */
export interface AgentContext {
  /** All chunks indexed by chunk_id for O(1) lookup. */
  chunks: Map<string, SourceChunk>
  /** Heading tree extracted once during pre-process. */
  outline: OutlineHeading[]
  /** Vector index for semantic source search. */
  vectorIndex: VectorIndex
  /** Active wiki project. Tool implementations write under `project.path`. */
  project: WikiProject
  /** Wiki filesystem accessor — list / read / (future) write. */
  wikiAccess: WikiAccess
  /** Coverage tracker — single source of truth for "what's done". */
  tracker: CoverageTracker
  /** LLM config — used by sub-tasks that need their own LLM call (verify pass, future agents). */
  llmConfig: LlmConfig
  /** Abort signal from the loop runner — every tool MUST check this before any IO. */
  signal: AbortSignal
}

/**
 * Vector index over source chunks. Stub for now — Phase A wires in
 * the existing embedding pipeline (lib/embedding.ts).
 */
export interface VectorIndex {
  search(query: string, topK: number): Promise<Array<{ chunk_id: string; score: number }>>
}

/**
 * Coverage tracker — mutated by tool calls during the loop, persisted
 * between turns as JSON under `.llm-wiki/agent-checkpoints/`.
 *
 * Concrete implementation lives in `tracker.ts`. Interface here so
 * tools can be tested against a mock tracker without dragging in the
 * full file-persistence machinery.
 */
export interface CoverageTracker {
  markCovered(chunk_id: string, page_slugs: string[]): void
  markCreated(slug: string, fromChunks: string[]): void
  markUpdated(slug: string, fromChunks: string[]): void
  /**
   * Record a topic the agent noticed but won't extract right now.
   * `reason` is the agent's stated rationale ("only mentioned in
   * passing", "out of scope for this source"); preserved through to
   * the Review item the verify pass surfaces so the user can decide
   * whether to act on it later.
   */
  surfaceGap(topic: string, opts?: { reason?: string; chunks?: string[] }): void
  markCompleted(reason: string): void
  markBudgetExhausted(): void
  coveragePercent(): number
  isComplete(): boolean
  createdPages(): Array<{ slug: string; fromChunks: string[] }>
  updatedPages(): Array<{ slug: string; fromChunks: string[] }>
  gaps(): Array<{ topic: string; reason?: string; chunks?: string[] }>
  snapshot(): CoverageSnapshot
}

/** Persisted shape of the coverage tracker. Must round-trip through JSON. */
export interface CoverageSnapshot {
  sourcePath: string
  sourceHash: string
  totalChunks: number
  coveredChunks: string[]
  pagesCreated: Array<{ slug: string; fromChunks: string[] }>
  pagesUpdated: Array<{ slug: string; fromChunks: string[] }>
  gaps: Array<{ topic: string; reason?: string; relatedChunks?: string[] }>
  turnsUsed: number
  tokensSpent: number
  completed: boolean
  budgetExhausted: boolean
}

/** Final output of one agent-ingest run, for the activity panel. */
export interface AgentIngestResult {
  pagesCreated: Array<{ slug: string; fromChunks: string[] }>
  pagesUpdated: Array<{ slug: string; fromChunks: string[] }>
  reviewItemsCreated: Array<{ topic: string; reason?: string; chunks?: string[] }>
  coverage: number
  turnsUsed: number
  tokensSpent: number
  budgetExhausted: boolean
  /**
   * Reason field — either the LLM's stated reason via the `done` tool,
   * or a runner-side reason ("budget exhausted", "max turns hit",
   * "user aborted", ...).
   */
  reason: string
}
