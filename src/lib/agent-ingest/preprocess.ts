/**
 * Source pre-processing for an agent-ingest run.
 *
 * Given a markdown source on disk, prepare the data structures the
 * runner needs: chunked text, line-range index, outline tree,
 * stable chunk ids. Cheap operations only — no LLM calls here
 * (Phase B's runner is where the model enters the loop). Vector
 * embeddings are also deferred; Phase C.3 wires the index after
 * pre-process so the runner can call search_source.
 *
 * What this does NOT do:
 *
 *   - Read the source's `## Context` sidecar. That's the chat-
 *     ingest convention; agent ingest reads the file verbatim.
 *   - Strip frontmatter from the chunked text. chunkMarkdown
 *     already does that internally (stripFrontmatter), so the
 *     outline parser sees the body too — keeps the chunk content
 *     and outline aligned on line numbers.
 *   - Embed the chunks. embedSourceChunks() in vector-index.ts is
 *     called separately by the run entry so this function stays
 *     synchronous-friendly for tests.
 *
 * Determinism: same source bytes → same chunk ids and same
 * outline. The runner can rely on chunk_id stability across
 * resume / replay; checkpoints in Phase E key on (sourceHash,
 * chunk_id) tuples.
 */
import type { SourceChunk, OutlineHeading } from "./types"
import {
  extractOutlineFromMarkdown,
  associateOutlineWithChunks,
} from "./source-outline"
import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"

export interface PreprocessResult {
  chunks: Map<string, SourceChunk>
  /** Sorted by chunk_id for stable iteration. Same data as the map,
   *  exposed as an array for the agent's read_outline → chunk_id
   *  references and the vector index builder. */
  chunkList: SourceChunk[]
  outline: OutlineHeading[]
  /** SHA-256 hex of the original source bytes — used as the
   *  checkpoint key so a re-edited source invalidates a stale
   *  resume. */
  sourceHash: string
  totalLines: number
}

export interface PreprocessOptions {
  /** Forwarded to chunkMarkdown — see lib/text-chunker.ts for shape.
   *  Defaults to chunkMarkdown's own defaults (targetChars=1000,
   *  maxChars=1500, minChars=200, overlapChars=200) which work
   *  well for prose and code-light markdown sources. */
  chunkingOptions?: Parameters<typeof chunkMarkdown>[1]
}

/**
 * Run pre-processing on raw source content. Pure function — no
 * I/O. The caller (Phase C.3's runAgentIngest) reads the file and
 * hands the bytes in.
 */
export async function preprocessSource(
  content: string,
  options: PreprocessOptions = {},
): Promise<PreprocessResult> {
  const sourceHash = await sha256Hex(content)
  const rawChunks = chunkMarkdown(content, options.chunkingOptions)
  const totalLines = countLines(content)

  // Build line-index once so each chunk's char→line conversion is
  // O(log n) rather than O(n). For a 100k-char source that's a
  // 20× speedup at chunk count > 50.
  const newlinePositions = buildNewlineIndex(content)

  const indexedChunks: SourceChunk[] = rawChunks.map((c, i, all) =>
    toSourceChunk(c, i, all.length, newlinePositions),
  )
  const chunks = new Map<string, SourceChunk>()
  for (const c of indexedChunks) chunks.set(c.chunk_id, c)

  // Outline parsed from the FULL source content (not chunked
  // text) so line numbers stay aligned. associateOutlineWithChunks
  // then stamps each heading with the chunk_id whose line range
  // contains it.
  const rawOutline = extractOutlineFromMarkdown(content)
  const outline: OutlineHeading[] = associateOutlineWithChunks(
    rawOutline,
    indexedChunks,
  )

  return {
    chunks,
    chunkList: indexedChunks,
    outline,
    sourceHash,
    totalLines,
  }
}

/* ────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────*/

function toSourceChunk(
  raw: Chunk,
  index: number,
  total: number,
  newlinePositions: number[],
): SourceChunk {
  const startLine = charOffsetToLine(raw.charStart, newlinePositions)
  // End line is INCLUSIVE — the line where the chunk's last
  // character lives. Subtract 1 if the chunk ends exactly at a
  // newline so we don't claim the next-empty line as part of
  // this chunk.
  const endLine = Math.max(
    startLine,
    charOffsetToLine(Math.max(raw.charStart, raw.charEnd - 1), newlinePositions),
  )
  return {
    chunk_id: formatChunkId(index),
    line_range: [startLine, endLine],
    content: raw.text,
    ...(index > 0 ? { prev_chunk_id: formatChunkId(index - 1) } : {}),
    ...(index < total - 1 ? { next_chunk_id: formatChunkId(index + 1) } : {}),
  }
}

/** chunk_id format: `c<index>` (c0, c1, …). Short for prompt
 *  efficiency — the LLM ships these back over the wire on every
 *  read_chunk / mark_section_covered call. */
function formatChunkId(index: number): string {
  return `c${index}`
}

function countLines(content: string): number {
  // Empty file → 0 lines; one line of content → 1 line; trailing
  // newline doesn't add a phantom line.
  if (content.length === 0) return 0
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) count++
  }
  // If the file ends with \n, the count above includes a final
  // empty line — drop it.
  if (content.charCodeAt(content.length - 1) === 0x0a) count--
  return Math.max(count, 1)
}

function buildNewlineIndex(content: string): number[] {
  const positions: number[] = []
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) positions.push(i)
  }
  return positions
}

/**
 * Translate a 0-based character offset into a 1-based line number
 * using the pre-built newline-position index. O(log n).
 */
function charOffsetToLine(
  offset: number,
  newlinePositions: number[],
): number {
  if (offset <= 0) return 1
  // Binary search for the first newline AT OR AFTER `offset`. The
  // 1-based line number is then (that index) + 1, because
  // newlines BEFORE offset already terminate prior lines.
  let lo = 0
  let hi = newlinePositions.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (newlinePositions[mid] < offset) lo = mid + 1
    else hi = mid
  }
  // `lo` is the count of newlines strictly before offset → the
  // 1-based line is lo + 1.
  return lo + 1
}

/**
 * SHA-256 of the source content as a hex string. Uses crypto.subtle
 * which is available in both Tauri's webview and Node's test
 * runner (Node 19+ exposes webcrypto on globalThis.crypto).
 */
export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
