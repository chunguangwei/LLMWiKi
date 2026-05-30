import { describe, it, expect } from "vitest"
import { preprocessSource, sha256Hex } from "./preprocess"

describe("preprocessSource — chunk_ids and neighbours", () => {
  it("assigns sequential ids c0, c1, … in document order", async () => {
    // Build a source long enough to produce multiple chunks under
    // default chunker settings (target=1000). 4 sections × 1.5k.
    const longPara = (label: string) =>
      `## ${label}\n\n` + "x ".repeat(800) + "\n\n"
    const content =
      longPara("Intro") + longPara("Method") + longPara("Results") + longPara("Discussion")
    const result = await preprocessSource(content)

    expect(result.chunkList.length).toBeGreaterThan(1)
    for (let i = 0; i < result.chunkList.length; i++) {
      expect(result.chunkList[i].chunk_id).toBe(`c${i}`)
    }
  })

  it("threads prev/next chunk_ids and omits them at boundaries", async () => {
    const content =
      "## A\n\n" + "x ".repeat(800) + "\n\n## B\n\n" + "y ".repeat(800) + "\n\n## C\n\n" + "z ".repeat(800)
    const result = await preprocessSource(content)
    const chunks = result.chunkList
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // first
    expect(chunks[0].prev_chunk_id).toBeUndefined()
    expect(chunks[0].next_chunk_id).toBe("c1")
    // middle (if exists)
    if (chunks.length >= 3) {
      const middle = chunks[1]
      expect(middle.prev_chunk_id).toBe("c0")
      expect(middle.next_chunk_id).toBe("c2")
    }
    // last
    const last = chunks[chunks.length - 1]
    expect(last.next_chunk_id).toBeUndefined()
    expect(last.prev_chunk_id).toBe(`c${chunks.length - 2}`)
  })

  it("returns chunks indexed by chunk_id in the Map", async () => {
    const content = "# Foo\n\n" + "x ".repeat(800) + "\n\n# Bar\n\n" + "y ".repeat(800)
    const result = await preprocessSource(content)
    expect(result.chunks.size).toBe(result.chunkList.length)
    for (const c of result.chunkList) {
      expect(result.chunks.get(c.chunk_id)).toBe(c)
    }
  })
})

describe("preprocessSource — line ranges", () => {
  it("computes 1-based inclusive [startLine, endLine] for each chunk", async () => {
    // chunkMarkdown's split priority puts sections first — H1 + H2
    // become separate chunks. We assert every chunk's range is
    // 1-based, in-bounds, and ordered.
    const content = [
      "# H1",          // line 1
      "",              // line 2
      "intro body",    // line 3
      "",              // line 4
      "## Section A",  // line 5
      "",              // line 6
      "a-body",        // line 7
    ].join("\n")
    const result = await preprocessSource(content)
    expect(result.chunkList.length).toBeGreaterThanOrEqual(1)
    for (const c of result.chunkList) {
      const [start, end] = c.line_range
      expect(start).toBeGreaterThanOrEqual(1)
      expect(end).toBeLessThanOrEqual(7)
      expect(start).toBeLessThanOrEqual(end)
    }
  })

  it("line numbers reflect the ORIGINAL source position even after frontmatter strip", async () => {
    const content = [
      "---",
      "type: report",
      "title: T",
      "---",
      "",
      "# Real H1",     // line 6 in the original source
      "",
      "body",          // line 8
    ].join("\n")
    const result = await preprocessSource(content)
    expect(result.chunkList).toHaveLength(1)
    const [start, end] = result.chunkList[0].line_range
    // The chunk body starts AT OR AFTER the H1 line.
    expect(start).toBeGreaterThanOrEqual(6)
    expect(end).toBeLessThanOrEqual(8)
  })

  it("totalLines matches the source's actual line count", async () => {
    expect((await preprocessSource("")).totalLines).toBe(0)
    expect((await preprocessSource("one")).totalLines).toBe(1)
    expect((await preprocessSource("one\ntwo")).totalLines).toBe(2)
    expect((await preprocessSource("one\ntwo\n")).totalLines).toBe(2)  // trailing newline doesn't add
    expect((await preprocessSource("one\ntwo\nthree")).totalLines).toBe(3)
  })
})

describe("preprocessSource — outline", () => {
  it("extracts ATX headings and stamps them with chunk_ids", async () => {
    const content = [
      "# Title",         // line 1
      "intro",
      "",
      "## Section A",    // line 4
      "body A",
      "",
      "## Section B",    // line 7
      "body B",
    ].join("\n")
    const result = await preprocessSource(content)
    expect(result.outline).toHaveLength(3)
    expect(result.outline[0]).toMatchObject({ level: 1, text: "Title", line_start: 1 })
    expect(result.outline[1]).toMatchObject({ level: 2, text: "Section A", line_start: 4 })
    expect(result.outline[2]).toMatchObject({ level: 2, text: "Section B", line_start: 7 })
    // Every heading carries a chunk_id pointing at a chunk whose
    // line_range contains its line_start.
    for (const h of result.outline) {
      const chunk = result.chunkList.find((c) => c.chunk_id === h.chunk_id)
      expect(chunk).toBeDefined()
      expect(chunk!.line_range[0]).toBeLessThanOrEqual(h.line_start)
      expect(chunk!.line_range[1]).toBeGreaterThanOrEqual(h.line_start)
    }
  })

  it("ignores headings inside fenced code blocks", async () => {
    const content = [
      "# Real",
      "```",
      "# fake",
      "```",
      "## Also real",
    ].join("\n")
    const result = await preprocessSource(content)
    expect(result.outline.map((h) => h.text)).toEqual(["Real", "Also real"])
  })

  it("returns empty outline for no-headings source", async () => {
    const content = "Just paragraphs.\n\nAnd more text."
    const result = await preprocessSource(content)
    expect(result.outline).toEqual([])
  })
})

describe("preprocessSource — sourceHash", () => {
  it("same content → same hash (determinism)", async () => {
    const a = await preprocessSource("Hello world")
    const b = await preprocessSource("Hello world")
    expect(a.sourceHash).toBe(b.sourceHash)
  })

  it("different content → different hash", async () => {
    const a = await preprocessSource("Hello world")
    const b = await preprocessSource("Hello world!")
    expect(a.sourceHash).not.toBe(b.sourceHash)
  })

  it("hash is 64 hex chars (SHA-256)", async () => {
    const r = await preprocessSource("anything")
    expect(r.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("preprocessSource — edge cases", () => {
  it("empty source → no chunks, no outline, hash of empty string", async () => {
    const result = await preprocessSource("")
    expect(result.chunkList).toEqual([])
    expect(result.outline).toEqual([])
    expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("frontmatter-only source → no chunks (body strips to empty)", async () => {
    const content = ["---", "type: note", "title: T", "---", ""].join("\n")
    const result = await preprocessSource(content)
    expect(result.chunkList).toEqual([])
  })

  it("forwards chunkingOptions to chunkMarkdown", async () => {
    const content = "x ".repeat(5000)
    const tiny = await preprocessSource(content, {
      chunkingOptions: { targetChars: 200, maxChars: 300, minChars: 50, overlapChars: 50 },
    })
    const huge = await preprocessSource(content, {
      chunkingOptions: { targetChars: 5000, maxChars: 10000, minChars: 1000, overlapChars: 100 },
    })
    expect(tiny.chunkList.length).toBeGreaterThan(huge.chunkList.length)
  })
})

describe("sha256Hex", () => {
  it("matches a known vector", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})
