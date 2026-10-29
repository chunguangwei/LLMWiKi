import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkForUpdates } from "./update-check"

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }))
vi.mock("./tauri-fetch", () => ({ getHttpFetch: async () => httpFetch }))
const repo = "chunguangwei/LLMWiKi"
const manifest = {
  version: "0.8.3", notes: "Source recovery fixes", pub_date: "2026-10-29T07:07:07Z",
  platforms: { "darwin-aarch64": { url: "https://github.com/chunguangwei/LLMWiKi/releases/download/v0.8.3/LLM.Wiki_aarch64.app.tar.gz", signature: "signed-artifact" } },
}
const json = (value: unknown) => new Response(JSON.stringify(value))
beforeEach(() => { httpFetch.mockReset() })

describe("update detection when the anonymous GitHub API is unavailable", () => {
  it.each([403, 429, 500])("finds the published update after API HTTP %s", async (status) => {
    httpFetch.mockImplementation(async (url: string) => url.includes("api.github.com") ? new Response("unavailable", { status }) : json(manifest))
    const result = await checkForUpdates({ currentVersion: "0.8.1", repo })
    expect(result).toMatchObject({ kind: "available", local: "0.8.1", remote: "v0.8.3", release: { body: "Source recovery fixes", html_url: "https://github.com/chunguangwei/LLMWiKi/releases/latest" } })
  })
  it("recovers from API transport failures using the release asset", async () => {
    httpFetch.mockImplementation(async (url: string) => {
      if (url.includes("api.github.com")) throw new TypeError("Failed to fetch")
      return json(manifest)
    })
    expect(await checkForUpdates({ currentVersion: "0.8.1", repo })).toMatchObject({ kind: "available", remote: "v0.8.3" })
  })
  it("does not suggest reinstalling the current version", async () => {
    httpFetch.mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(json(manifest))
    expect(await checkForUpdates({ currentVersion: "0.8.3", repo })).toMatchObject({ kind: "up-to-date" })
  })
  it.each([{}, { ...manifest, version: "999.broken" }, { ...manifest, platforms: {} }])("reports an error for an unusable fallback manifest", async (invalid) => {
    httpFetch.mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(json(invalid))
    expect(await checkForUpdates({ currentVersion: "0.8.1", repo })).toMatchObject({ kind: "error" })
  })
  it("preserves release metadata when the API succeeds", async () => {
    httpFetch.mockResolvedValue(json({ tag_name: "v0.8.3", html_url: "https://github.com/chunguangwei/LLMWiKi/releases/tag/v0.8.3", body: "Full release notes" }))
    expect(await checkForUpdates({ currentVersion: "0.8.1", repo })).toMatchObject({ kind: "available", release: { body: "Full release notes" } })
  })
})
