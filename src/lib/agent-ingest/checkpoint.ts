/**
 * Agent-ingest checkpoint persistence.
 *
 * After every loop turn the runner saves a snapshot of {tracker
 * state + message history + run metadata} to disk under
 * `<project>/.llm-wiki/agent-checkpoints/<sourceHash>.json`. A crash,
 * network failure, or `await` boundary that gets cancelled mid-loop
 * leaves a usable resume point — the next runAgentIngest() call on
 * the same source picks up where the loop stopped.
 *
 * Invalidation: if the source file's bytes have changed since the
 * checkpoint was written (sourceHash mismatch), the checkpoint is
 * silently dropped — resuming against stale chunk ids would be a
 * subtle correctness bug (the LLM thinks chunk c5 was about Topic A
 * but post-edit it's now about Topic B). A fresh source warrants a
 * fresh agent.
 *
 * Cleanup: deleteCheckpoint() runs after a successful done — the
 * loop completed, the wiki is in its final state, no resume needed.
 * Failed / aborted / budget-exhausted runs LEAVE the checkpoint so
 * the user can retry without paying for already-completed work.
 *
 * File format choices:
 *
 *   - JSON, not msgpack — checkpoints are small (10s of KB typical),
 *     human-readable on inspection. The savings from binary encoding
 *     don't justify the debugging cost.
 *
 *   - One file per source (not one rolling file) — each source's
 *     resume is independent, no read-modify-write contention if a
 *     user kicks off agent ingests on multiple sources at once.
 *
 *   - `<sourceHash>.json` — the hash IS the cache key. Same source
 *     → same file → automatic dedup; edited source → different
 *     hash → orphan checkpoint that the cleanup pass in Phase F
 *     can sweep.
 */
import {
  createDirectory,
  fileExists,
  readFile,
  writeFileAtomic,
  deleteFile,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { AgentMessage } from "./llm-interface"
import type { CoverageSnapshot } from "./types"

const CHECKPOINT_VERSION = 1 as const
const CHECKPOINT_SUBDIR = ".llm-wiki/agent-checkpoints"

/**
 * Persistent shape of an in-flight agent-ingest run. Must round-trip
 * losslessly through JSON.parse(JSON.stringify(c)) — anything that
 * can't (Map, Date, undefined) gets normalised in saveCheckpoint /
 * loadCheckpoint.
 */
export interface AgentCheckpoint {
  /** Bump when the shape changes incompatibly. loadCheckpoint refuses
   *  to resume from a version it doesn't know — better a fresh run
   *  than a silent miscomparison. */
  version: typeof CHECKPOINT_VERSION
  /** When this snapshot was written. ISO string for human debugging. */
  savedAt: string
  /** Path the runner was processing. Used by the activity panel to
   *  show "resuming from X turns" on resume. */
  sourcePath: string
  /** SHA-256 of the source bytes at the time of checkpoint. The
   *  invariant that lets the runner know whether resume is safe. */
  sourceHash: string
  /** Coverage tracker state — see CoverageSnapshot. */
  tracker: CoverageSnapshot
  /** Full agent transcript so the runner can resume the loop mid-
   *  conversation without re-priming. Largest field in the file. */
  messages: AgentMessage[]
}

/* ────────────────────────────────────────────────
 * Path helpers
 * ────────────────────────────────────────────────*/

export function checkpointDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${CHECKPOINT_SUBDIR}`
}

export function checkpointPath(projectPath: string, sourceHash: string): string {
  return `${checkpointDir(projectPath)}/${sourceHash}.json`
}

/* ────────────────────────────────────────────────
 * Save / load / delete
 * ────────────────────────────────────────────────*/

/**
 * Save a checkpoint. Atomic on the underlying fs (write-temp +
 * rename) so a crash mid-write leaves the previous checkpoint intact
 * — never a half-baked file.
 *
 * Ensures the agent-checkpoints/ subdir exists first; `createDirectory`
 * is idempotent so re-creating on every save costs nothing.
 */
export async function saveCheckpoint(
  projectPath: string,
  checkpoint: Omit<AgentCheckpoint, "version" | "savedAt"> & {
    version?: typeof CHECKPOINT_VERSION
    savedAt?: string
  },
): Promise<void> {
  const dir = checkpointDir(projectPath)
  await createDirectory(dir).catch(() => {})  // already-exists is fine
  const full: AgentCheckpoint = {
    version: CHECKPOINT_VERSION,
    savedAt: new Date().toISOString(),
    ...checkpoint,
  }
  await writeFileAtomic(
    checkpointPath(projectPath, full.sourceHash),
    JSON.stringify(full, null, 2),
  )
}

/**
 * Load a checkpoint for `sourceHash` if one exists. Returns null
 * when missing, corrupt, version-mismatched, OR the source's hash
 * differs from what we have on hand (callers pass the freshly
 * computed hash to validate against).
 *
 * Never throws on "missing" / "stale" — the caller treats those as
 * "no resume, start fresh".
 */
export async function loadCheckpoint(
  projectPath: string,
  sourceHash: string,
): Promise<AgentCheckpoint | null> {
  const path = checkpointPath(projectPath, sourceHash)
  if (!(await fileExists(path))) return null
  let raw: string
  try {
    raw = await readFile(path)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(
      `[agent-ingest] corrupt checkpoint at ${path}, discarding: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
  if (!isCheckpoint(parsed)) {
    console.warn(
      `[agent-ingest] checkpoint at ${path} doesn't match expected shape, discarding`,
    )
    return null
  }
  if (parsed.version !== CHECKPOINT_VERSION) {
    console.warn(
      `[agent-ingest] checkpoint at ${path} is version ${parsed.version}; ` +
        `runner expects ${CHECKPOINT_VERSION}. Starting fresh.`,
    )
    return null
  }
  if (parsed.sourceHash !== sourceHash) {
    // Edge case — caller already keyed on sourceHash so they
    // SHOULDN'T see a hash mismatch here. Defensive log + null.
    console.warn(
      `[agent-ingest] checkpoint at ${path} reports sourceHash ${parsed.sourceHash}, ` +
        `but caller expected ${sourceHash}. Source likely re-edited; starting fresh.`,
    )
    return null
  }
  return parsed
}

/**
 * Delete a checkpoint. Called by the runner after a successful
 * done — the loop ended cleanly, no resume needed. Silently
 * succeeds when the file isn't there (deleting an already-deleted
 * checkpoint shouldn't surface as an error).
 */
export async function deleteCheckpoint(
  projectPath: string,
  sourceHash: string,
): Promise<void> {
  const path = checkpointPath(projectPath, sourceHash)
  if (!(await fileExists(path))) return
  try {
    await deleteFile(path)
  } catch (err) {
    console.warn(
      `[agent-ingest] failed to delete checkpoint at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/* ────────────────────────────────────────────────
 * Shape guard
 * ────────────────────────────────────────────────*/

function isCheckpoint(v: unknown): v is AgentCheckpoint {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return (
    typeof c.version === "number" &&
    typeof c.savedAt === "string" &&
    typeof c.sourcePath === "string" &&
    typeof c.sourceHash === "string" &&
    !!c.tracker &&
    typeof c.tracker === "object" &&
    Array.isArray(c.messages)
  )
}
