/**
 * wikify — convert conversational chat content into clean,
 * knowledge-style wiki page body via a single LLM call.
 *
 * Motivation: when a user clicks "Save to Wiki" on an assistant
 * reply, the raw content carries chat-flavoured prose ("Based on
 * the search results...", "I fetched the article and found...",
 * "Here's a summary...", "Let me know if you need more"). Those
 * conversational markers are appropriate for a Q&A reply but turn
 * into noise inside a wiki page — the wiki is the user's curated
 * knowledge base, not a transcript. The wikify pass rewrites the
 * content with the chat scaffolding stripped while preserving every
 * fact, name, number, and structural element.
 *
 * Design notes:
 *
 *   - **One LLM call, low budget**: the output is typically the
 *     same size as input. We cap max_tokens at the request size
 *     and use temperature=0 for determinism.
 *
 *   - **Language preserving**: the prompt explicitly tells the
 *     model to output in the SAME language as the input. We don't
 *     try to detect language client-side — the model does it from
 *     context. If the input is Chinese, the output is Chinese.
 *
 *   - **Lossy fallback**: if the LLM call fails (timeout, abort,
 *     content-filter refusal, anything), wikifyForSave returns the
 *     original content. The user always ends up with SOMETHING in
 *     wiki/queries/ — a failed wikify pass should never lose the
 *     reply. Failures are logged via console.warn for debugging
 *     but never surface as a hard error to the SaveToWiki path.
 *
 *   - **Skip on very short content**: if the input is less than
 *     ~100 chars (single-sentence reply), wikifying is overkill;
 *     return as-is to skip the LLM call entirely.
 *
 *   - **Lazy import**: the streamChat dependency is heavy. Only
 *     load it when actually invoked, so test code that mocks the
 *     module doesn't have to mock streamChat too.
 */
import type { LlmConfig } from "@/stores/wiki-store"

const SKIP_BELOW_CHARS = 100
const WIKIFY_MAX_TOKENS = 4096

const SYSTEM_PROMPT = `You are a wiki-page formatter.

You are given the body of a chat reply that the user has chosen to save into their personal wiki. Your job is to rewrite that body as a CLEAN, knowledge-style wiki page — same facts, no conversational scaffolding.

REMOVE these patterns:

  - First-person commentary: "I found...", "I fetched...", "Based on the search results...", "Looking at the article...", "From what I gathered..."
  - Meta-prose about your process: "Let me know if you need more", "Hope this helps", "Here is a summary of...", "To answer your question..."
  - Citations of your own actions: "I checked the wiki and...", "After web_search returned 5 results..."
  - Bridging fillers: "So,", "Well,", "In short,", "Basically,"

PRESERVE:

  - Every name, number, date, fact, URL, code snippet, table, math expression
  - Markdown structure (headings, lists, bold/italic, code fences)
  - Wikilinks \`[[X]]\` and \`[[X|alias]]\` if present
  - Citations to OTHER sources (URLs, document references) — those are evidence, not chat
  - The language of the original — if input is Chinese, output Chinese; if English, English; mixed stays mixed

REFORMAT:

  - Use H2 / H3 headings for sections (or keep existing ones)
  - Convert "In addition,..." style enumerations into proper lists
  - Front-load each section with the key fact, then supporting detail
  - Aim for an encyclopedic / reference register, not a tutorial / conversational one

OUTPUT:

  - The rewritten markdown ONLY. No preamble like "Here is the rewritten page:". No closing remarks. No code fence wrapping the whole output.
  - Start directly with the first content line (a heading is fine; bare prose is also fine).
  - If the input already reads like a clean wiki page, return it unchanged.`

/**
 * Rewrite a chat reply into wiki-shaped markdown.
 *
 * Returns the original content unchanged when:
 *   - Input is shorter than SKIP_BELOW_CHARS (single-line replies).
 *   - The LLM call fails or returns empty text.
 *   - The signal aborts.
 *
 * Logs a warn to the console on actual failures; the SaveToWiki path
 * treats this function as best-effort and never blocks the save.
 */
export async function wikifyForSave(
  content: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (content.trim().length < SKIP_BELOW_CHARS) return content
  // Cheap synchronous guard: signal already aborted? Skip outright.
  if (signal?.aborted) return content

  let collected = ""
  let hadError = false
  try {
    const { streamChat } = await import("@/lib/llm-client")
    await streamChat(
      llmConfig,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      {
        onToken: (token) => {
          collected += token
        },
        onDone: () => {},
        onError: (err) => {
          hadError = true
          console.warn(
            `[wikify] LLM call failed, falling back to original content: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        },
      },
      signal,
      {
        temperature: 0,
        max_tokens: WIKIFY_MAX_TOKENS,
        reasoning: { mode: "off" },
      },
    )
  } catch (err) {
    console.warn(
      `[wikify] LLM call threw, falling back to original content: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return content
  }
  if (hadError) return content
  const cleaned = collected.trim()
  if (cleaned.length === 0) return content
  // Belt-and-braces: strip a leading "Here is..." or code-fence
  // wrapper if the model ignored the rule. Cheap to do.
  return stripObviousPreamble(cleaned)
}

/**
 * Drop a couple of regression-test artifacts in case the model
 * ignores the output rule. Conservative — only strips if the wrapper
 * is unambiguous (full-line preamble, full-content code fence).
 */
function stripObviousPreamble(text: string): string {
  let out = text
  // Full-content code fence: ```markdown\n...\n``` or ```\n...\n```
  const fenceMatch = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i)
  if (fenceMatch) out = fenceMatch[1].trim()
  // Leading preamble line ending with colon.
  out = out.replace(/^(here'?s the (?:rewritten|cleaned|wiki) (?:page|version|content):?\s*\n+)/i, "")
  out = out.replace(/^(以下是(?:重写后的|改写后的|清理后的)(?:页面|内容):?\s*\n+)/i, "")
  return out.trim()
}
