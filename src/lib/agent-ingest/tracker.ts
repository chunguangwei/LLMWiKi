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
  private _gaps: Array<{ topic: string; reason?: string; chunks?: string[] }> = []
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
  surfaceGap(topic: string, opts?: { reason?: string; chunks?: string[] }): void {
    const entry: { topic: string; reason?: string; chunks?: string[] } = { topic }
    if (opts?.reason) entry.reason = opts.reason
    if (opts?.chunks && opts.chunks.length > 0) entry.chunks = opts.chunks.slice()
    this._gaps.push(entry)
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
  gaps(): Array<{ topic: string; reason?: string; chunks?: string[] }> {
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
      gaps: this._gaps.map((g) => ({
        topic: g.topic,
        ...(g.reason ? { reason: g.reason } : {}),
        ...(g.chunks && g.chunks.length > 0 ? { relatedChunks: g.chunks } : {}),
      })),
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
    t._gaps = snap.gaps.map((g) => {
      const e: { topic: string; reason?: string; chunks?: string[] } = { topic: g.topic }
      if (g.reason) e.reason = g.reason
      if (g.relatedChunks && g.relatedChunks.length > 0) e.chunks = g.relatedChunks.slice()
      return e
    })
    t._completed = snap.completed
    t._budgetExhausted = snap.budgetExhausted
    t._turnsUsed = snap.turnsUsed
    t._tokensSpent = snap.tokensSpent
    return t
  }
}
