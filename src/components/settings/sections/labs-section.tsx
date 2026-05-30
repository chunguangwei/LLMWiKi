import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { saveExperimentalAgentIngest } from "@/lib/project-store"

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
            className={`text-xs font-semibold ${
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

      <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
        {t("settings.sections.labs.disclaimer", {
          defaultValue:
            "Labs features may change shape, lose toggle state, or be removed without a version bump. They are NOT covered by the auto-update's compatibility guarantees.",
        })}
      </p>
    </div>
  )
}
