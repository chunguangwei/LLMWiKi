import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import { findSourcesAwaitingIngest } from "./source-ingest-actions"

describe("findSourcesAwaitingIngest", () => {
  it("collects supported sources that are new or stopped while excluding active and completed work", () => {
    const tree: FileNode[] = [
      {
        name: "Papers",
        path: "/project/raw/sources/Papers",
        is_dir: true,
        children: [
          { name: "new.pdf", path: "/project/raw/sources/Papers/new.pdf", is_dir: false },
          { name: "failed.md", path: "/project/raw/sources/Papers/failed.md", is_dir: false },
          { name: "working.txt", path: "/project/raw/sources/Papers/working.txt", is_dir: false },
          { name: "done.md", path: "/project/raw/sources/Papers/done.md", is_dir: false },
          { name: "notes.zip", path: "/project/raw/sources/Papers/notes.zip", is_dir: false },
        ],
      },
    ]

    expect(findSourcesAwaitingIngest(tree, new Map([
      ["/project/raw/sources/Papers/failed.md", "failed"],
      ["/project/raw/sources/Papers/working.txt", "processing"],
      ["/project/raw/sources/Papers/done.md", "ingested"],
    ]))).toEqual([
      "/project/raw/sources/Papers/new.pdf",
      "/project/raw/sources/Papers/failed.md",
    ])
  })
})
