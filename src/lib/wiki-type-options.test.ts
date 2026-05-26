import { describe, it, expect } from "vitest"
import en from "@/i18n/en.json"
import zh from "@/i18n/zh.json"
import { WIKI_TYPE_OPTIONS } from "./wiki-type-options"

function resolve(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

describe("WIKI_TYPE_OPTIONS", () => {
  it("has unique slugs", () => {
    const values = WIKI_TYPE_OPTIONS.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it("every labelKey resolves to a string in both en and zh", () => {
    for (const { value, labelKey } of WIKI_TYPE_OPTIONS) {
      expect(typeof resolve(en, labelKey), `en label for ${value} (${labelKey})`).toBe("string")
      expect(typeof resolve(zh, labelKey), `zh label for ${value} (${labelKey})`).toBe("string")
    }
  })

  it("never offers the reserved overview type", () => {
    expect(WIKI_TYPE_OPTIONS.some((o) => o.value === "overview")).toBe(false)
  })
})
