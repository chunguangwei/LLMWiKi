/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, it, expect, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { useWikiStore } from "@/stores/wiki-store"
import i18n from "@/i18n"
import { SourcesView } from "./sources-view"

const mocks = vi.hoisted(() => ({
  list: vi.fn(), identities: vi.fn(), enqueue: vi.fn(),
}))
vi.mock("@/commands/fs", async (original) => ({
  ...await original<typeof import("@/commands/fs")>(), listDirectory: mocks.list,
}))
vi.mock("@/lib/ingest-cache", () => ({ listIngestedSourceIdentities: mocks.identities }))
vi.mock("@/lib/source-lifecycle", async (original) => ({
  ...await original<typeof import("@/lib/source-lifecycle")>(), enqueueSourceIngest: mocks.enqueue,
}))
vi.mock("@/hooks/use-native-file-drop", () => ({ useNativeFileDrop: () => false }))
vi.mock("@/lib/ingest-queue", () => ({
  getQueue: () => [], subscribeIngestQueue: () => () => {},
}))
const project = (name: string) => ({ id: name, name, path: "/" + name })
const tree = (name: string) => [{ name: name + ".md", path: "/" + name + "/raw/sources/" + name + ".md", is_dir: false }]
let root: Root
let host: HTMLDivElement
const settle = async (fn: () => void) => act(async () => { fn(); await flushMicrotasks(20) })
const batch = () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Ingest pending"))!
beforeEach(async () => {
  vi.resetAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage("en")
  useWikiStore.setState({
    project: project("A"), activeView: "sources", dataVersion: 0,
    llmConfig: { ...useWikiStore.getState().llmConfig, provider: "openai", apiKey: "key" },
    projectLlmOverride: { enabled: false, presetId: "", model: "" },
    taskModelRouting: { chatPresetId: "", ingestPresetId: "" },
  })
  mocks.list.mockResolvedValue(tree("A"))
  mocks.identities.mockResolvedValue([])
  mocks.enqueue.mockResolvedValue(["task"])
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it("keeps batch disabled until the identities have loaded", async () => {
  const cache = createDeferred<string[]>()
  mocks.identities.mockReturnValue(cache.promise)
  await settle(() => root.render(<SourcesView />))
  expect(batch().disabled).toBe(true)
  await settle(() => cache.resolve(["A.md"]))
  expect(batch().disabled).toBe(true)
  expect(batch().textContent).toContain("(0)")
})
it("disables batch and shows a cache error instead of treating every source as new", async () => {
  mocks.identities.mockRejectedValue(new Error("cache unreadable"))
  await settle(() => root.render(<SourcesView />))
  expect(batch().disabled).toBe(true)
  expect(host.textContent).toContain("cache unreadable")
})
it("discards old project directory responses before allowing a new batch", async () => {
  const old = createDeferred<ReturnType<typeof tree>>()
  const next = createDeferred<ReturnType<typeof tree>>()
  mocks.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await settle(() => root.render(<SourcesView />))
  await settle(() => useWikiStore.setState({ project: project("B") }))
  await settle(() => next.resolve(tree("B")))
  await settle(() => old.resolve(tree("A")))
  await settle(() => batch().click())
  expect(mocks.enqueue).toHaveBeenCalledWith(project("B"), ["/B/raw/sources/B.md"], expect.anything())
  expect(host.textContent).not.toContain("A.md")
})
it("immediately removes a previously loaded project's actionable sources on switch", async () => {
  await settle(() => root.render(<SourcesView />))
  mocks.list.mockReturnValue(createDeferred().promise)
  await settle(() => useWikiStore.setState({ project: project("B") }))
  expect(batch().disabled).toBe(true)
  expect(host.textContent).not.toContain("A.md")
})

it("preserves the visible tree during a same-project refresh but disables ingest until ready", async () => {
  await settle(() => root.render(<SourcesView />))
  const next = createDeferred<ReturnType<typeof tree>>()
  mocks.list.mockReturnValue(next.promise)
  await settle(() => useWikiStore.setState({ dataVersion: 1 }))
  expect(host.textContent).toContain("A.md")
  expect(batch().disabled).toBe(true)
  await settle(() => next.resolve(tree("A")))
  expect(batch().disabled).toBe(false)
})

it("can retry a cache error without forcing a file rescan or switching projects", async () => {
  mocks.identities.mockRejectedValueOnce(new Error("cache unreadable")).mockResolvedValue([])
  await settle(() => root.render(<SourcesView />))
  await settle(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click())
  expect(batch().disabled).toBe(false)
  expect(host.textContent).not.toContain("cache unreadable")
})
