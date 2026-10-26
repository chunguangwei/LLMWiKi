import { beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_IMAGE_BYTES, readMessageImageFromPath } from "./chat-image-utils"

const mocks = vi.hoisted(() => ({
  getFileSize: vi.fn(),
  readFileAsBase64: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  getFileSize: mocks.getFileSize,
  readFileAsBase64: mocks.readFileAsBase64,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getFileSize.mockResolvedValue(3)
  mocks.readFileAsBase64.mockResolvedValue({ base64: "aW1n", mimeType: "image/png" })
})

describe("native image paths", () => {
  it("checks size before reading and preserves the supported image payload", async () => {
    mocks.readFileAsBase64.mockResolvedValue({ base64: "anBlZw==", mimeType: "image/jpeg" })

    await expect(readMessageImageFromPath("/tmp/photo.JPEG")).resolves.toEqual({
      ok: true,
      image: { mediaType: "image/jpeg", dataBase64: "anBlZw==" },
    })
    expect(mocks.getFileSize.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.readFileAsBase64.mock.invocationCallOrder[0])
  })

  it("rejects unsupported types without touching the filesystem", async () => {
    await expect(readMessageImageFromPath("/tmp/vector.svg")).resolves.toEqual({
      ok: false,
      reason: "unsupported-type",
      name: "vector.svg",
      mediaType: "application/octet-stream",
    })
    expect(mocks.getFileSize).not.toHaveBeenCalled()
    expect(mocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("rejects oversized images before reading their bytes", async () => {
    mocks.getFileSize.mockResolvedValue(MAX_IMAGE_BYTES + 1)

    await expect(readMessageImageFromPath("/tmp/large.png")).resolves.toEqual({
      ok: false,
      reason: "too-large",
      name: "large.png",
    })
    expect(mocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("allows an image exactly at the size limit", async () => {
    mocks.getFileSize.mockResolvedValue(MAX_IMAGE_BYTES)
    const result = await readMessageImageFromPath("/tmp/limit.png")
    expect(result.ok).toBe(true)
    expect(mocks.readFileAsBase64).toHaveBeenCalledOnce()
  })

  it("returns an unreadable result for missing files and read failures", async () => {
    mocks.getFileSize.mockRejectedValue(new Error("not found"))
    await expect(readMessageImageFromPath("/tmp/missing.png")).resolves.toEqual({
      ok: false,
      reason: "unreadable",
      name: "missing.png",
    })

    mocks.getFileSize.mockResolvedValue(3)
    mocks.readFileAsBase64.mockRejectedValue(new Error("permission denied"))
    await expect(readMessageImageFromPath("/tmp/private.png")).resolves.toEqual({
      ok: false,
      reason: "unreadable",
      name: "private.png",
    })
  })

  it("rejects a mismatched backend media type without attaching the payload", async () => {
    mocks.readFileAsBase64.mockResolvedValue({ base64: "dGV4dA==", mimeType: "application/octet-stream" })
    const result = await readMessageImageFromPath("/tmp/not-an-image.png")
    expect(result).toEqual({
      ok: false,
      reason: "unsupported-type",
      name: "not-an-image.png",
      mediaType: "application/octet-stream",
    })
  })
})
