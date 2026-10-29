import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { importSourceUrls } from "./url-source-import"
import { flushMicrotasks } from "@/test-helpers/deferred"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), write: vi.fn(), enqueue: vi.fn() }))
vi.mock("@/lib/tauri-fetch", () => ({ getHttpFetch: async () => mocks.fetch }))
vi.mock("@/commands/fs", () => ({ writeFile: mocks.write }))
vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: mocks.enqueue,
  getUniqueDestPath: async (root: string, file: string) => root + "/" + file,
}))
const project = { id: "p", name: "Project", path: "/project" }
const config = { provider: "openai", apiKey: "key" } as never
beforeEach(() => { vi.resetAllMocks(); mocks.enqueue.mockResolvedValue(["task"]) })
afterEach(() => { vi.useRealTimers() })

it("times out a stalled body, cancels it, and imports the next URL", async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel })
  mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(new Response("good"))
  let result: Awaited<ReturnType<typeof importSourceUrls>> | undefined
  const promise = importSourceUrls(project, ["https://example.com/stalled", "https://example.com/good"], config)
    .then(value => { result = value })
  await flushMicrotasks(20)
  await vi.advanceTimersByTimeAsync(60_001)
  expect(result?.[0].error).toMatch(/timed out/i)
  expect(result?.[1].path).toBe("/project/raw/sources/good.txt")
  expect(cancel).toHaveBeenCalled()
  expect(mocks.write).toHaveBeenCalledTimes(1)
  await promise
  expect(vi.getTimerCount()).toBe(0)
})

it.each([undefined, "1"])("stops reading an oversized body with Content-Length %s before buffering it all", async (length) => {
  let chunksRead = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead++
      if (chunksRead <= 6) controller.enqueue(new Uint8Array(1024 * 1024))
      else controller.close()
    }, cancel,
  }, { highWaterMark: 0 })
  const headers: Record<string, string> = { "content-type": "text/plain" }
  if (length) headers["content-length"] = length
  mocks.fetch.mockResolvedValue(new Response(body, { headers }))
  const result = await importSourceUrls(project, ["https://example.com/large"], config, { maxFileSizeMb: 1 } as never)
  expect(result[0].error).toMatch(/size limit/)
  expect(chunksRead).toBeLessThanOrEqual(2)
  expect(cancel).toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
})

it("rejects unsupported content without pulling its body", async () => {
  let reads = 0
  const cancel = vi.fn()
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
    pull(c) { reads++; c.enqueue(new Uint8Array([1])); c.close() }, cancel,
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/octet-stream" } }))
  const result = await importSourceUrls(project, ["https://example.com/file"], config)
  expect(result[0].error).toMatch(/Unsupported content type/)
  expect(reads).toBe(0)
  expect(cancel).toHaveBeenCalled()
})

it("preserves UTF-8 split across chunks and enqueues a successful source", async () => {
  const bytes = new TextEncoder().encode("中文资料")
  const body = new ReadableStream({
    start(c) { c.enqueue(bytes.slice(0, 2)); c.enqueue(bytes.slice(2)); c.close() },
  })
  mocks.fetch.mockResolvedValue(new Response(body, { headers: { "content-type": "text/plain" } }))
  const result = await importSourceUrls(project, ["https://example.com/doc"], config)
  expect(result).toEqual([{ url: "https://example.com/doc", path: "/project/raw/sources/doc.txt" }])
  expect(mocks.write).toHaveBeenCalledWith("/project/raw/sources/doc.txt", "Source URL: https://example.com/doc\n\n中文资料")
  expect(mocks.enqueue).toHaveBeenCalledWith(project, ["/project/raw/sources/doc.txt"], config)
})

it("bounds headers too and discards a late response without writing files", async () => {
  vi.useFakeTimers()
  let deliver!: (response: Response) => void
  mocks.fetch.mockReturnValue(new Promise<Response>(resolve => { deliver = resolve }))
  const resultPromise = importSourceUrls(project, ["https://example.com/late"], config)
  await flushMicrotasks(20)
  await vi.advanceTimersByTimeAsync(60_001)
  expect((await resultPromise)[0].error).toMatch(/timed out/)
  const cancel = vi.fn()
  deliver(new Response(new ReadableStream({ cancel })))
  await flushMicrotasks(20)
  expect(cancel).toHaveBeenCalled()
  expect(mocks.write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
