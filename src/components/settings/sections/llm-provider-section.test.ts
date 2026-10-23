import { describe, expect, it } from "vitest"
import { parseExtraRequestBody } from "./llm-provider-section"

describe("parseExtraRequestBody", () => {
  it("accepts an object and treats blank input as disabled", () => {
    expect(parseExtraRequestBody('{"enable_thinking":false}')).toEqual({ enable_thinking: false })
    expect(parseExtraRequestBody("  ")).toBeUndefined()
  })

  it("rejects arrays and invalid JSON", () => {
    expect(() => parseExtraRequestBody("[]")).toThrow(/JSON object/)
    expect(() => parseExtraRequestBody("{")).toThrow()
  })
})
