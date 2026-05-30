/**
 * Verify pass — runs once at the end of an agent ingest.
 *
 * The agent's `mark_section_covered` calls give us a chunk-level
 * coverage measurement, but the agent is also the one deciding
 * what counts as "covered" — there's no second opinion. The verify
 * pass IS that second opinion: a single LLM call that looks at
 * (source outline + wiki pages written) and says "for each
 * heading, did extraction actually capture its content?"
 *
 * Any heading the verifier flags as un-covered becomes a tracker
 * gap, which Phase E.3 turns into a Review item. The user then
 * decides: re-run the agent, edit by hand, or dismiss as out of
 * scope.
 *
 * Why a separate LLM call (vs. trusting the agent's own
 * mark_section_covered):
 *
 *   - Independence — the verifier judges the END STATE (wiki
 *     pages) against the SOURCE (outline), without seeing the
 *     agent's tool calls. That catches "agent marked covered but
 *     never wrote the page" and "agent wrote the page but it's
 *     about a different topic than the heading suggests".
 *   - Cheap — one call, low max_tokens, no tools. Even on a slow
 *     model the wall-clock impact is < 5 seconds.
 *
 * Skipped when:
 *   - The agent stopped via abort or runtime error (no end state
 *     to verify — partial wiki is meaningless to a verifier).
 *   - max_tokens / max_turns budget exhausted (we'd burn a verify
 *     call on a knowingly-partial run that the next resume will
 *     fix).
 *   - Outline is empty (no headings → nothing to verify against;
 *     the agent's surface_gap calls already cover this case).
 *
 * Failure handling: a verify-call error is logged but does NOT
 * fail the run. The agent's existing gaps are returned as-is.
 * Verify is a quality improvement, not a correctness requirement.
 */
import type { AgentLlm } from "./llm-interface"
import type {
  AgentContext,
  CoverageTracker,
  OutlineHeading,
} from "./types"
import type { RunAgentLoopResult } from "./runner"

export interface VerifyPassOpts {
  llm: AgentLlm
  ctx: AgentContext
  /** Source path — passed to the verifier prompt for context. */
  sourcePath: string
  /** Outline at pre-process time — what we expected the agent to
   *  consider. The verifier walks this list. */
  outline: OutlineHeading[]
  /** Pages the agent wrote / extended (from tracker.createdPages
   *  + tracker.updatedPages). */
  pagesCreated: Array<{ slug: string; fromChunks: string[] }>
  pagesUpdated: Array<{ slug: string; fromChunks: string[] }>
  /** Loop's stop reason — verify is SKIPPED on abort / error /
   *  budget. */
  stopReason: RunAgentLoopResult["stopReason"]
  signal: AbortSignal
}

export interface VerifyPassResult {
  /** True when verify ran. False when it was skipped (and why is in
   *  `skipReason`). */
  ran: boolean
  /** Number of gaps the verifier added to the tracker. */
  gapsAdded: number
  /** Verbatim from the verifier's prose. Useful for the activity
   *  log + debugging. Empty when verify was skipped. */
  rawReply?: string
  skipReason?: "aborted" | "error_state" | "budget" | "no_outline"
  errorMessage?: string
}

const MAX_REPLY_TOKENS = 1500
const TEMPERATURE = 0

export async function runVerifyPass(opts: VerifyPassOpts): Promise<VerifyPassResult> {
  // Skip rules — see module docstring for rationale.
  if (opts.stopReason === "aborted") {
    return { ran: false, gapsAdded: 0, skipReason: "aborted" }
  }
  if (opts.stopReason === "max_tokens" || opts.stopReason === "max_turns") {
    return { ran: false, gapsAdded: 0, skipReason: "budget" }
  }
  if (opts.outline.length === 0) {
    return { ran: false, gapsAdded: 0, skipReason: "no_outline" }
  }

  const systemPrompt = buildVerifySystemPrompt()
  const userPrompt = buildVerifyUserPrompt(opts)

  let reply = ""
  try {
    const turn = await opts.llm.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      [],  // no tools — verifier replies with text-only JSON
      opts.signal,
      { temperature: TEMPERATURE, max_tokens: MAX_REPLY_TOKENS },
    )
    reply = turn.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
  } catch (err) {
    return {
      ran: false,
      gapsAdded: 0,
      skipReason: "error_state",
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }

  const gaps = parseVerifyReply(reply)
  for (const g of gaps) {
    // Per-heading gap. chunks anchor optional — verifier may or may
    // not include the chunk_id; if present and known, surface_gap
    // attaches it for the user's follow-up.
    const chunks = g.chunk_id && opts.ctx.chunks.has(g.chunk_id) ? [g.chunk_id] : undefined
    surface(opts.ctx.tracker, g.topic, g.reason, chunks)
  }
  return { ran: true, gapsAdded: gaps.length, rawReply: reply }
}

/* ────────────────────────────────────────────────
 * Prompt
 * ────────────────────────────────────────────────*/

function buildVerifySystemPrompt(): string {
  return [
    "You are a verifier for a wiki-ingestion agent. Another LLM was given a " +
      "source document and a set of tools; it wrote some wiki pages. Your job " +
      "is to judge whether each top-level section of the source outline ended " +
      "up represented in those wiki pages.",
    "",
    "Standard for 'covered': the wiki must contain the substance of the " +
      "section — its key claims, entities, or arguments — even paraphrased. " +
      "An aside or one-line mention does NOT count as covering a whole section.",
    "",
    "Standard for 'gap': a section whose content is not represented at all, " +
      "OR is misrepresented (the wiki page on this topic exists but is about " +
      "something else).",
    "",
    "Respond with a single JSON object of shape:",
    '  {"gaps": [{"heading": "...", "chunk_id": "...", "reason": "..."}]}',
    "",
    "Empty array means everything is covered. Keep `reason` short and concrete: " +
      "'no page covers this section' / 'page X exists but only mentions this in passing' / " +
      "'this material is split across two pages neither of which is centred on it'.",
    "",
    "Do not output anything outside the JSON object — no preamble, no markdown code fence.",
  ].join("\n")
}

function buildVerifyUserPrompt(opts: VerifyPassOpts): string {
  return [
    `Source: \`${opts.sourcePath}\``,
    "",
    "## Source outline",
    "",
    renderOutline(opts.outline),
    "",
    "## Wiki pages the agent produced",
    "",
    renderPages(opts.pagesCreated, opts.pagesUpdated),
    "",
    "Identify the gaps per the standard in the system prompt and respond with " +
      "the JSON object.",
  ].join("\n")
}

function renderOutline(outline: OutlineHeading[]): string {
  return outline
    .map((h) => {
      const indent = "  ".repeat(Math.max(0, h.level - 1))
      return `${indent}- ${"#".repeat(h.level)} ${h.text} (chunk \`${h.chunk_id}\`, line ${h.line_start})`
    })
    .join("\n")
}

function renderPages(
  created: VerifyPassOpts["pagesCreated"],
  updated: VerifyPassOpts["pagesUpdated"],
): string {
  if (created.length === 0 && updated.length === 0) {
    return "_The agent did not write or update any wiki pages. The whole source is presumed uncovered._"
  }
  const lines: string[] = []
  for (const p of created) {
    lines.push(
      `- **created** \`${p.slug}\`${p.fromChunks.length > 0 ? ` (from chunks: ${p.fromChunks.join(", ")})` : ""}`,
    )
  }
  for (const p of updated) {
    lines.push(
      `- **updated** \`${p.slug}\`${p.fromChunks.length > 0 ? ` (from chunks: ${p.fromChunks.join(", ")})` : ""}`,
    )
  }
  return lines.join("\n")
}

/* ────────────────────────────────────────────────
 * Reply parsing
 * ────────────────────────────────────────────────*/

/**
 * Parse the verifier's JSON reply tolerantly.
 *
 * The system prompt asks for raw JSON without preamble, but LLMs
 * occasionally add a `\`\`\`json` fence or a courteous "Here is my
 * verification:" before the object. We strip those and look for the
 * first balanced `{...}` block to parse.
 *
 * Returns [] on any parse / shape failure — verify is best-effort
 * quality, not correctness; a bad JSON reply shouldn't propagate
 * "verify crashed" up to the user.
 */
function parseVerifyReply(reply: string): Array<{
  topic: string
  chunk_id?: string
  reason: string
}> {
  if (!reply.trim()) return []
  let candidate = reply.trim()
  // Strip code fence if present.
  const fenceMatch = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i)
  if (fenceMatch) candidate = fenceMatch[1].trim()
  // Find first `{` — anything before is preamble.
  const firstBrace = candidate.indexOf("{")
  if (firstBrace < 0) return []
  candidate = candidate.slice(firstBrace)
  // Find matching last `}` — anything after is trailing prose.
  const lastBrace = candidate.lastIndexOf("}")
  if (lastBrace < 0) return []
  candidate = candidate.slice(0, lastBrace + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const gapsField = (parsed as Record<string, unknown>).gaps
  if (!Array.isArray(gapsField)) return []
  const out: Array<{ topic: string; chunk_id?: string; reason: string }> = []
  for (const item of gapsField) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    const topic =
      typeof it.heading === "string" && it.heading.trim().length > 0
        ? it.heading.trim()
        : typeof it.topic === "string" && it.topic.trim().length > 0
          ? it.topic.trim()
          : null
    const reason =
      typeof it.reason === "string" && it.reason.trim().length > 0
        ? it.reason.trim()
        : "verifier flagged this section as not covered"
    if (!topic) continue
    const chunk_id = typeof it.chunk_id === "string" ? it.chunk_id : undefined
    out.push({ topic, chunk_id, reason })
  }
  return out
}

function surface(
  tracker: CoverageTracker,
  topic: string,
  reason: string,
  chunks?: string[],
): void {
  tracker.surfaceGap(topic, { reason, ...(chunks ? { chunks } : {}) })
}
