import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

import { createDirectory, writeFile, writeFileAtomic } from "./fs"

describe("fs command path guards", () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it("rejects relative write paths before invoking Tauri", async () => {
    await expect(writeFile("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative atomic write paths before invoking Tauri", async () => {
    await expect(writeFileAtomic("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative directory paths before invoking Tauri", async () => {
    await expect(createDirectory("wiki/sources")).rejects.toThrow(/absolute path/i)

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("allows absolute write paths", async () => {
    mocks.invoke.mockResolvedValue(undefined)

    await writeFile("/tmp/project/wiki/sources/page.md", "content")

    expect(mocks.invoke).toHaveBeenCalledWith("write_file", {
      path: "/tmp/project/wiki/sources/page.md",
      contents: "content",
    })
  })
})
