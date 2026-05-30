/**
 * Simple keyword-overlap VectorIndex for Phase C.
 *
 * The real plan is LanceDB-backed semantic search (the existing
 * embedding.ts wires chunk → vector → ANN lookup). For the first
 * end-to-end agent run we use a BM25-flavoured keyword ranker
 * instead, because:
 *
 *   - It's deterministic — no LLM calls, no embedding cache
 *     warm-up, repeatable across test runs.
 *   - It's zero-config — works on a fresh project without an
 *     embedding endpoint configured.
 *   - It produces good-enough results for the agent's common
 *     "find sections about X" queries when X is a domain term
 *     that appears literally in the source.
 *
 * The seam (KeywordVectorIndex implements VectorIndex) is the
 * same one a future EmbeddingVectorIndex will implement, so
 * swapping is a one-line createAgentLlm-style factory pick.
 *
 * Scoring formula (BM25 with idf flattening):
 *
 *   tf  = count of query token in chunk
 *   idf = log((N - df + 0.5) / (df + 0.5) + 1)   where N=corpus size,
 *                                                 df=#chunks containing token
 *   score = Σ over query tokens of idf * (tf * (k1+1)) / (tf + k1 * (1 - b + b * |chunk|/avgLen))
 *
 * Defaults: k1=1.2, b=0.75 — standard BM25 picks; tuned for
 * "find passages relevant to a topic" rather than "find exact
 * phrases" (which we'd do with a phrase search instead).
 *
 * Tokenisation: lowercase, split on non-word + CJK boundaries.
 * Min token length 2 to drop "is" / "a" noise. CJK characters
 * are kept as single-character tokens so 中文 sources actually
 * index — empty filter for ASCII-only would have been a silent
 * bug on the user's primary corpus.
 */
import type { VectorIndex, SourceChunk } from "./types"

const BM25_K1 = 1.2
const BM25_B = 0.75
const MIN_TOKEN_LEN = 2

export class KeywordVectorIndex implements VectorIndex {
  private readonly tokenCount = new Map<string, number>()  // df: chunks-containing
  private readonly perChunkTokens = new Map<string, Map<string, number>>()  // chunk_id → tf map
  private readonly chunkLengths = new Map<string, number>()  // chunk_id → token count
  private readonly avgLength: number

  constructor(chunks: SourceChunk[]) {
    let totalLen = 0
    for (const c of chunks) {
      const tokens = tokenise(c.content)
      const tf = new Map<string, number>()
      const seen = new Set<string>()
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1)
        if (!seen.has(t)) {
          seen.add(t)
          this.tokenCount.set(t, (this.tokenCount.get(t) ?? 0) + 1)
        }
      }
      this.perChunkTokens.set(c.chunk_id, tf)
      this.chunkLengths.set(c.chunk_id, tokens.length)
      totalLen += tokens.length
    }
    this.avgLength = chunks.length > 0 ? totalLen / chunks.length : 1
  }

  async search(query: string, topK: number): Promise<Array<{ chunk_id: string; score: number }>> {
    const queryTokens = tokenise(query)
    if (queryTokens.length === 0) return []
    const N = this.perChunkTokens.size
    if (N === 0) return []

    const results: Array<{ chunk_id: string; score: number }> = []
    for (const [chunk_id, tf] of this.perChunkTokens) {
      const chunkLen = this.chunkLengths.get(chunk_id) ?? 1
      let score = 0
      for (const term of queryTokens) {
        const termTf = tf.get(term) ?? 0
        if (termTf === 0) continue
        const df = this.tokenCount.get(term) ?? 0
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
        const norm = 1 - BM25_B + BM25_B * (chunkLen / this.avgLength)
        score += idf * (termTf * (BM25_K1 + 1)) / (termTf + BM25_K1 * norm)
      }
      if (score > 0) results.push({ chunk_id, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }
}

/**
 * Lowercase + split-on-non-word tokeniser with CJK awareness.
 *
 *   - Latin / digits: contiguous \w+ runs (≥ MIN_TOKEN_LEN)
 *   - CJK (`一-鿿` — covers CJK Unified Ideographs, the bulk of
 *     Chinese / Japanese / Korean Han): each character is its own
 *     token. Chinese has no spaces and rarely yields multi-char
 *     "words" without a segmenter, so per-char gets us a usable
 *     baseline; users with serious CJK volumes would swap in a
 *     proper tokeniser.
 */
function tokenise(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  // Latin/digit words.
  const ascii = lower.match(/[a-z0-9_]+/g) ?? []
  for (const t of ascii) {
    if (t.length >= MIN_TOKEN_LEN) out.push(t)
  }
  // CJK single chars. /[一-鿿]/g matches Han characters.
  const cjk = lower.match(/[一-鿿]/g) ?? []
  for (const t of cjk) out.push(t)
  return out
}
