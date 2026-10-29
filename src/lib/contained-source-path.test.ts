import { expect, it } from "vitest"
import { resolveContainedSourcePath } from "./contained-source-path"

it.each([
  ["/project", "raw/sources/a.md", "/project/raw/sources/a.md"],
  ["/project", "legacy.md", "/project/legacy.md"],
  ["C:\\Project", "c:\\project\\raw\\sources\\a.md", "c:/project/raw/sources/a.md"],
  ["\\\\server\\Share\\Project", "\\\\SERVER\\share\\project\\raw\\sources\\a.md", "//SERVER/share/project/raw/sources/a.md"],
])("resolves a contained source in %s", (root, source, expected) => {
  expect(resolveContainedSourcePath(root, source)).toBe(expected)
})
it.each([
  "/project-b/raw/sources/a.md",
  "/other/raw/sources/a.md",
  "raw/../../outside.md",
  "/project/raw/../../../outside.md",
])("rejects foreign or traversing source %s as non-retryable", (source) => {
  expect(() => resolveContainedSourcePath("/project", source)).toThrow(/outside/)
  try { resolveContainedSourcePath("/project", source) } catch (error) {
    expect(error).toMatchObject({ nonRetryable: true })
  }
})
