/**
 * Agent-ingest public entry point.
 *
 * Production callers go through `runAgentIngest()` — same signature
 * shape as the classic ingest entry point so the sources view can
 * route to either pipeline based on the settings toggle (Phase D).
 *
 * Everything else in this folder is implementation detail. Don't
 * import from `./tools/...` or `./tracker` directly outside the
 * folder — the surface here is intentionally narrow so the agent
 * pipeline can be rewritten without breaking callers.
 *
 * Status: **skeleton**. `runAgentIngest` is a stub that throws
 * NOT_IMPLEMENTED until Phase B (runner) lands. Tests in
 * `tools/*.test.ts` and `tracker.test.ts` run against the
 * primitives directly without needing the runner.
 */
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import type { AgentIngestResult } from "./types"

export interface RunAgentIngestOpts {
  sourcePath: string
  project: WikiProject
  llmConfig: LlmConfig
  signal?: AbortSignal
  /** Token budget across all turns. Defaults to 200_000. */
  maxTokens?: number
  /** Hard cap on turns. Defaults to 50. */
  maxTurns?: number
}

export async function runAgentIngest(
  _opts: RunAgentIngestOpts,
): Promise<AgentIngestResult> {
  throw new Error("[agent-ingest] runAgentIngest not implemented (Phase B)")
}

export type { AgentIngestResult } from "./types"
