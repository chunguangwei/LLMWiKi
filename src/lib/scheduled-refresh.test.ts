import { expect, it, vi } from "vitest"
vi.mock("@/commands/fs", () => ({
  writeFile: async () => {},
  readFile: async () => "---\nrefresh-enabled: true\n---\nBody",
  listDirectory: async () => [{ name: "page.md", path: "/project/wiki/page.md", is_dir: false }],
}))
vi.mock("@/lib/refresh-runner", async (original) => ({
  ...await original<typeof import("./refresh-runner")>(),
  runPageRefresh: async () => "error",
}))
import { scanProject } from "./scheduled-refresh"
it("counts a returned refresh error as an error rather than a successful run", async () => {
  expect(await scanProject({ id: "test", name: "test", path: "/project" })).toEqual({ ran: 0, skipped: 0, errored: 1 })
})
