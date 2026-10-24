import { beforeEach, describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test-helpers/deferred"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"

const collectWikiMock = vi.hoisted(() => vi.fn())
const streamChatMock = vi.hoisted(() => vi.fn())
const fsMocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), fileExists: vi.fn() }))

vi.mock("@/lib/wiki-research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki-research")>()
  return { ...actual, collectWikiResearchSources: collectWikiMock }
})
vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  fileExists: fsMocks.fileExists,
}))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn().mockResolvedValue(undefined) }))

import { queueResearchBatch } from "./deep-research"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"

const internalSource = {
  title: "Alpha",
  url: "wiki/concepts/alpha.md",
  wikiPath: "wiki/concepts/alpha.md",
  snippet: "Primary internal evidence",
  source: "Wiki",
}

function pendingReview(): ReviewItem {
  return {
    id: "review-internal",
    type: "contradiction",
    title: "Conflicting statements",
    description: "Resolve the conflicting claims",
    affectedPages: ["wiki/concepts/alpha.md"],
    options: [],
    resolved: false,
    createdAt: 1,
  }
}

async function runResearch(answer: string) {
  streamChatMock.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(answer)
    callbacks.onDone()
  })
  queueResearchBatch(
    "/project",
    [{ topic: "Resolve the contradiction", sourceReviewId: "review-internal" }],
    { maxContextSize: 128_000 } as LlmConfig,
    { provider: "none", apiKey: "", deepResearchSource: "wiki" },
  )
  await new Promise((resolve) => setTimeout(resolve, 75))
  await waitFor(() => {
    const status = useResearchStore.getState().tasks[0]?.status
    return status === "done" || status === "error"
  })
  return useResearchStore.getState().tasks[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.setState({
    project: { id: "project", name: "Project", path: "/project" },
    embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
  })
  useResearchStore.setState({ tasks: [], panelOpen: false, maxConcurrent: 1 })
  useReviewStore.setState({ items: [pendingReview()] })
  collectWikiMock.mockResolvedValue({
    results: [internalSource],
    errors: [],
    candidateCount: 1,
    rejectedCount: 0,
  })
  fsMocks.readFile.mockResolvedValue("")
  fsMocks.writeFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(false)
})

describe("internal Wiki research queue", () => {
  it("leaves Review pending and does not write a resolution page for UNRESOLVED", async () => {
    const task = await runResearch(
      "RESOLUTION: UNRESOLVED\n\nThe internal sources materially disagree, so the original contradiction remains unresolved. [1] The available evidence is useful but does not establish which claim is correct.",
    )

    expect(task.status).toBe("done")
    expect(task.resolution).toBe("unresolved")
    expect(task.savedPath).toBeNull()
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
    expect(collectWikiMock).toHaveBeenCalledWith(expect.objectContaining({
      affectedPages: ["wiki/concepts/alpha.md"],
    }))
  })

  it("saves valid research and resolves Review only after the write succeeds", async () => {
    const task = await runResearch(
      "RESOLUTION: RESOLVED\n\nThe primary source resolves the contradiction by distinguishing the two versions and their effective dates. [1] This conclusion is supported by the affected page and explains why the earlier statement no longer applies to the current release.",
    )

    expect(task.status).toBe("done")
    expect(task.resolution).toBe("resolved")
    expect(task.savedPath).toMatch(/^wiki\/queries\//)
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("/project/wiki/queries/"),
      expect.stringContaining("[[wiki/concepts/alpha.md|Alpha]]"),
    )
    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: `Research saved: ${task.savedPath}`,
    })
    expect(fsMocks.readFile).not.toHaveBeenCalledWith("/project/wiki/index.md")
  })

  it("rejects output without an explicit resolution", async () => {
    const task = await runResearch("The model produced a synthesis without the required decision marker. [1]")

    expect(task.status).toBe("error")
    expect(task.error).toContain("RESOLUTION")
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })
})
