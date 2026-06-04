/**
 * Dependency-free, script-aware token estimation.
 *
 * Every LLM provider enforces its context window in TOKENS, but we only
 * have the raw text. A flat "characters" proxy is badly wrong across
 * scripts: a BPE tokenizer spends ~1 token on a single CJK ideograph but
 * only ~0.25 tokens on an average Latin character (≈4 chars/token). So a
 * char budget calibrated for English overflows on Chinese and wastes most
 * of the window on English.
 *
 * This module estimates tokens by counting CJK vs. non-CJK characters and
 * applying per-script rates. It is intentionally an ESTIMATE (±~10-20% vs.
 * a real tokenizer) — exact tokenization would mean bundling a per-model
 * tokenizer (tiktoken WASM) or a network round-trip, and would still be
 * wrong for the many third-party OpenAI-compatible endpoints this app
 * targets. The ingest self-healing (shrink/bisect-on-overflow) remains the
 * backstop for the residual error and for providers we can't model.
 *
 * Rates lean conservative-HIGH (we'd rather under-fill than overflow):
 *   - CJK ideographs / kana / hangul / fullwidth: ~1 token per char.
 *   - everything else (Latin, digits, punctuation, whitespace): ~0.25.
 */

const CJK_TOKENS_PER_CHAR = 1
const OTHER_TOKENS_PER_CHAR = 0.25

/**
 * True for code points that a BPE tokenizer typically spends ~1 token on:
 * CJK punctuation + ideographs (incl. Extension A), Hangul, CJK
 * compatibility ideographs, and fullwidth/halfwidth forms.
 */
export function isCjkCharCode(c: number): boolean {
  return (
    (c >= 0x3000 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef)
  )
}

/** Estimated token count for `text` (always ≥ 0, integer). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkCharCode(text.charCodeAt(i))) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR)
}

/** Average characters per token for THIS text's script mix (≥ 1). Used to
 *  turn a token budget into a starting character budget for trimming. */
export function charsPerToken(text: string): number {
  const tokens = estimateTokens(text)
  return tokens > 0 ? Math.max(1, text.length / tokens) : 4
}

/** Convert a token budget into an equivalent character count, given a
 *  representative `sampleText` for the script mix (defaults to Latin's
 *  ~4 chars/token when no sample is provided). */
export function tokensToChars(maxTokens: number, sampleText = ""): number {
  if (maxTokens <= 0) return 0
  const cpt = sampleText ? charsPerToken(sampleText) : 4
  return Math.floor(maxTokens * cpt)
}

const TOKEN_TRIM_MARKER = "\n\n[...trimmed for token budget...]"

/**
 * Trim `text` so its estimated token count (including the trim marker) is
 * ≤ `maxTokens`. Returns `text` unchanged when it already fits. Starts from
 * a proportional character cut (using the text's own script mix) and shaves
 * further if the tail is denser than the head, so the result reliably lands
 * under budget without a char-by-char scan.
 */
export function trimToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ""
  if (estimateTokens(text) <= maxTokens) return text
  const markerTokens = estimateTokens(TOKEN_TRIM_MARKER)
  const target = Math.max(0, maxTokens - markerTokens)
  let charBudget = tokensToChars(target, text)
  let out = text.slice(0, charBudget)
  // Refine down if the kept prefix is denser (more CJK) than the average.
  let guard = 0
  while (out.length > 0 && estimateTokens(out) > target && guard < 64) {
    charBudget = Math.floor(charBudget * 0.9)
    out = text.slice(0, charBudget)
    guard++
  }
  return out.trimEnd() + TOKEN_TRIM_MARKER
}
