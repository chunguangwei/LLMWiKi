/**
 * Public entry point for the agent-driven lint-fix path.
 *
 *   runLintFix(opts) →
 *     build runtime context (wikiAccess, empty source side, tracker) →
 *     compose system + initial-user prompts based on item.type →
 *     wire LLM adapter → run the agent loop → collect tracker
 *     snapshot → return LintFixResult.
 *
 * Designed for ONE lint item per call — lint-view.tsx invokes this
 * from `handleFix` when the Labs flag is on. Multiple lint items
 * mean multiple calls (they're independent fixes; sequencing avoids
 * concurrent wiki writes racing for the same page).
 *
 * What's intentionally shared with agent-ingest:
 *
 *   - runner.ts (loop, batch dispatch, done short-circuit)
 *   - agent-llm.ts (Anthropic + OpenAI adapters, all gateways)
 *   - tools/ (10 of 13 — only mark_section_covered / surface_gap /
 *     read_outline / read_chunk / search_source are no-ops here
 *     because no source chunks exist)
 *
 * What's local to lint-fix:
 *
 *   - prompts.ts (per-type system prompt + user prompt)
 *   - tracker.ts (extends InMemoryCoverageTracker with markDeleted)
 *   - this entry point (wires the smaller AgentContext)
 */
import { readFile } from "@/commands/fs"
import { createAgentLlm } from "@/lib/agent-ingest/agent-llm"
import { runAgentLoop } from "@/lib/agent-ingest/runner"
import {
  assertSchemasUnique,
  toolSchemasForLlm,
} from "@/lib/agent-ingest/tool-schemas"
import { FileSystemWikiAccess } from "@/lib/agent-ingest/wiki-access"
import { normalizePath } from "@/lib/path-utils"
import type { LintItem } from "@/stores/lint-store"
import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type {
  AgentContext,
  OutlineHeading,
  SourceChunk,
} from "@/lib/agent-ingest/types"
import { buildLintFixSystemPrompt, buildLintFixUserPrompt } from "./prompts"
import { LintFixTracker } from "./tracker"

export interface RunLintFixOpts {
  item: LintItem
  project: WikiProject
  llmConfig: LlmConfig
  signal?: AbortSignal
  /** Cumulative billed tokens budget (see agent-ingest runner doc). Default 60_000. */
  maxTokens?: number
  /** Hard cap on turns. Default 12. */
  maxTurns?: number
  /** Progress hook fired after each LLM turn. */
  onTurn?: (turnIndex: number, tokensSoFar: number) => void
}

export interface LintFixResult {
  itemId: string
  pagesUpdated: Array<{ slug: string; fromChunks: string[] }>
  pagesCreated: Array<{ slug: string; fromChunks: string[] }>
  pagesDeleted: Array<{ slug: string; reason: string }>
  gapsSurfaced: Array<{ topic: string; reason?: string; chunks?: string[] }>
  turnsUsed: number
  tokensSpent: number
  budgetExhausted: boolean
  reason: string
}

const DEFAULT_MAX_TOKENS = 60_000
const DEFAULT_MAX_TURNS = 12

export async function runLintFix(opts: RunLintFixOpts): Promise<LintFixResult> {
  assertSchemasUnique()  // catches duplicate tool registrations at startup

  const projectPath = normalizePath(opts.project.path)
  const signal = opts.signal ?? new AbortController().signal

  // Empty source-side context. read_outline / read_chunk / search_source
  // tools still load (they're in the global TOOLS array) but they'll
  // see an empty chunks Map and an empty outline — calls to them will
  // return chunk_not_found / empty results, which is the correct
  // signal to the LLM that "you're operating purely on the wiki here".
  const chunks = new Map<string, SourceChunk>()
  const outline: OutlineHeading[] = []
  const vectorIndex = { search: async () => [] }

  const wikiAccess = new FileSystemWikiAccess(projectPath)
  const tracker = new LintFixTracker(opts.item.id)

  const ctx: AgentContext = {
    chunks,
    outline,
    vectorIndex,
    project: opts.project,
    wikiAccess,
    tracker,
    llmConfig: opts.llmConfig,
    signal,
  }

  // Project purpose for the prompt — best-effort, same shape as
  // agent-ingest. Missing file = empty string, prompt still works.
  const purpose = await readFile(`${projectPath}/purpose.md`).catch(() => "")
  const systemPrompt = buildLintFixSystemPrompt(opts.item, purpose)
  const userPrompt = buildLintFixUserPrompt(opts.item)

  const llm = createAgentLlm(opts.llmConfig)
  let lastReportedTokens = 0
  const runResult = await runAgentLoop({
    llm,
    ctx,
    initialMessages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools: toolSchemasForLlm(),
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    onTurn: opts.onTurn
      ? (turn, i) => {
          lastReportedTokens += turn.usage.input_tokens + turn.usage.output_tokens
          opts.onTurn!(i, lastReportedTokens)
        }
      : undefined,
    // No checkpoint hook — lint-fix runs are small (≤12 turns) and
    // single-item; a crash mid-run just gets re-clicked. Persisting
    // mid-loop state would add complexity without proportional
    // recovery value.
  })

  return {
    itemId: opts.item.id,
    pagesUpdated: tracker.updatedPages(),
    pagesCreated: tracker.createdPages(),
    pagesDeleted: tracker.deletedPages(),
    gapsSurfaced: tracker.gaps(),
    turnsUsed: runResult.turnsUsed,
    tokensSpent: runResult.tokensSpent,
    budgetExhausted: runResult.stopReason === "max_tokens",
    reason: humaniseStopReason(runResult.stopReason),
  }
}

function humaniseStopReason(reason: string): string {
  switch (reason) {
    case "done_called":
      return "Agent called `done` — fix complete per its own report."
    case "no_tools_called":
      return "Agent replied with text only; loop ended without explicit done."
    case "max_turns":
      return "Hit the turn budget. The fix may be partial."
    case "max_tokens":
      return "Hit the cumulative-billed-tokens budget. The fix may be partial."
    case "aborted":
      return "Run was aborted by the user."
    default:
      return `Stopped: ${reason}`
  }
}
