import { describe, it, expect } from "vitest"
import { KeywordVectorIndex } from "./vector-index"
import type { SourceChunk } from "./types"

function chunk(id: string, content: string): SourceChunk {
  return { chunk_id: id, line_range: [1, 10], content }
}

describe("KeywordVectorIndex — relevance", () => {
  it("ranks chunks containing query terms higher", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "The cat sat on the mat."),
      chunk("c1", "Quantum field theory and particle physics."),
      chunk("c2", "Cats love mats. The mat was warm."),
    ])
    const hits = await idx.search("cat mat", 3)
    expect(hits[0].chunk_id).toMatch(/^c[02]$/)  // c0 or c2 — both relevant
    expect(hits.find((h) => h.chunk_id === "c1")).toBeUndefined()
  })

  it("returns no results when no query token matches", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "alpha beta gamma"),
      chunk("c1", "delta epsilon"),
    ])
    const hits = await idx.search("nothing matches here", 5)
    expect(hits).toEqual([])
  })

  it("returns no results for empty query", async () => {
    const idx = new KeywordVectorIndex([chunk("c0", "anything")])
    const hits = await idx.search("", 5)
    expect(hits).toEqual([])
  })

  it("returns no results when index is empty", async () => {
    const idx = new KeywordVectorIndex([])
    const hits = await idx.search("anything", 5)
    expect(hits).toEqual([])
  })

  it("respects topK", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "alpha beta"),
      chunk("c1", "alpha gamma"),
      chunk("c2", "alpha delta"),
      chunk("c3", "alpha epsilon"),
    ])
    const hits = await idx.search("alpha", 2)
    expect(hits).toHaveLength(2)
  })
})

describe("KeywordVectorIndex — IDF behaviour", () => {
  it("rare terms outweigh common terms in scoring", async () => {
    // "the" appears in every chunk → low idf.
    // "quaternion" appears only in c1 → high idf.
    const idx = new KeywordVectorIndex([
      chunk("c0", "the cat sat on the mat"),
      chunk("c1", "the quaternion algebra is non-abelian"),
      chunk("c2", "the dog walked under the bridge"),
    ])
    const hits = await idx.search("the quaternion", 3)
    // c1 should win because "quaternion" is rare; "the" contributes ~equally to all
    expect(hits[0].chunk_id).toBe("c1")
  })

  it("longer chunks don't dominate just by having more tokens (length normalisation)", async () => {
    // Both contain "rare-term" exactly once; c1 is much longer.
    // BM25 length-norm should bring c0's score above c1's despite
    // identical TF — short hits are more "concentrated" signal.
    const idx = new KeywordVectorIndex([
      chunk("c0", "rare-term immediately on its own line"),
      chunk(
        "c1",
        "rare-term then a thousand words of unrelated filler " + "filler ".repeat(200),
      ),
    ])
    const hits = await idx.search("rare-term", 2)
    expect(hits[0].chunk_id).toBe("c0")
  })
})

describe("KeywordVectorIndex — CJK", () => {
  it("indexes Chinese single-character tokens", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "快手IT团队OKR评审会议纪要"),
      chunk("c1", "今天天气很好"),
    ])
    const hits = await idx.search("OKR 评审", 3)
    expect(hits[0].chunk_id).toBe("c0")
  })

  it("mixed CJK + ASCII query matches both token types", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "Q3 2024 revenue 收入"),
      chunk("c1", "user research 用户研究"),
    ])
    const hits = await idx.search("revenue 收入", 3)
    expect(hits[0].chunk_id).toBe("c0")
  })
})

describe("KeywordVectorIndex — tokeniser edge cases", () => {
  it("drops single-char ASCII tokens (noise filter)", async () => {
    const idx = new KeywordVectorIndex([chunk("c0", "x y z a b c")])
    const hits = await idx.search("x", 3)
    expect(hits).toEqual([])  // 1-char ASCII filtered
  })

  it("case-insensitive matching", async () => {
    const idx = new KeywordVectorIndex([chunk("c0", "PostgreSQL Performance")])
    const hits = await idx.search("postgresql performance", 3)
    expect(hits[0].chunk_id).toBe("c0")
  })

  it("underscores and digits are word characters", async () => {
    const idx = new KeywordVectorIndex([
      chunk("c0", "snake_case_function and Q4 2024 numbers"),
    ])
    const r1 = await idx.search("snake_case_function", 3)
    expect(r1[0].chunk_id).toBe("c0")
    const r2 = await idx.search("Q4", 3)
    expect(r2[0].chunk_id).toBe("c0")
  })
})
