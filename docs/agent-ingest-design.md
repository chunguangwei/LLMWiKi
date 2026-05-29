# Agent Ingest — Design Doc

> Status: **Draft** — written before implementation.
> Target version: 0.5.x (separate `agent-ingest` branch until validated)
> Platforms: macOS (Apple Silicon + Intel) + Windows (x64) + Linux (x64/arm64)

## 1. Motivation

The current ingest pipeline (`smart-split → analyze → generate 34-type pages`) is a **fixed pipeline**: every source is chunked, every chunk is fed through the same prompts, and the LLM is a passive transformer at each step. This works well for source documents that fit comfortably in the LLM's context window, but degrades for two important cases:

1. **Long sources** (50K+ tokens): the LLM gets lost in the middle of large chunks ([Lost-in-the-Middle](https://arxiv.org/abs/2307.03172) effect), drops cross-cutting concepts that span chunk boundaries, and produces inconsistent coverage when the same entity is mentioned in multiple chunks but only paraphrased differently each time.
2. **Schema-driven recall**: the user's `purpose.md` / `schema.md` defines what *should* end up in the wiki, but smart-split doesn't actively check coverage against that schema. Topics the user explicitly wants extracted can be silently missed.

**Agentic ingestion** flips the control: instead of the LLM being a passive transformer, the LLM is the **active agent** that decides what to read, what to extract, and what to write — using tools (search / read / write / mark-covered) over an indexed source. This matches Karpathy's "LLM as stream/processor over structured memory" framing exactly: the source is decomposed into searchable chunks (memory), the wiki schema defines the goal state, and the LLM iteratively closes the gap.

Industry precedent: Claude Code, Cursor, Cline, Aider, and the various Deep Research agents all converged on this pattern for the analogous problem of "reason over a large codebase / corpus without stuffing it into context". We adopt the same pattern for wiki ingest.

### 1.1 What this does NOT change

The wiki itself, the 34-type schema, the 4-signal knowledge graph, the chat / search / lint experiences, and the `.llmwiki` import/export format **stay the same**. Agent ingest is a drop-in replacement for the `analyze + generate` step of the current pipeline — same inputs (source file + project state), same outputs (wiki pages + log + review items + index updates).

This means:

- The user's existing wikis don't need migration.
- The fallback path (classic smart-split + analyze) stays in the codebase, gated by a settings toggle, so any regression is one-click recoverable.
- All downstream components (knowledge graph, search index, embeddings) consume the same wiki page shape they consume today.

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Source document                          │
│       (raw/sources/<file>.md  or  raw/sources/web/<…>.md)       │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Pre-process (one-time per source — cheap)                      │
│   • Smart-split → chunks[]  (reuses existing splitter)          │
│   • Build line-range index   (chunk_id → start_line, end_line)  │
│   • Extract outline          (headings only, 1 LLM call)        │
│   • Compute vector embeddings (reuses LanceDB / existing infra) │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent loop  (multi-turn LLM with tools)                        │
│                                                                 │
│   System prompt: wiki schema + tool specs + coverage target     │
│   User turn:     source outline + current wiki state summary    │
│                                                                 │
│   Loop:                                                         │
│     Assistant → tool_use{name, input}                           │
│     Tool runner executes → returns tool_result                   │
│     (repeat until coverage_complete OR turn_budget exhausted)    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Coverage verify  (one final LLM call)                          │
│   • Compare source outline against wiki pages written           │
│   • Surface gaps as Review items                                │
│   • Mark source as ingested (or partially-ingested w/ TODOs)    │
└─────────────────────────────────────────────────────────────────┘
```

The pre-process step is deterministic and cheap (one LLM call for outline + reuse of existing splitter / embedder). The agent loop is the expensive part. The verify step is a single short LLM call.

## 3. Tool Protocol

The LLM calls these tools via Anthropic / OpenAI native tool calling. All tools are pure JSON-in / JSON-out, no side effects outside the wiki project directory.

### 3.1 Source navigation

#### `search_source({query: string, top_k?: number})`

Hybrid text + vector search over the pre-indexed source chunks. Returns up to `top_k` (default 5) chunks ranked by combined score.

```ts
type SearchSourceResult = {
  chunks: Array<{
    chunk_id: string
    score: number
    line_range: [number, number]
    preview: string  // first 200 chars
  }>
}
```

The LLM uses this to find sections relevant to a concept / entity / topic it's working on. Inspired by Claude Code's `Grep` + vector overlay.

#### `read_chunk({chunk_id: string})`

Read the full text of one chunk. Returns the chunk content plus metadata (line range, surrounding-chunk references).

```ts
type ReadChunkResult = {
  chunk_id: string
  line_range: [number, number]
  content: string
  prev_chunk_id?: string  // for context expansion
  next_chunk_id?: string
}
```

#### `read_outline()`

Return the source's heading tree (computed during pre-process). Lets the LLM plan extraction order without re-asking.

```ts
type ReadOutlineResult = {
  headings: Array<{
    level: number       // 1 = H1, 2 = H2, ...
    text: string
    line_start: number
    chunk_id: string    // chunk that contains this heading
  }>
}
```

### 3.2 Wiki inspection

#### `list_wiki_pages({type?: string})`

List existing wiki pages, optionally filtered by `type` slug. Each entry is title + slug + brief description (from frontmatter or first paragraph).

```ts
type ListWikiPagesResult = {
  pages: Array<{
    slug: string
    type: string
    title: string
    description: string  // first 200 chars or frontmatter description
    related?: string[]
  }>
}
```

This is what stops the agent from creating duplicate pages.

#### `read_wiki_page({slug: string})`

Read an existing wiki page in full. Used when the agent decides to UPDATE rather than CREATE.

```ts
type ReadWikiPageResult = {
  slug: string
  type: string
  title: string
  frontmatter: Record<string, unknown>
  body: string
}
```

### 3.3 Wiki mutation

#### `write_wiki_page({slug: string, type: string, title: string, body: string, related?: string[], tags?: string[]})`

Create a new wiki page. Validates the type against the 34-type schema, ensures the slug is unique (rejects if taken), writes frontmatter + body. The runner is responsible for atomically writing the file and updating index.md.

```ts
type WriteWikiPageResult = {
  path: string         // e.g. "wiki/concepts/foo.md"
  created: true
}
| { error: "slug_taken" | "invalid_type" | "validation_failed", detail: string }
```

#### `update_wiki_page({slug: string, body: string, related?: string[], tags?: string[]})`

Append-or-merge content into an existing page. The runner handles diff-and-merge logic; the agent provides the full new body and the runner figures out what changed (for the log).

```ts
type UpdateWikiPageResult = {
  path: string
  updated: true
  added_chars: number
}
| { error: "slug_not_found", detail: string }
```

#### `link_pages({from_slug: string, to_slug: string, bidirectional?: boolean})`

Add a wikilink from page A to page B (and optionally back). The runner handles the wikilink insertion into the related: frontmatter array and a "## Related" section if it doesn't already reference the target.

### 3.4 Coverage tracking

#### `mark_section_covered({chunk_id: string, covered_by: string[]})`

Tell the runner "I've extracted everything I want from this chunk; the resulting wiki pages are [page_slugs]". The runner records this in the coverage tracker, which feeds into the final verify pass.

#### `surface_gap({topic: string, reason: string, related_chunks?: string[]})`

Tell the runner "I see this topic mentioned in the source but it doesn't warrant a wiki page right now (e.g. only mentioned in passing) — make a review item so the user can decide". This is how the agent declines to extract something without losing the trace.

### 3.5 Loop control

#### `done({reason: string})`

The agent signals completion. The runner moves to the verify pass. Without this tool, the runner would have to infer completion from a stable-state heuristic, which is fragile.

## 4. Agent Loop Algorithm

```ts
async function runAgentIngest(opts: {
  sourcePath: string
  project: WikiProject
  llmConfig: LlmConfig
  signal: AbortSignal
}): Promise<AgentIngestResult> {
  // 1. Pre-process
  const chunks = await smartSplit(opts.sourcePath)
  const outline = await extractOutline(chunks, opts.llmConfig)
  const vectorIndex = await embedChunks(chunks, opts.project)
  const wikiState = await summarizeWikiState(opts.project)

  // 2. Build system + initial user prompt
  const systemPrompt = buildAgentSystemPrompt({
    schema: await loadSchema(opts.project),
    purpose: await loadPurpose(opts.project),
    tools: ALL_TOOLS,
  })
  const initialUser = buildInitialUserMessage({
    sourcePath: opts.sourcePath,
    outline,
    wikiStateSummary: wikiState,
  })

  // 3. Agent loop
  const tracker = new CoverageTracker(chunks, outline)
  const ctx = { chunks, vectorIndex, project: opts.project, tracker }
  let messages = [{ role: "user", content: initialUser }]
  const MAX_TURNS = 50  // configurable
  const MAX_TOKENS = 200_000  // configurable

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.signal.aborted) break
    if (tokensSpent(messages) >= MAX_TOKENS) {
      // Surface a "ran out of budget" review item; bail out
      tracker.markBudgetExhausted()
      break
    }

    const response = await streamChatWithTools(
      opts.llmConfig,
      systemPrompt,
      messages,
      ALL_TOOLS,
      opts.signal,
    )
    messages.push({ role: "assistant", content: response.content })

    // Process tool calls — sequential for first version
    if (response.tool_calls.length === 0) {
      // Model replied with text only; treat as implicit done
      break
    }
    const toolResults = []
    for (const call of response.tool_calls) {
      if (call.name === "done") {
        tracker.markCompleted(call.input.reason)
        break
      }
      const result = await executeTool(call, ctx)
      toolResults.push({ tool_use_id: call.id, content: result })
    }
    messages.push({ role: "user", content: toolResults })
    if (tracker.isComplete()) break
  }

  // 4. Verify pass
  const verifyResult = await runVerifyPass(opts, outline, tracker)

  return {
    pagesCreated: tracker.createdPages(),
    pagesUpdated: tracker.updatedPages(),
    reviewItemsCreated: [...tracker.gaps(), ...verifyResult.gaps],
    coverage: tracker.coveragePercent(),
    turnsUsed: turn,
    tokensSpent: tokensSpent(messages),
  }
}
```

**Key invariants:**

- The agent loop is **single-threaded** per source. No parallel tool calls in the first version. Parallel introduces race conditions on wiki pages and makes the coverage tracker harder to reason about.
- Every tool call mutates the runner's `ctx` and (where relevant) the file system **atomically** — partial writes are not visible to subsequent tool calls or to other agents.
- Aborts (via `opts.signal`) interrupt at tool-call boundaries, not mid-tool. Partial work survives via the coverage tracker's checkpoint file.

## 5. Coverage Tracker

A purely in-memory object during the loop, persisted to `<project>/.llm-wiki/agent-checkpoints/<source-id>.json` between loop turns. Shape:

```json
{
  "sourcePath": "raw/sources/foo.md",
  "sourceHash": "sha256:...",
  "totalChunks": 42,
  "coveredChunks": ["chunk_0", "chunk_3", ...],
  "pagesCreated": [
    { "slug": "concepts/x", "fromChunks": ["chunk_1", "chunk_2"] }
  ],
  "pagesUpdated": [
    { "slug": "entities/y", "fromChunks": ["chunk_5"] }
  ],
  "gaps": [
    { "topic": "mentions of Z without enough context", "relatedChunks": ["chunk_8"] }
  ],
  "turnsUsed": 23,
  "tokensSpent": 145_000,
  "completed": false,
  "budgetExhausted": false
}
```

Functions:

- `markCovered(chunk_id, page_slugs)` — record this chunk → these pages mapping.
- `markCreated(slug, fromChunks)` — record a new page.
- `markUpdated(slug, fromChunks)` — record an update.
- `surfaceGap(topic, chunks)` — record an uncovered topic.
- `coveragePercent()` — `coveredChunks.length / totalChunks`.
- `isComplete()` — `coveragePercent() ≥ 0.85` OR `completed === true`.

The 0.85 threshold is conservative; not every chunk needs a wiki page (e.g. boilerplate front matter, references section). The verify pass catches genuinely missing content even if coverage is high.

## 6. Verify Pass

One final LLM call after the agent loop ends. Inputs:

- The source outline (headings)
- The list of wiki pages created/updated during this ingest run
- The coverage tracker's gap list

Prompt: "For each top-level heading in the source, did the ingest produce a wiki page (or update an existing one) that captures its content? List any headings whose content is missing or under-represented."

Output: list of missing-coverage items, each becomes a Review item with a deep link back to the source line range.

This is the cheapest practical guard against the LLM declaring `done` prematurely.

## 7. Cross-Platform Considerations

The agent ingest runs entirely in TypeScript on top of existing Tauri primitives, so platform parity is mostly free. Specific points to watch:

| Concern | macOS | Windows | Notes |
|---|---|---|---|
| File path separators | `/` | `\` (Windows) but Tauri normalizes to `/` for `convertFileSrc` | All path manipulation must go through `normalizePath` in `lib/path-utils.ts`. The agent **must never** construct paths with raw `\`. |
| Atomic file write | `rename` over | `rename` over | Use existing `writeFileAtomic` from `commands/fs.rs` (already cross-platform via Rust `fs::rename`). |
| Checkpoint persistence | `.llm-wiki/agent-checkpoints/` | same | Hidden dir convention works on both. Windows treats files starting with `.` as normal files, no special hiding, but that's fine. |
| Long path support | N/A | Windows MAX_PATH = 260 chars; project paths inside Documents can already approach this | Slug generation must cap at 50 chars (already does); source-id hashes use 12 hex chars to keep checkpoint filenames short. |
| Concurrent file watcher | FSEvents | ReadDirectoryChangesW | The agent writes wiki pages while the existing file watcher is active. Both platforms debounce; no new code needed. |
| Tool-call streaming | Anthropic / OpenAI streaming SSE | same | Tauri's plugin-http handles streams identically. |
| Abort signal | works | works | `AbortController.signal` propagates through `streamChat` on both. |

### 7.1 Windows-specific test cases

1. Source path with spaces and Chinese characters (`C:\Users\张三\Documents\项目笔记.md`)
2. Checkpoint file with non-ASCII source filename
3. Long deeply-nested wiki output paths

These are covered by existing tests in `path-utils.test.ts` and `commands/fs.rs` tests; the agent doesn't introduce new path machinery.

## 8. Integration with Existing Ingest Pipeline

Phase 1: **co-exist, opt-in**. The agent ingest lives behind a settings toggle (`agentIngestEnabled: false` by default) and an experimental flag on the sources view ("Try agent ingest (experimental)" button). The existing pipeline is unchanged.

Phase 2: **opt-in default for new projects**, opt-out for existing. After a few weeks of validation, new projects start with the agent ingest enabled; existing projects keep their setting.

Phase 3: **agent becomes default**. The classic pipeline becomes the fallback ("agent ingest failed, retrying with classic pipeline").

The fallback is important: agent ingest is more LLM-dependent than smart-split. If the LLM endpoint goes down mid-loop, we want classic ingest as a recovery path.

### 8.1 Shared code

The agent ingest reuses:

- `lib/smart-split.ts` (existing) — chunking
- `lib/ingest-queue.ts` (existing) — task management
- `lib/embedding.ts` (existing) — vector index
- `lib/source-identity.ts` (existing) — stable source ids
- `lib/sources-merge.ts` (existing) — index.md updates
- `lib/persist.ts` (existing) — review item persistence

The agent ingest adds:

- `lib/agent-ingest/runner.ts` — the loop driver
- `lib/agent-ingest/tools/` — tool implementations (one file per tool category)
- `lib/agent-ingest/tracker.ts` — coverage tracker
- `lib/agent-ingest/prompts.ts` — system + user prompt builders
- `lib/agent-ingest/checkpoint.ts` — load / save checkpoint files
- `lib/agent-ingest/verify.ts` — final verification pass
- `lib/agent-ingest/index.ts` — public entry point

Tests live next to each source file.

## 9. Phased Rollout

| Phase | Scope | LOC estimate | Duration |
|---|---|---|---|
| **Phase A — Tool layer** | All 10 tools as standalone TS functions, with mock context. Pure unit-tested. | ~1500 | 1 day |
| **Phase B — Loop runner** | The agent loop with mock LLM. Integration tested with a recorded transcript. | ~800 | 1 day |
| **Phase C — Anthropic / OpenAI tool-call integration** | Live LLM with tool calling. End-to-end test on a small source. | ~400 | 0.5 day |
| **Phase D — Sources view UI** | "Try agent ingest" button + experimental tag in the toolbar. Coverage % shown in the activity panel. | ~300 | 0.5 day |
| **Phase E — Coverage tracker + verify pass** | Tracker, checkpoint persistence, verify pass, review-item integration. | ~600 | 1 day |
| **Phase F — Real-world validation** | Run on 5-10 real sources (mix of long PDFs, web pages, code-heavy docs). Tune turn budget, tool selection, prompts. | n/a | 1-2 days |

Total: **5-6 days of focused work**, plus validation.

## 10. Testing Strategy

| Test | Where |
|---|---|
| Each tool's input validation, error paths | `tools/*.test.ts` (vitest) |
| Coverage tracker invariants (don't double-count, idempotent calls) | `tracker.test.ts` |
| Checkpoint round-trip (write → load → resume) | `checkpoint.test.ts` |
| Loop runner with mocked LLM responses | `runner.test.ts` |
| Verify pass identifies known gaps | `verify.test.ts` |
| **End-to-end** with recorded LLM transcript (replays a real session deterministically) | `e2e/recorded.test.ts` |
| **Real-LLM** smoke test (skipped in CI, run locally) | `e2e/real-llm.test.ts` |

The recorded-transcript test is critical: it locks in expected behavior without burning tokens on every CI run.

## 11. Open Questions / Decisions to Make

These are explicit decisions deferred until implementation, with current leanings:

1. **Turn budget vs token budget**: which is the primary stop condition?
   *Lean*: token budget primary (it's what costs money), turn budget is a safety net.
2. **Should `done` require coverage ≥ threshold, or can the LLM declare done at any point?**
   *Lean*: LLM can declare done; the verify pass + gap-as-review-item handles incomplete coverage.
3. **How to surface progress to the user?**
   *Lean*: existing activity panel + a coverage % bar. Per-turn detail shown in a collapsed log.
4. **Should we cache tool results?** e.g. `read_chunk(chunk_id)` is idempotent for a given source.
   *Lean*: yes, cheap to cache in-memory for the loop's lifetime. No persistence needed.
5. **What if the LLM tries to call a tool with garbage input?**
   *Lean*: tool runner validates with a JSON schema, returns an error result, doesn't crash. The LLM sees the error and (usually) retries with corrected input — Claude Code does this gracefully.
6. **Multi-source agent runs?** Some users will want "ingest all unprocessed sources" with one agent.
   *Lean*: NOT in v1. One source per agent run keeps the loop bounded and debuggable. Multi-source comes later if useful.

## 12. Failure Modes & Retry Semantics

| Failure | Detection | Recovery |
|---|---|---|
| LLM network error mid-loop | `streamChat` `onError` | Save checkpoint with `partial: true`. Surface as a retriable activity item. User clicks retry → loop resumes from last assistant turn. |
| LLM emits malformed tool call (no `tool_use` block) | Parser | Inject a system-side note into the next user turn ("Your last response had no tool calls. Either call a tool or call `done({reason}).`"). Hard cap of 3 such corrections before bailing. |
| Tool input validation fails | JSON schema | Return `{error, detail}` to the LLM as the tool result. LLM almost always corrects on next turn. |
| `write_wiki_page` slug collision | Slug uniqueness check | Return `{error: "slug_taken"}`. The LLM should `read_wiki_page` and `update_wiki_page` instead — surfaced in the error message. |
| Agent loops forever on the same chunks | Coverage tracker monotonicity check | After 5 turns with no change in `coveredChunks` size, bail out with a review item ("agent appears stuck"). |
| Token budget exhausted before `done` | Counter | Bail, mark `budgetExhausted`, surface review item with what's already covered + the gap list. User can resume by re-queueing the source — the checkpoint skips already-covered chunks. |

## 13. References

- Karpathy, "[The state of LLMs](https://www.youtube.com/watch?v=zjkBMFhNj_g)" — LLM as stream/processor framing
- Anthropic, "[Building agents with Claude](https://www.anthropic.com/research/swe-bench-sonnet)" — tool-call orchestration patterns
- Liu et al., "[Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)" — motivation for chunked + agentic over long-context
- Claude Code tool catalog — analogous tool surface (Grep / Read / Edit / Write) over a different corpus shape

## 14. Open for Comment

This is a draft. Specifically looking for input on:

- Tool surface: am I missing a tool, or proposing one that's not pulling its weight?
- Coverage threshold: 0.85 vs 0.90 vs something else? (Empirical question — Phase F will tune.)
- Token budget default: 200K seems high but sources can be huge. 100K may be too tight for a 100-page PDF.
- Should the verify pass be its own agent loop (small, focused) instead of a single LLM call?

Comments → file an issue at https://github.com/chunguangwei/LLMWiKi/issues or mention @weichunguang in any wiki page that links to this doc.
