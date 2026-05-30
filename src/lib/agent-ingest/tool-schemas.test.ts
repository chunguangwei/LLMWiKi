import { describe, it, expect } from "vitest"
import { toolSchemasForLlm, assertSchemasUnique } from "./tool-schemas"
import { TOOLS } from "./tools"

describe("toolSchemasForLlm", () => {
  it("returns one entry per registered tool", () => {
    const schemas = toolSchemasForLlm()
    expect(schemas).toHaveLength(TOOLS.length)
  })

  it("preserves catalogue order (LLM weights earlier tools more)", () => {
    const schemas = toolSchemasForLlm()
    for (let i = 0; i < TOOLS.length; i++) {
      expect(schemas[i].name).toBe(TOOLS[i].name)
    }
  })

  it("renames inputSchema → input_schema (Anthropic / OpenAI convention)", () => {
    const schemas = toolSchemasForLlm()
    for (const schema of schemas) {
      expect(schema.input_schema).toBeDefined()
      // No internal "inputSchema" leaks into the LLM-facing shape.
      expect("inputSchema" in schema).toBe(false)
    }
  })

  it("forwards name + description + input_schema verbatim", () => {
    const schemas = toolSchemasForLlm()
    for (let i = 0; i < TOOLS.length; i++) {
      expect(schemas[i].name).toBe(TOOLS[i].name)
      expect(schemas[i].description).toBe(TOOLS[i].description)
      expect(schemas[i].input_schema).toBe(TOOLS[i].inputSchema)
    }
  })

  it("each tool has a non-empty description (the LLM needs prose to choose between them)", () => {
    const schemas = toolSchemasForLlm()
    for (const schema of schemas) {
      expect(schema.description.length).toBeGreaterThan(50)
    }
  })

  it("each input_schema is a valid JSON Schema-ish object", () => {
    const schemas = toolSchemasForLlm()
    for (const schema of schemas) {
      const s = schema.input_schema as Record<string, unknown>
      expect(s.type).toBe("object")
      // Either required[] is present and an array, or absent (no required fields)
      if ("required" in s) {
        expect(Array.isArray(s.required)).toBe(true)
      }
      // Properties present and an object
      expect(typeof s.properties).toBe("object")
    }
  })

  it("includes all 13 tools in catalogue order", () => {
    // 11 from agent-ingest Phase A/E + 2 from agent-lint-fix Phase G1
    // (search_wiki_by_title + delete_wiki_page).
    const names = toolSchemasForLlm().map((s) => s.name)
    expect(names).toEqual([
      "read_outline",
      "read_chunk",
      "search_source",
      "list_wiki_pages",
      "read_wiki_page",
      "search_wiki_by_title",
      "mark_section_covered",
      "surface_gap",
      "write_wiki_page",
      "update_wiki_page",
      "link_pages",
      "delete_wiki_page",
      "done",
    ])
  })
})

describe("assertSchemasUnique", () => {
  it("does not throw on the actual catalogue (sanity check)", () => {
    expect(() => assertSchemasUnique()).not.toThrow()
  })
})
