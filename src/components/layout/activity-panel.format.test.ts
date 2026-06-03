import { describe, it, expect } from "vitest"
import { formatEta } from "./activity-panel"

describe("formatEta", () => {
  it("shows <1m for sub-minute estimates", () => {
    expect(formatEta(0)).toBe("<1m")
    expect(formatEta(20_000)).toBe("<1m")
  })

  it("shows minutes only under an hour", () => {
    expect(formatEta(5 * 60_000)).toBe("~5m")
    expect(formatEta(59 * 60_000)).toBe("~59m")
  })

  it("shows hours + minutes past an hour", () => {
    expect(formatEta(60 * 60_000)).toBe("~1h 0m")
    expect(formatEta((2 * 60 + 3) * 60_000)).toBe("~2h 3m")
  })

  it("rounds to the nearest minute", () => {
    expect(formatEta(90_000)).toBe("~2m") // 1.5 min → 2
    expect(formatEta(89_000)).toBe("~1m") // 1.48 min → 1
  })
})
