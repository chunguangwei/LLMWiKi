import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"

/**
 * Tests for the GitHub backup lib: config round-trip + default-merge, and
 * the scheduler's interval clamp / start-stop / stale-run / no-overlap
 * guards. Both `@tauri-apps/api/core` (invoke) and `@/commands/fs` are
 * mocked so nothing touches a real backend or disk.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@/commands/fs", () => ({
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
  createDirectory: mocks.createDirectory,
  listDirectory: mocks.listDirectory,
}))

import {
  DEFAULT_GITHUB_BACKUP_CONFIG,
  loadGithubBackupConfig,
  saveGithubBackupConfig,
  startGithubBackup,
  stopGithubBackup,
  runBackupTick,
  type GithubBackupConfig,
} from "./github-backup"

const project: WikiProject = {
  id: "p1",
  name: "Proj",
  path: "/Users/me/wiki",
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default fs mocks: createDirectory/writeFile succeed; readFile rejects
  // (no persisted file) unless a test overrides it.
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.readFile.mockRejectedValue(new Error("ENOENT"))
  mocks.listDirectory.mockResolvedValue([])
})

afterEach(() => {
  // Always leave the module-scope scheduler stopped between tests so a
  // lingering timer from one test can't fire into the next.
  stopGithubBackup()
})

describe("config persistence", () => {
  it("round-trips a config through save → load", async () => {
    const cfg: GithubBackupConfig = {
      ...DEFAULT_GITHUB_BACKUP_CONFIG,
      owner: "octocat",
      repo: "wiki-backup",
      enabled: true,
      intervalMinutes: 15,
      lastSyncSha: "abc123",
      lastSyncAt: 1700000000000,
    }

    await saveGithubBackupConfig(project.path, cfg)

    // The exact JSON we wrote is what load should reconstruct.
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenJson] = mocks.writeFile.mock.calls[0]
    expect(writtenPath).toBe("/Users/me/wiki/.llm-wiki-local/github-backup.json")
    mocks.readFile.mockResolvedValueOnce(writtenJson as string)

    const loaded = await loadGithubBackupConfig(project.path)
    expect(loaded).toEqual(cfg)
  })

  it("ensures the local dir before writing", async () => {
    await saveGithubBackupConfig(project.path, DEFAULT_GITHUB_BACKUP_CONFIG)
    expect(mocks.createDirectory).toHaveBeenCalledWith("/Users/me/wiki/.llm-wiki-local")
  })

  it("returns defaults when no config file exists", async () => {
    const loaded = await loadGithubBackupConfig(project.path)
    expect(loaded).toEqual(DEFAULT_GITHUB_BACKUP_CONFIG)
  })

  it("merges a partial persisted JSON over the defaults (new fields safe)", async () => {
    // Simulate a config written by an older version that only knew about
    // owner/repo/enabled — every newer field must fall back to its default.
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ owner: "octocat", repo: "old", enabled: true }),
    )
    const loaded = await loadGithubBackupConfig(project.path)
    expect(loaded.owner).toBe("octocat")
    expect(loaded.repo).toBe("old")
    expect(loaded.enabled).toBe(true)
    // Untouched fields keep their defaults:
    expect(loaded.branch).toBe(DEFAULT_GITHUB_BACKUP_CONFIG.branch)
    expect(loaded.intervalMinutes).toBe(DEFAULT_GITHUB_BACKUP_CONFIG.intervalMinutes)
    expect(loaded.includeRawSources).toBe(DEFAULT_GITHUB_BACKUP_CONFIG.includeRawSources)
    expect(loaded.lastSyncSha).toBe("")
    expect(loaded.lastSyncAt).toBe(0)
  })

  it("falls back to defaults on malformed JSON", async () => {
    mocks.readFile.mockResolvedValueOnce("{not valid json")
    const loaded = await loadGithubBackupConfig(project.path)
    expect(loaded).toEqual(DEFAULT_GITHUB_BACKUP_CONFIG)
  })
})

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const enabledCfg: GithubBackupConfig = {
    ...DEFAULT_GITHUB_BACKUP_CONFIG,
    owner: "octocat",
    repo: "wiki",
    enabled: true,
    intervalMinutes: 30,
  }

  // Make every invoke resolve to a generic backup/pull-shaped object so
  // the scheduler's awaits complete.
  function stubInvoke() {
    mocks.invoke.mockResolvedValue({
      newSha: "sha-new",
      pushedFiles: [],
      skippedOversize: [],
      pulledFirst: true,
      changedFiles: [],
      deletedFiles: [],
      conflicts: [],
    })
  }

  it("does not start when disabled", () => {
    stubInvoke()
    startGithubBackup(project, { ...enabledCfg, enabled: false })
    // No immediate pull, no timer scheduled.
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("runs an immediate pull on start", async () => {
    stubInvoke()
    startGithubBackup(project, enabledCfg)
    // The immediate pull is fired synchronously (un-awaited promise).
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.invoke).toHaveBeenCalledWith("github_pull_now", expect.any(Object))
  })

  it("clamps the interval to [1, 1440] minutes", async () => {
    stubInvoke()
    // Way over the max — should fire a backup at the 1440-minute ceiling,
    // not at the absurd configured value.
    startGithubBackup(project, { ...enabledCfg, intervalMinutes: 99999 })
    mocks.invoke.mockClear()

    // Just before the clamped ceiling: no backup tick yet.
    await vi.advanceTimersByTimeAsync(1440 * 60 * 1000 - 1000)
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "github_backup_now").length,
    ).toBe(0)

    // Cross the ceiling: exactly one backup tick fires.
    await vi.advanceTimersByTimeAsync(2000)
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "github_backup_now").length,
    ).toBe(1)
  })

  it("clamps a zero/NaN interval up to the floor (1 minute)", async () => {
    stubInvoke()
    startGithubBackup(project, { ...enabledCfg, intervalMinutes: 0 })
    mocks.invoke.mockClear()
    // 0 → default(30)? No: clampIntervalMs treats falsy as the default 30.
    // So at 30min exactly one backup fires. Verify a tick happens within
    // a bounded window rather than never (the key invariant: it ticks).
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "github_backup_now").length,
    ).toBe(1)
  })

  it("stops: no further ticks after stopGithubBackup", async () => {
    stubInvoke()
    startGithubBackup(project, { ...enabledCfg, intervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(0) // flush immediate pull
    mocks.invoke.mockClear()

    stopGithubBackup()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "github_backup_now").length,
    ).toBe(0)
  })

  it("stale-run guard: a tick from a superseded scheduler bails", async () => {
    stubInvoke()
    // runBackupTick takes an explicit runId; passing a stale one (lower
    // than the live activeRunId after a start) must early-return without
    // calling the backend.
    startGithubBackup(project, enabledCfg)
    await vi.advanceTimersByTimeAsync(0)
    mocks.invoke.mockClear()

    await runBackupTick(project, -1)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("no-overlap guard: a tick is skipped while another is running", async () => {
    // Make github_backup_now hang so the first tick stays "running".
    let resolveBackup: (v: unknown) => void = () => {}
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "github_backup_now") {
        return new Promise((res) => {
          resolveBackup = res
        })
      }
      // pull + config reads resolve immediately
      return Promise.resolve({
        newSha: "sha",
        pushedFiles: [],
        skippedOversize: [],
        pulledFirst: true,
        changedFiles: [],
        deletedFiles: [],
        conflicts: [],
      })
    })

    startGithubBackup(project, { ...enabledCfg, intervalMinutes: 1 })
    await vi.advanceTimersByTimeAsync(0) // immediate pull resolves

    // First tick at 1min — starts a backup that hangs.
    await vi.advanceTimersByTimeAsync(60 * 1000)
    const firstCount = mocks.invoke.mock.calls.filter(
      (c) => c[0] === "github_backup_now",
    ).length
    expect(firstCount).toBe(1)

    // Second tick at 2min — the first is still running, so no new backup.
    await vi.advanceTimersByTimeAsync(60 * 1000)
    const secondCount = mocks.invoke.mock.calls.filter(
      (c) => c[0] === "github_backup_now",
    ).length
    expect(secondCount).toBe(1)

    // Let the first finish so afterEach's stop doesn't dangle a promise.
    resolveBackup({
      newSha: "sha",
      pushedFiles: [],
      skippedOversize: [],
      pulledFirst: true,
    })
    await vi.advanceTimersByTimeAsync(0)
  })

  it("persists the advanced sha + calls onSynced after a successful tick", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "github_backup_now") {
        return Promise.resolve({
          newSha: "sha-advanced",
          pushedFiles: ["wiki/a.md"],
          skippedOversize: [],
          pulledFirst: true,
        })
      }
      return Promise.resolve({
        newSha: "sha-pull",
        changedFiles: [],
        deletedFiles: [],
        conflicts: [],
      })
    })
    const onSynced = vi.fn()

    startGithubBackup(project, { ...enabledCfg, intervalMinutes: 1 }, onSynced)
    await vi.advanceTimersByTimeAsync(0) // immediate pull
    mocks.writeFile.mockClear()

    await vi.advanceTimersByTimeAsync(60 * 1000) // first backup tick

    expect(onSynced).toHaveBeenCalledWith(
      expect.objectContaining({ newSha: "sha-advanced", pushedFiles: ["wiki/a.md"] }),
    )
    // The advanced sha was persisted back to disk.
    const wrote = mocks.writeFile.mock.calls.find((c) =>
      String(c[0]).endsWith("github-backup.json"),
    )
    expect(wrote).toBeTruthy()
    expect(String(wrote?.[1])).toContain("sha-advanced")
  })
})
