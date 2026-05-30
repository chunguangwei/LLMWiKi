/**
 * Public entry point for agent-driven source ingestion.
 *
 *   runAgentIngest(opts) →
 *     pre-process source → build runtime context (chunks, outline,
 *     vector index, wiki access, tracker) → wire LLM adapter →
 *     run the agent loop → collect tracker snapshot → return result
 *
 * This is what the sources view's "Try agent ingest (experimental)"
 * button will call in Phase D. Everything else in this folder is
 * implementation detail — don't import from `./runner` or
 * `./tools/...` outside the folder; the surface here is narrow on
 * purpose so the pipeline can be swapped without breaking callers.
 *
 * What `runAgentIngest` does (Phase C):
 *
 *   1. Read the source file from disk (via existing fs commands).
 *   2. preprocessSource() → chunks + outline + sourceHash.
 *   3. Build a KeywordVectorIndex over the chunks (BM25 over text;
 *      Phase F swaps in LanceDB-backed semantic search).
 *   4. Construct FileSystemWikiAccess for the project's wiki/.
 *   5. Collect existing pages once for the initial user prompt.
 *   6. Build system + initial user messages via `./prompts`.
 *   7. Create the LLM adapter via createAgentLlm() and run the loop.
 *   8. Map runner result + tracker snapshot → AgentIngestResult.
 *
 * What it does NOT do yet:
 *
 *   - Checkpoint persistence (Phase E — saves tracker snapshot
 *     between turns so a crash resumes from the last good state).
 *   - Verify pass (Phase E — one final LLM call comparing source
 *     outline to wiki pages written, surfacing gaps as review items).
 */
import { readFile } from "@/commands/fs"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { createAgentLlm } from "./agent-llm"
import {
  deleteCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "./checkpoint"
import type { AgentMessage } from "./llm-interface"
import { preprocessSource } from "./preprocess"
import { buildInitialUserPrompt, buildSystemPrompt } from "./prompts"
import { runAgentLoop } from "./runner"
import { toolSchemasForLlm, assertSchemasUnique } from "./tool-schemas"
import { InMemoryCoverageTracker } from "./tracker"
import type { AgentContext, AgentIngestResult } from "./types"
import { runVerifyPass } from "./verify"
import { KeywordVectorIndex } from "./vector-index"
import { FileSystemWikiAccess } from "./wiki-access"

export interface RunAgentIngestOpts {
  sourcePath: string
  project: WikiProject
  llmConfig: LlmConfig
  signal?: AbortSignal
  /**
   * Cumulative BILLED-tokens budget across the whole run. Each turn
   * re-sends the growing conversation, so this is "total tokens the
   * provider charges for", NOT "max conversation size". Defaults to
   * 200_000 — enough for a moderate source on a verbose model; bump
   * for long sources or chatty agents. See runner.ts for full notes.
   */
  maxTokens?: number
  /** Hard cap on turns. Defaults to 50. */
  maxTurns?: number
  /** Progress hook fired after each LLM turn. */
  onTurn?: (turnIndex: number, tokensSoFar: number) => void
}

export async function runAgentIngest(
  opts: RunAgentIngestOpts,
): Promise<AgentIngestResult> {
  assertSchemasUnique()  // cheap startup check; throws once, not mid-loop

  const projectPath = normalizePath(opts.project.path)
  const signal = opts.signal ?? new AbortController().signal

  // 1. Read source.
  const sourceContent = await readFile(opts.sourcePath)

  // 2. Pre-process.
  const preprocessed = await preprocessSource(sourceContent)

  // 3. Vector index over chunks.
  const vectorIndex = new KeywordVectorIndex(preprocessed.chunkList)

  // 4. Wiki access against this project.
  const wikiAccess = new FileSystemWikiAccess(projectPath)

  // 5. Existing pages for the initial prompt. (One listing — the
  //    agent can re-query mid-loop after writes.)
  const existingPages = await wikiAccess.listPages()

  // 6. Coverage tracker. Resume from a checkpoint if one is on
  //    disk for this exact sourceHash — sourceHash invalidation
  //    handled inside loadCheckpoint (re-edited source returns
  //    null and we start fresh).
  //
  //    isCheckpoint() in checkpoint.ts is a SHALLOW shape guard —
  //    it doesn't verify the tracker snapshot's inner shape. A
  //    malformed `tracker: {}` (e.g. a future version's checkpoint
  //    that loadCheckpoint failed to filter, or a hand-edited file)
  //    would crash fromSnapshot here. Wrap defensively: log + start
  //    fresh on throw. We also drop the resumed message history in
  //    that case — the tracker is the source of truth for "what's
  //    been done", and resuming the transcript without that context
  //    just makes the LLM redo work it already paid for.
  const checkpoint = await loadCheckpoint(projectPath, preprocessed.sourceHash)
  let tracker: InMemoryCoverageTracker
  let resumedFromCheckpoint = false
  if (checkpoint) {
    try {
      tracker = InMemoryCoverageTracker.fromSnapshot(checkpoint.tracker)
      resumedFromCheckpoint = true
    } catch (err) {
      console.warn(
        `[agent-ingest] checkpoint tracker malformed (${
          err instanceof Error ? err.message : String(err)
        }); starting fresh`,
      )
      tracker = new InMemoryCoverageTracker(
        opts.sourcePath,
        preprocessed.sourceHash,
        preprocessed.chunkList.length,
      )
    }
  } else {
    tracker = new InMemoryCoverageTracker(
      opts.sourcePath,
      preprocessed.sourceHash,
      preprocessed.chunkList.length,
    )
  }

  // 7. AgentContext bag.
  const ctx: AgentContext = {
    chunks: preprocessed.chunks,
    outline: preprocessed.outline,
    vectorIndex,
    project: opts.project,
    wikiAccess,
    tracker,
    llmConfig: opts.llmConfig,
    signal,
  }

  // 8. Prompts. purpose / schema loading is best-effort — missing
  //    files leave the prompt with its baseline guidance.
  const { purpose, schema } = await loadProjectContext(projectPath).catch(() => ({
    purpose: "",
    schema: "",
  }))
  const systemPrompt = buildSystemPrompt({ purpose, schema })
  const userPrompt = buildInitialUserPrompt({
    sourcePath: opts.sourcePath,
    outline: preprocessed.outline,
    existingPages,
  })

  // 9. LLM + loop. Use the checkpoint's message history if resuming
  //    so the model picks up mid-conversation (it sees its own
  //    prior tool_use blocks + the tool_results). Otherwise start
  //    with system + initial user prompts.
  const initialMessages: AgentMessage[] = resumedFromCheckpoint && checkpoint
    ? checkpoint.messages
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]
  const llm = createAgentLlm(opts.llmConfig)
  let lastReportedTokens = 0
  const runResult = await runAgentLoop({
    llm,
    ctx,
    initialMessages,
    tools: toolSchemasForLlm(),
    maxTurns: opts.maxTurns,
    maxTokens: opts.maxTokens,
    onTurn: opts.onTurn
      ? (turn, i) => {
          lastReportedTokens += turn.usage.input_tokens + turn.usage.output_tokens
          opts.onTurn!(i, lastReportedTokens)
        }
      : undefined,
    onCheckpoint: ({ messages }) => {
      // Fire-and-forget: persist the checkpoint without blocking the
      // loop's next LLM call. Errors are logged but never bubble up
      // — checkpointing is best-effort; a write failure shouldn't
      // kill a run that's otherwise making progress.
      saveCheckpoint(projectPath, {
        sourcePath: opts.sourcePath,
        sourceHash: preprocessed.sourceHash,
        tracker: tracker.snapshot(),
        messages,
      }).catch((err) => {
        console.warn(
          `[agent-ingest] checkpoint save failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    },
  })

  // Verify pass — independent second opinion that the wiki pages
  // actually cover the source's outline. Adds gaps to the tracker
  // for any heading the verifier flags. Skipped on abort / budget /
  // empty outline; see verify.ts skip rules.
  const verifyResult = await runVerifyPass({
    llm,
    ctx,
    sourcePath: opts.sourcePath,
    outline: preprocessed.outline,
    pagesCreated: tracker.createdPages(),
    pagesUpdated: tracker.updatedPages(),
    stopReason: runResult.stopReason,
    signal,
  })

  // Cleanup: a successful done means the run completed; the
  // checkpoint becomes garbage. Anything else (max_tokens,
  // max_turns, aborted, error) leaves the file in place so the
  // next call resumes. NOTE: cleanup runs AFTER verify so the
  // verifier's gaps land in the snapshot one last time (in case
  // the user inspects the file).
  let finalCheckpointError: string | null = null
  if (runResult.stopReason === "done_called") {
    await deleteCheckpoint(projectPath, preprocessed.sourceHash).catch(() => {})
  } else if (verifyResult.ran) {
    // Run was partial AND verify added gaps; persist the latest
    // tracker state so the next resume starts from the same gap
    // list. AWAITED (not fire-and-forget like mid-loop saves) —
    // this is the only checkpoint the user gets for a partial run;
    // a silent failure here means resume won't work even though
    // the user already paid for the LLM calls. Errors propagate to
    // AgentIngestResult.finalCheckpointError so the activity panel
    // can surface them.
    try {
      await saveCheckpoint(projectPath, {
        sourcePath: opts.sourcePath,
        sourceHash: preprocessed.sourceHash,
        tracker: tracker.snapshot(),
        messages: runResult.finalMessages,
      })
    } catch (err) {
      finalCheckpointError = err instanceof Error ? err.message : String(err)
      console.warn(
        `[agent-ingest] final checkpoint save failed; resume will not work: ${finalCheckpointError}`,
      )
    }
  }

  // 10. Aggregate result.
  return {
    pagesCreated: tracker.createdPages(),
    pagesUpdated: tracker.updatedPages(),
    reviewItemsCreated: tracker.gaps(),
    coverage: tracker.coveragePercent(),
    turnsUsed: runResult.turnsUsed,
    tokensSpent: runResult.tokensSpent,
    budgetExhausted: runResult.stopReason === "max_tokens",
    reason: humaniseStopReason(runResult.stopReason),
    finalCheckpointError,
  }
}

/**
 * Best-effort load of purpose.md + schema.md from the project root.
 * Missing files return empty strings — the system prompt still
 * ships its baseline framing without the project additions.
 */
async function loadProjectContext(
  projectPath: string,
): Promise<{ purpose: string; schema: string }> {
  const purpose = await readFile(`${projectPath}/purpose.md`).catch(() => "")
  const schema = await readFile(`${projectPath}/schema.md`).catch(() => "")
  return { purpose, schema }
}

function humaniseStopReason(reason: string): string {
  switch (reason) {
    case "done_called":
      return "Agent called `done` — extraction complete per its own report."
    case "no_tools_called":
      return "Agent replied with text only; loop ended without explicit done."
    case "max_turns":
      return "Hit the turn budget. Increase maxTurns or split the source."
    case "max_tokens":
      return (
        "Hit the cumulative-billed-tokens budget across turns. " +
        "Increase maxTokens, use a cheaper model, or split the source."
      )
    case "aborted":
      return "Run was aborted by the user."
    default:
      return `Stopped: ${reason}`
  }
}

export type { AgentIngestResult } from "./types"
