import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()

function readAsset(path: string): Buffer {
  const absolutePath = resolve(root, path)
  expect(existsSync(absolutePath), `Missing brand asset: ${path}`).toBe(true)
  return readFileSync(absolutePath)
}

function pngDimensions(path: string): [number, number] {
  const data = readAsset(path)
  expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

describe("brand assets", () => {
  it.each([
    ["logo.png", 512],
    ["src/assets/logo.png", 512],
    ["src-tauri/icons/icon.png", 512],
    ["src-tauri/icons/32x32.png", 32],
    ["src-tauri/icons/128x128.png", 128],
    ["src-tauri/icons/128x128@2x.png", 256],
    ["public/favicon.png", 32],
    ["extension/icon16.png", 16],
    ["extension/icon48.png", 48],
    ["extension/icon128.png", 128],
  ])("renders %s at the expected size", (path, expected) => {
    expect(pngDimensions(path)).toEqual([expected, expected])
  })

  it("keeps valid macOS and Windows icon containers", () => {
    const icns = readAsset("src-tauri/icons/icon.icns")
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(icns.length)

    const ico = readAsset("src-tauri/icons/icon.ico")
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0)
  })

  it("keeps vector sources local and free of executable content", () => {
    for (const name of ["llm-wiki-icon.svg", "llm-wiki-mark.svg", "llm-wiki-monochrome.svg"]) {
      const svg = readAsset(`src/assets/brand/${name}`).toString("utf8")
      expect(svg).not.toMatch(/<(?:script|image|foreignObject|text)\b/i)
      expect(svg).not.toMatch(/(?:href|src)\s*=\s*["']https?:/i)
    }
  })

  it("references only local vector inputs in the icon manifest", () => {
    const manifest = JSON.parse(readAsset("src/assets/brand/icon-manifest.json").toString("utf8"))
    for (const key of ["default", "android_fg", "android_monochrome"]) {
      const input = manifest[key]
      expect(typeof input).toBe("string")
      expect(input).toMatch(/\.svg$/)
      expect(readAsset(`src/assets/brand/${input}`).length).toBeGreaterThan(0)
    }
    expect(manifest.bg_color).toBe("#102F33")
  })
})
