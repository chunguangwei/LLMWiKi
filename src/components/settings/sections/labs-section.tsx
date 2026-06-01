import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import {
  saveExperimentalAgentIngest,
  saveExperimentalAiLintFix,
  saveExperimentalChatAgent,
  saveExperimentalChatAgentCanWrite,
  saveExperimentalRawSaveToWiki,
  saveExperimentalIndexAnnotations,
  saveExperimentalIngestPreview,
} from "@/lib/project-store"

/**
 * Labs / experimental features.
 *
 * Lives outside the shared `draft` machinery because each toggle in
 * here persists IMMEDIATELY (no global Save button required) — an
 * experimental feature should be one click to opt in, one click to
 * opt out, no extra ceremony. The toggle's setter writes to the
 * Tauri store right alongside updating the Zustand state so a reload
 * or a Rust-side restart picks up the new value.
 *
 * Why this section is BELOW the substantive ones in the categories
 * list: discoverable for users who want to opt in, not in the way of
 * users who'd rather not know about half-baked features.
 */
export function LabsSection() {
  const { t } = useTranslation()
  const agentIngest = useWikiStore((s) => s.experimentalAgentIngest)
  const setAgentIngest = useWikiStore((s) => s.setExperimentalAgentIngest)
  const aiLintFix = useWikiStore((s) => s.experimentalAiLintFix)
  const setAiLintFix = useWikiStore((s) => s.setExperimentalAiLintFix)
  const chatAgent = useWikiStore((s) => s.experimentalChatAgent)
  const chatAgentCanWrite = useWikiStore((s) => s.experimentalChatAgentCanWrite)
  const setChatAgentCanWrite = useWikiStore((s) => s.setExperimentalChatAgentCanWrite)
  const setChatAgent = useWikiStore((s) => s.setExperimentalChatAgent)
  const rawSaveToWiki = useWikiStore((s) => s.experimentalRawSaveToWiki)
  const indexAnnotations = useWikiStore((s) => s.experimentalIndexAnnotations)
  const setIndexAnnotations = useWikiStore((s) => s.setExperimentalIndexAnnotations)
  const ingestPreview = useWikiStore((s) => s.experimentalIngestPreview)
  const setIngestPreview = useWikiStore((s) => s.setExperimentalIngestPreview)
  const setRawSaveToWiki = useWikiStore((s) => s.setExperimentalRawSaveToWiki)

  function toggleAgentIngest() {
    const next = !agentIngest
    setAgentIngest(next)
    // Persist immediately. Failure is non-fatal — the in-memory
    // state still reflects the user's choice for this session,
    // and the next reload will silently fall back to default off
    // (which is fine for an opt-in feature).
    saveExperimentalAgentIngest(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  function toggleAiLintFix() {
    const next = !aiLintFix
    setAiLintFix(next)
    saveExperimentalAiLintFix(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  function toggleChatAgent() {
    const next = !chatAgent
    setChatAgent(next)
    saveExperimentalChatAgent(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
    // Turning off the parent flag also implicitly disables the
    // write-tool sub-flag in memory + on disk. Avoids a stale state
    // where chat is back to streaming mode but the agent still
    // technically has write tools "queued" — which would only matter
    // if the user re-enables chat-agent later but is easier to reason
    // about if we just clear both.
    if (!next && chatAgentCanWrite) {
      setChatAgentCanWrite(false)
      saveExperimentalChatAgentCanWrite(false).catch((err) =>
        console.warn("[labs] save failed:", err),
      )
    }
  }

  function toggleChatAgentCanWrite() {
    const next = !chatAgentCanWrite
    setChatAgentCanWrite(next)
    saveExperimentalChatAgentCanWrite(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  function toggleRawSaveToWiki() {
    const next = !rawSaveToWiki
    setRawSaveToWiki(next)
    saveExperimentalRawSaveToWiki(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  function toggleIndexAnnotations() {
    const next = !indexAnnotations
    setIndexAnnotations(next)
    saveExperimentalIndexAnnotations(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  function toggleIngestPreview() {
    const next = !ingestPreview
    setIngestPreview(next)
    saveExperimentalIngestPreview(next).catch((err) =>
      console.warn("[labs] save failed:", err),
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.labs.title", { defaultValue: "Labs (Experimental)" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.labs.description", {
            defaultValue:
              "Features that aren't validated for general use yet. Opt in if you want to help shake them out; opt out anytime — your data and settings are unaffected.",
          })}
        </p>
      </div>

      {/* Agent ingest toggle. Same emerald-accent convention as the
          Vision / Image OCR toggle so the "active experimental feature"
          state is visually consistent across labs sections. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          agentIngest
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.agentIngestLabel", {
              defaultValue: "Agent ingest (experimental)",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.agentIngestHint", {
              defaultValue:
                "Shows a 🤖 button next to each source file. A multi-turn LLM agent reads the source via tool calls (read_chunk / search_source) and writes wiki pages (write_wiki_page / update_wiki_page) — vs the classic single-shot analyse + generate pipeline. Costs more tokens. Quality not yet validated on long real-world docs; uncovered topics surface as Review items.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleAgentIngest}
          role="switch"
          aria-checked={agentIngest}
          aria-label={t("settings.sections.labs.agentIngestLabel", {
            defaultValue: "Agent ingest (experimental)",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              agentIngest
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {agentIngest
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              agentIngest ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                agentIngest ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* AI lint fix toggle. Same emerald accent as agent-ingest above. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          aiLintFix
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.aiLintFixLabel", {
              defaultValue: "AI lint fix (experimental)",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.aiLintFixHint", {
              defaultValue:
                "Replaces the lint Fix button's hardcoded actions (orphan → append to index.md, broken-link → push to Review) with an LLM mini-agent that decides per-item how to repair the wiki — fixing the link, cross-linking the orphan to topic-adjacent pages, adding wikilinks to a no-outlinks page. Costs LLM tokens per click; falls back to classic fix if the agent fails.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleAiLintFix}
          role="switch"
          aria-checked={aiLintFix}
          aria-label={t("settings.sections.labs.aiLintFixLabel", {
            defaultValue: "AI lint fix (experimental)",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              aiLintFix
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {aiLintFix
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              aiLintFix ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                aiLintFix ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* Chat agent toggle. Same emerald accent as the other Labs toggles. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          chatAgent
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.chatAgentLabel", {
              defaultValue: "Chat agent (experimental)",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.chatAgentHint", {
              defaultValue:
                "Upgrades chat from a single-turn stream into a tool-calling agent. When the LLM needs info it can call web_fetch (any URL, zero config), web_search (your configured Tavily / SerpApi / SearXNG / Ollama), search_local_files (project-scoped), and wiki inspection tools. Costs more tokens and drops the per-token streaming UX in agent mode — the first response arrives as a complete block once the agent finishes its tool calls.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleChatAgent}
          role="switch"
          aria-checked={chatAgent}
          aria-label={t("settings.sections.labs.chatAgentLabel", {
            defaultValue: "Chat agent (experimental)",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              chatAgent
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {chatAgent
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              chatAgent ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                chatAgent ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* Chat-agent write tools — depends on the Chat agent flag.
          Kept at the same horizontal alignment as sibling cards
          (no `ml-6` indent) so the toggle column stays a clean
          vertical line; the dependency is signalled inline with a
          "↳" prefix on the label + dashed border + opacity when the
          parent flag is off. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          !chatAgent
            ? "border-dashed border-border bg-muted/20 opacity-60"
            : chatAgentCanWrite
              ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
              : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            <span className="mr-1 text-muted-foreground">↳</span>
            {t("settings.sections.labs.chatAgentCanWriteLabel", {
              defaultValue: "Chat agent can write wiki pages (experimental)",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.chatAgentCanWriteHint", {
              defaultValue:
                "Adds write_wiki_page + update_wiki_page to the chat agent's tools. Use this when you want the agent to create / update pages directly from chat (\"save this as a wiki page\", \"update concepts/foo with this\"). The prompt rails it to write ONLY when you explicitly ask. delete + link tools are NOT included — those stay in ingest / lint-fix paths. Requires Chat agent ON.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleChatAgentCanWrite}
          role="switch"
          aria-checked={chatAgentCanWrite}
          disabled={!chatAgent}
          aria-label={t("settings.sections.labs.chatAgentCanWriteLabel", {
            defaultValue: "Chat agent can write wiki pages (experimental)",
          })}
          className="ml-3 flex shrink-0 items-center gap-2 disabled:cursor-not-allowed"
          title={
            !chatAgent
              ? t("settings.sections.labs.chatAgentCanWriteParentOff", {
                  defaultValue: "Enable Chat agent first to use this sub-flag.",
                })
              : undefined
          }
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              chatAgentCanWrite
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {chatAgentCanWrite
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              chatAgentCanWrite ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                chatAgentCanWrite ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* Raw Save-to-Wiki toggle. Skips the wikify LLM rewrite pass
          when ON; persists the agent's reply verbatim. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          rawSaveToWiki
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.rawSaveToWikiLabel", {
              defaultValue: "Raw Save to Wiki — skip wikify rewrite",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.rawSaveToWikiHint", {
              defaultValue:
                "By default, Save to Wiki sends the chat reply through a short LLM rewrite that strips conversational tone (\"Based on...\", \"Here's a summary...\") before writing the page. Turn this on to skip that pass and persist the reply verbatim — useful for record-keeping, code-heavy answers, or content where the rewrite over-edits. autoIngest and raw source preservation continue to run either way.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleRawSaveToWiki}
          role="switch"
          aria-checked={rawSaveToWiki}
          aria-label={t("settings.sections.labs.rawSaveToWikiLabel", {
            defaultValue: "Raw Save to Wiki — skip wikify rewrite",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              rawSaveToWiki
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {rawSaveToWiki
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              rawSaveToWiki ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                rawSaveToWiki ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* Index LLM annotations. After every reconcile (including the
          autoIngest tail), batch-call the LLM to write a one-line
          description for each undescribed index.md bullet. Cached by
          body hash so unchanged pages don't re-spend tokens. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          indexAnnotations
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.indexAnnotationsLabel", {
              defaultValue: "LLM-annotated index.md descriptions",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.indexAnnotationsHint", {
              defaultValue:
                "After every reconcile / autoIngest, batch-call the LLM to write a one-line description for each index.md bullet that doesn't have one yet. Descriptions are cached by page body hash so unchanged pages don't re-spend tokens. Cost: ~one LLM call per ~25 newly-written pages. Idempotent; safe to leave on.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleIndexAnnotations}
          role="switch"
          aria-checked={indexAnnotations}
          aria-label={t("settings.sections.labs.indexAnnotationsLabel", {
            defaultValue: "LLM-annotated index.md descriptions",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              indexAnnotations
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {indexAnnotations
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              indexAnnotations ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                indexAnnotations ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {/* Ingest preview gate. When ON, autoIngest pauses between LLM
          generation and disk writes to show a preview dialog. Tokens
          are spent regardless of the user's choice; the gate prevents
          disk damage from a misguided LLM split. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          ingestPreview
            ? "border-emerald-500/60 bg-emerald-500/10 dark:border-emerald-400/50 dark:bg-emerald-400/10"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.labs.ingestPreviewLabel", {
              defaultValue: "Preview autoIngest writes before applying",
            })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.labs.ingestPreviewHint", {
              defaultValue:
                "Every autoIngest pauses after the LLM stage with a dialog listing the files about to be written. Click Apply to commit or Cancel to skip — no disk writes either way until you confirm. LLM tokens are spent regardless; the gate exists to catch misguided splits / wrong slugs before they pollute the wiki.",
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleIngestPreview}
          role="switch"
          aria-checked={ingestPreview}
          aria-label={t("settings.sections.labs.ingestPreviewLabel", {
            defaultValue: "Preview autoIngest writes before applying",
          })}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`inline-block w-6 text-right text-xs font-semibold ${
              ingestPreview
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground"
            }`}
          >
            {ingestPreview
              ? t("settings.sections.labs.stateOn", { defaultValue: "ON" })
              : t("settings.sections.labs.stateOff", { defaultValue: "OFF" })}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              ingestPreview ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                ingestPreview ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
        {t("settings.sections.labs.disclaimer", {
          defaultValue:
            "Labs features may change shape, lose toggle state, or be removed without a version bump. They are NOT covered by the auto-update's compatibility guarantees.",
        })}
      </p>
    </div>
  )
}
