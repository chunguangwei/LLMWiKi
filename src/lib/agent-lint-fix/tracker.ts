/**
 * Coverage tracker for agent-lint-fix runs.
 *
 * Extends agent-ingest's InMemoryCoverageTracker so the runner's
 * tracker contract is satisfied without forking. Adds `markDeleted`
 * / `deletedPages()` for the delete_wiki_page tool's reporting —
 * agent-ingest doesn't need delete tracking (extraction never
 * removes), but lint-fix does because the activity panel must
 * audit which pages went away.
 *
 * Source-chunk concepts (coveragePercent, markCovered) are inherited
 * but unused in practice: lint-fix runs with `totalChunks = 0` so
 * coveragePercent stays at 0 — `isComplete()` flips solely on the
 * agent's `done` call.
 */
import { InMemoryCoverageTracker } from "../agent-ingest/tracker"

export class LintFixTracker extends InMemoryCoverageTracker {
  private deletedList: Array<{ slug: string; reason: string }> = []

  constructor(itemId: string) {
    // `sourcePath` is overloaded here to carry the lint item id —
    // it lands in the snapshot as the "source", giving the activity
    // panel something stable to key on. `sourceHash` and totalChunks
    // are unused in the lint path; pass placeholders.
    super(`lint:${itemId}`, "lint-fix", 0)
  }

  markDeleted(slug: string, reason: string): void {
    // Idempotent — re-marking the same slug just refreshes the reason.
    const existing = this.deletedList.find((p) => p.slug === slug)
    if (existing) {
      existing.reason = reason
    } else {
      this.deletedList.push({ slug, reason })
    }
  }

  deletedPages(): Array<{ slug: string; reason: string }> {
    return this.deletedList.slice()
  }
}
