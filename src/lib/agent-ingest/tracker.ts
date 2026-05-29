/**
 * Coverage tracker — the runtime state object that tools mutate
 * during the agent loop, and the persistence shape that survives
 * across turn boundaries (so a partial run can resume).
 *
 * See `docs/agent-ingest-design.md` §5 for the full spec; this file
 * is the runtime + JSON-roundtrip implementation.
 *
 * Phase E will land:
 *   - file load / save under `<project>/.llm-wiki/agent-checkpoints/`
 *   - the 0.85 coverage threshold + monotonicity check (don't loop
 *     forever on the same chunks)
 *   - sourceHash invalidation (a re-edited source file invalidates
 *     the checkpoint instead of resuming stale)
 */
import type { CoverageTracker, CoverageSnapshot } from "./types"

export class InMemoryCoverageTracker implements CoverageTracker {
  private covered = new Set<string>()
  private created: Array<{ slug: string; fromChunks: string[] }> = []
  private updated: Array<{ slug: string; fromChunks: string[] }> = []
  private _gaps: Array<{ topic: string; chunks?: string[] }> = []
  private _completed = false
  private _budgetExhausted = false
  private _turnsUsed = 0
  private _tokensSpent = 0

  constructor(
    private readonly sourcePath: string,
    private readonly sourceHash: string,
    private readonly totalChunks: number,
  ) {}

  markCovered(chunk_id: string, _page_slugs: string[]): void {
    this.covered.add(chunk_id)
  }
  markCreated(slug: string, fromChunks: string[]): void {
    // Idempotent — re-marking the same slug just updates fromChunks.
    const existing = this.created.find((p) => p.slug === slug)
    if (existing) {
      existing.fromChunks = Array.from(new Set([...existing.fromChunks, ...fromChunks]))
    } else {
      this.created.push({ slug, fromChunks: [...fromChunks] })
    }
  }
  markUpdated(slug: string, fromChunks: string[]): void {
    const existing = this.updated.find((p) => p.slug === slug)
    if (existing) {
      existing.fromChunks = Array.from(new Set([...existing.fromChunks, ...fromChunks]))
    } else {
      this.updated.push({ slug, fromChunks: [...fromChunks] })
    }
  }
  surfaceGap(topic: string, chunks?: string[]): void {
    this._gaps.push({ topic, chunks })
  }
  markCompleted(_reason: string): void {
    this._completed = true
  }
  markBudgetExhausted(): void {
    this._budgetExhausted = true
  }
  coveragePercent(): number {
    return this.totalChunks > 0 ? this.covered.size / this.totalChunks : 0
  }
  isComplete(): boolean {
    return this._completed || this.coveragePercent() >= 0.85
  }
  createdPages(): Array<{ slug: string; fromChunks: string[] }> {
    return this.created.slice()
  }
  updatedPages(): Array<{ slug: string; fromChunks: string[] }> {
    return this.updated.slice()
  }
  gaps(): Array<{ topic: string; chunks?: string[] }> {
    return this._gaps.slice()
  }
  recordTurn(tokensThisTurn: number): void {
    this._turnsUsed += 1
    this._tokensSpent += tokensThisTurn
  }

  snapshot(): CoverageSnapshot {
    return {
      sourcePath: this.sourcePath,
      sourceHash: this.sourceHash,
      totalChunks: this.totalChunks,
      coveredChunks: Array.from(this.covered),
      pagesCreated: this.created.slice(),
      pagesUpdated: this.updated.slice(),
      gaps: this._gaps.map((g) => ({ topic: g.topic, relatedChunks: g.chunks })),
      turnsUsed: this._turnsUsed,
      tokensSpent: this._tokensSpent,
      completed: this._completed,
      budgetExhausted: this._budgetExhausted,
    }
  }

  static fromSnapshot(snap: CoverageSnapshot): InMemoryCoverageTracker {
    const t = new InMemoryCoverageTracker(snap.sourcePath, snap.sourceHash, snap.totalChunks)
    for (const id of snap.coveredChunks) t.covered.add(id)
    t.created = snap.pagesCreated.slice()
    t.updated = snap.pagesUpdated.slice()
    t._gaps = snap.gaps.map((g) => ({ topic: g.topic, chunks: g.relatedChunks }))
    t._completed = snap.completed
    t._budgetExhausted = snap.budgetExhausted
    t._turnsUsed = snap.turnsUsed
    t._tokensSpent = snap.tokensSpent
    return t
  }
}
