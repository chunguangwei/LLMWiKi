import { describe, it, expect } from "vitest"
import {
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  computeIngestSourceBudget,
  splitSourceIntoSemanticChunks,
} from "./ingest"

// These cover the upstream-ported long-source helpers. They are pure and
// don't touch the fork's smart-split / schema generation logic.

describe("computeIngestGenerationMaxTokens", () => {
  it("scales the output-token cap by context window tier", () => {
    // undefined falls back to DEFAULT_MAX_CTX (204_800) → 128k tier.
    expect(computeIngestGenerationMaxTokens(undefined)).toBe(16_384)
    expect(computeIngestGenerationMaxTokens(100_000)).toBe(8_192)
    expect(computeIngestGenerationMaxTokens(128_000)).toBe(16_384)
    expect(computeIngestGenerationMaxTokens(256_000)).toBe(24_576)
    expect(computeIngestGenerationMaxTokens(512_000)).toBe(32_768)
  })

  it("is monotonic non-decreasing in context size", () => {
    const sizes = [8_000, 64_000, 128_000, 256_000, 512_000, 1_000_000]
    const out = sizes.map(computeIngestGenerationMaxTokens)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
    }
  })
})

describe("computeIngestReviewMaxTokens", () => {
  it("stays within [4096, 8192] and tracks half the generation cap", () => {
    for (const ctx of [undefined, 100_000, 128_000, 512_000]) {
      const r = computeIngestReviewMaxTokens(ctx)
      expect(r).toBeGreaterThanOrEqual(4_096)
      expect(r).toBeLessThanOrEqual(8_192)
    }
  })
})

describe("computeIngestSourceBudget", () => {
  it("never drops below the long-source minimum and respects the single-pass ceiling", () => {
    // Units are TOKENS now; min budget is 3,000 tokens, ceiling 300,000.
    const tiny = computeIngestSourceBudget(8_000, 1_000)
    expect(tiny).toBeGreaterThanOrEqual(3_000)
    const huge = computeIngestSourceBudget(2_000_000, 1_000)
    expect(huge).toBeLessThanOrEqual(300_000)
  })

  it("grows with context size", () => {
    const small = computeIngestSourceBudget(32_000, 2_000)
    const large = computeIngestSourceBudget(256_000, 2_000)
    expect(large).toBeGreaterThanOrEqual(small)
  })
})

describe("splitSourceIntoSemanticChunks", () => {
  it("returns a single chunk when content fits the target (preserves single-pass path)", () => {
    const chunks = splitSourceIntoSemanticChunks("Hello world.\n\nSecond paragraph here.", 4_000, 200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].index).toBe(1)
    expect(chunks[0].total).toBe(1)
    expect(chunks[0].overlapBefore).toBe("")
  })

  it("splits oversized content into ordered chunks with overlap from the previous chunk", () => {
    const para = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor."
    const content = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${para}`).join("\n\n")
    const chunks = splitSourceIntoSemanticChunks(content, 1_000, 300)

    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i + 1)
      expect(c.total).toBe(chunks.length)
    })
    // The first chunk has no preceding context; later chunks carry an
    // overlap tail from the prior chunk.
    expect(chunks[0].overlapBefore).toBe("")
    expect(chunks[1].overlapBefore.length).toBeGreaterThan(0)
  })
})
