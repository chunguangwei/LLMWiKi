import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  checkpointPath,
  checkpointDir,
  type AgentCheckpoint,
} from "./checkpoint"

/* ────────── in-memory fs mock (shared with wiki-access + e2e) ────────── */
type FsState = { files: Map<string, string>; dirs: Set<string> }
let fs: FsState = { files: new Map(), dirs: new Set() }
function resetFs() {
  fs = { files: new Map(), dirs: new Set() }
}

vi.mock("@/commands/fs", () => ({
  createDirectory: async (p: string) => {
    fs.dirs.add(p)
  },
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: file not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
  deleteFile: async (p: string) => {
    fs.files.delete(p)
  },
}))

beforeEach(() => {
  resetFs()
})

const PROJECT = "/p"
const HASH = "deadbeef1234"

function baseCheckpoint(): Omit<AgentCheckpoint, "version" | "savedAt"> {
  return {
    sourcePath: "/p/raw/sources/foo.md",
    sourceHash: HASH,
    tracker: {
      sourcePath: "/p/raw/sources/foo.md",
      sourceHash: HASH,
      totalChunks: 5,
      coveredChunks: ["c0", "c1"],
      pagesCreated: [{ slug: "concepts/x", fromChunks: ["c0"] }],
      pagesUpdated: [],
      gaps: [],
      turnsUsed: 4,
      tokensSpent: 12_345,
      completed: false,
      budgetExhausted: false,
    },
    messages: [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Process the source." },
    ],
  }
}

/* ────────────────────────────────────────────────
 * Path helpers
 * ────────────────────────────────────────────────*/

describe("checkpoint paths", () => {
  it("checkpointDir lives under .llm-wiki/agent-checkpoints/", () => {
    expect(checkpointDir(PROJECT)).toBe("/p/.llm-wiki/agent-checkpoints")
  })

  it("checkpointPath uses <sourceHash>.json", () => {
    expect(checkpointPath(PROJECT, HASH)).toBe(
      "/p/.llm-wiki/agent-checkpoints/deadbeef1234.json",
    )
  })

  it("normalises Windows-style path separators in projectPath", () => {
    expect(checkpointPath("C:\\projects\\wiki", HASH)).toMatch(
      /agent-checkpoints\/deadbeef1234\.json$/,
    )
  })
})

/* ────────────────────────────────────────────────
 * saveCheckpoint
 * ────────────────────────────────────────────────*/

describe("saveCheckpoint", () => {
  it("writes the file to <projectPath>/.llm-wiki/agent-checkpoints/<hash>.json", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    expect(fs.files.has(checkpointPath(PROJECT, HASH))).toBe(true)
  })

  it("ensures the agent-checkpoints/ directory is created (idempotent on existing)", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    expect(fs.dirs.has(checkpointDir(PROJECT))).toBe(true)
    await saveCheckpoint(PROJECT, baseCheckpoint())  // again — should not throw
  })

  it("stamps version + savedAt (ISO) onto the persisted payload", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    const raw = fs.files.get(checkpointPath(PROJECT, HASH))!
    const parsed = JSON.parse(raw) as AgentCheckpoint
    expect(parsed.version).toBe(1)
    expect(parsed.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("round-trips losslessly through JSON for the structured fields", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    const raw = fs.files.get(checkpointPath(PROJECT, HASH))!
    const parsed = JSON.parse(raw) as AgentCheckpoint
    expect(parsed.sourcePath).toBe("/p/raw/sources/foo.md")
    expect(parsed.sourceHash).toBe(HASH)
    expect(parsed.tracker.totalChunks).toBe(5)
    expect(parsed.tracker.coveredChunks).toEqual(["c0", "c1"])
    expect(parsed.tracker.pagesCreated).toEqual([
      { slug: "concepts/x", fromChunks: ["c0"] },
    ])
    expect(parsed.messages).toHaveLength(2)
  })
})

/* ────────────────────────────────────────────────
 * loadCheckpoint
 * ────────────────────────────────────────────────*/

describe("loadCheckpoint", () => {
  it("returns null when no checkpoint file exists", async () => {
    const c = await loadCheckpoint(PROJECT, HASH)
    expect(c).toBeNull()
  })

  it("returns the saved checkpoint when hash matches", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    const loaded = await loadCheckpoint(PROJECT, HASH)
    expect(loaded).not.toBeNull()
    expect(loaded!.tracker.turnsUsed).toBe(4)
    expect(loaded!.messages).toHaveLength(2)
  })

  it("returns null on hash mismatch (source re-edited)", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    const loaded = await loadCheckpoint(PROJECT, "differenthash")
    // Mismatch surfaces as no file at that key — fresh start.
    expect(loaded).toBeNull()
  })

  it("returns null on corrupt JSON (logs but doesn't throw)", async () => {
    const path = checkpointPath(PROJECT, HASH)
    fs.files.set(path, "{not valid json")
    const loaded = await loadCheckpoint(PROJECT, HASH)
    expect(loaded).toBeNull()
  })

  it("returns null when shape doesn't match (missing required fields)", async () => {
    const path = checkpointPath(PROJECT, HASH)
    fs.files.set(path, JSON.stringify({ version: 1, savedAt: "x" }))
    const loaded = await loadCheckpoint(PROJECT, HASH)
    expect(loaded).toBeNull()
  })

  it("returns null on version mismatch", async () => {
    const path = checkpointPath(PROJECT, HASH)
    fs.files.set(
      path,
      JSON.stringify({
        ...baseCheckpoint(),
        version: 999,
        savedAt: new Date().toISOString(),
      }),
    )
    const loaded = await loadCheckpoint(PROJECT, HASH)
    expect(loaded).toBeNull()
  })

  it("returns null when the stored hash differs from the requested hash (manual file copy)", async () => {
    // Defensive case: someone copies a checkpoint into the wrong
    // filename. saveCheckpoint always uses the right name, but
    // loadCheckpoint is the second line of defence.
    const path = checkpointPath(PROJECT, HASH)
    fs.files.set(
      path,
      JSON.stringify({
        ...baseCheckpoint(),
        version: 1,
        savedAt: new Date().toISOString(),
        sourceHash: "wrong-hash-inside",
      }),
    )
    const loaded = await loadCheckpoint(PROJECT, HASH)
    expect(loaded).toBeNull()
  })
})

/* ────────────────────────────────────────────────
 * deleteCheckpoint
 * ────────────────────────────────────────────────*/

describe("deleteCheckpoint", () => {
  it("removes the file when it exists", async () => {
    await saveCheckpoint(PROJECT, baseCheckpoint())
    expect(fs.files.has(checkpointPath(PROJECT, HASH))).toBe(true)
    await deleteCheckpoint(PROJECT, HASH)
    expect(fs.files.has(checkpointPath(PROJECT, HASH))).toBe(false)
  })

  it("succeeds silently when the file doesn't exist", async () => {
    // Should NOT throw.
    await expect(deleteCheckpoint(PROJECT, "ghost")).resolves.toBeUndefined()
  })
})
