import { describe, expect, it, vi, beforeEach } from "vitest"
import { annotateIndex, formatBullet, parseBullet, parseLlmResponse } from "./wiki-index-annotate"

type FsState = {
  files: Map<string, string>
}

let fs: FsState = { files: new Map() }

function setFile(p: string, c: string) {
  fs.files.set(p, c)
}

vi.mock("@/commands/fs", () => ({
  fileExists: async (p: string) => fs.files.has(p),
  readFile: async (p: string) => {
    const c = fs.files.get(p)
    if (c === undefined) throw new Error(`mock fs: not found: ${p}`)
    return c
  },
  writeFileAtomic: async (p: string, c: string) => {
    fs.files.set(p, c)
  },
}))

// Stub the LLM seam so tests can script responses without touching
// the real streamChat. Tests overwrite `mockLlmResponse` per case.
let mockLlmResponse = ""
let mockLlmError = false
vi.mock("./llm-client", () => ({
  streamChat: async (
    _config: unknown,
    _messages: unknown,
    cbs: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
  ) => {
    if (mockLlmError) {
      cbs.onError(new Error("mocked LLM error"))
      return
    }
    for (const ch of mockLlmResponse) cbs.onToken(ch)
    cbs.onDone()
  },
}))

beforeEach(() => {
  fs = { files: new Map() }
  mockLlmResponse = ""
  mockLlmError = false
})

const PROJECT = "/p"
const WIKI = `${PROJECT}/wiki`

const llmConfig = {
  provider: "openai",
  apiKey: "sk",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
} as never

describe("parseBullet", () => {
  it("recognises bare wikilink bullets", () => {
    expect(parseBullet("- [[concepts/foo]]")).toMatchObject({
      slug: "concepts/foo",
      alias: null,
      description: null,
    })
  })

  it("recognises aliased wikilinks + descriptions", () => {
    const p = parseBullet("- [[concepts/foo|Foo]] — first description")!
    expect(p.slug).toBe("concepts/foo")
    expect(p.alias).toBe("Foo")
    expect(p.description).toBe("first description")
  })

  it("returns null for non-bullets", () => {
    expect(parseBullet("# Wiki Index")).toBeNull()
    expect(parseBullet("Some prose line")).toBeNull()
    expect(parseBullet("- plain text item")).toBeNull()
  })
})

describe("formatBullet", () => {
  it("composes a bullet with description using em-dash", () => {
    expect(
      formatBullet({ prefix: "- [[", slug: "concepts/foo", alias: "Foo", description: "the key fact" }),
    ).toBe("- [[concepts/foo|Foo]] — the key fact")
  })

  it("omits the dash when description is null / empty", () => {
    expect(
      formatBullet({ prefix: "- [[", slug: "concepts/foo", alias: null, description: null }),
    ).toBe("- [[concepts/foo]]")
    expect(
      formatBullet({ prefix: "- [[", slug: "concepts/foo", alias: null, description: "" }),
    ).toBe("- [[concepts/foo]]")
  })
})

describe("parseLlmResponse", () => {
  it("extracts a clean slug→description map", () => {
    const out = parseLlmResponse('{"concepts/foo":"Description A","concepts/bar":"Description B"}')
    expect(out).toEqual({ "concepts/foo": "Description A", "concepts/bar": "Description B" })
  })

  it("tolerates surrounding prose / code fences", () => {
    const out = parseLlmResponse('```json\n{"concepts/foo":"Hello"}\n```\nDone.')
    expect(out).toEqual({ "concepts/foo": "Hello" })
  })

  it("skips empty descriptions", () => {
    const out = parseLlmResponse('{"a":"","b":"good"}')
    expect(out).toEqual({ b: "good" })
  })

  it("returns {} when there is no JSON", () => {
    expect(parseLlmResponse("just prose, no json")).toEqual({})
    expect(parseLlmResponse("")).toEqual({})
  })
})

describe("annotateIndex", () => {
  it("does nothing when every bullet already has a description", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n## Concepts\n\n- [[concepts/foo|Foo]] — already described\n")
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nFoo body.\n")
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r).toEqual({ attempted: 0, produced: 0, cached: 0, failed: 0, llmError: false })
  })

  it("calls the LLM for un-annotated bullets and writes descriptions back", async () => {
    setFile(`${WIKI}/index.md`, [
      "# Wiki Index",
      "",
      "## Concepts",
      "",
      "- [[concepts/foo|Foo]]",
      "- [[concepts/bar|Bar]]",
      "",
    ].join("\n"))
    setFile(`${WIKI}/concepts/foo.md`, "---\ntype: concept\ntitle: Foo\n---\n\nFoo describes the F.\n")
    setFile(`${WIKI}/concepts/bar.md`, "---\ntype: concept\ntitle: Bar\n---\n\nBar describes the B.\n")
    mockLlmResponse = '{"concepts/foo":"the F key fact","concepts/bar":"the B key fact"}'
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r.attempted).toBe(2)
    expect(r.produced).toBe(2)
    expect(r.cached).toBe(0)
    const idx = fs.files.get(`${WIKI}/index.md`)!
    expect(idx).toContain("- [[concepts/foo|Foo]] — the F key fact")
    expect(idx).toContain("- [[concepts/bar|Bar]] — the B key fact")
  })

  it("caches descriptions by body hash and skips LLM on the second run", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
    setFile(`${WIKI}/concepts/foo.md`, "---\ntitle: Foo\n---\n\nFoo body stays.\n")
    mockLlmResponse = '{"concepts/foo":"cached on first run"}'

    const r1 = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r1.produced).toBe(1)
    expect(r1.cached).toBe(0)

    // Reset the index: bullet has no description again. Body is unchanged.
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
    // Set LLM to throw if called — proves the cache hit path skips the call.
    mockLlmResponse = '{"this":"should not appear"}'
    const r2 = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r2.cached).toBe(1)
    expect(r2.produced).toBe(0)
    expect(fs.files.get(`${WIKI}/index.md`)!).toContain("— cached on first run")
  })

  it("re-annotates when the page body changes (hash mismatch)", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
    setFile(`${WIKI}/concepts/foo.md`, "---\ntitle: Foo\n---\n\nFirst version.\n")
    mockLlmResponse = '{"concepts/foo":"first version description"}'
    await annotateIndex({ projectPath: PROJECT, llmConfig })

    // Body changes → cache miss.
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
    setFile(`${WIKI}/concepts/foo.md`, "---\ntitle: Foo\n---\n\nSecond version, very different.\n")
    mockLlmResponse = '{"concepts/foo":"second version description"}'
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r.produced).toBe(1)
    expect(fs.files.get(`${WIKI}/index.md`)!).toContain("— second version description")
  })

  it("survives an LLM error gracefully (no description, index untouched)", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
    setFile(`${WIKI}/concepts/foo.md`, "---\ntitle: Foo\n---\n\nbody\n")
    mockLlmError = true
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r.llmError).toBe(true)
    expect(r.failed).toBeGreaterThan(0)
    expect(fs.files.get(`${WIKI}/index.md`)!).toBe("# Wiki Index\n\n- [[concepts/foo|Foo]]\n")
  })

  it("skips bullets whose target page is missing on disk", async () => {
    setFile(`${WIKI}/index.md`, "# Wiki Index\n\n- [[concepts/ghost|Ghost]]\n")
    // No file for concepts/ghost.md
    mockLlmResponse = '{"concepts/ghost":"should not be used"}'
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r.attempted).toBe(1)
    expect(r.produced).toBe(0)
    expect(fs.files.get(`${WIKI}/index.md`)!).toBe("# Wiki Index\n\n- [[concepts/ghost|Ghost]]\n")
  })

  it("no-ops when index.md doesn't exist", async () => {
    const r = await annotateIndex({ projectPath: PROJECT, llmConfig })
    expect(r).toEqual({ attempted: 0, produced: 0, cached: 0, failed: 0, llmError: false })
  })
})
