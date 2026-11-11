import { useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { JevConfig } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

/** Fixed official OpenRouter decisions endpoint used when provider is "openrouter". */
export const OPENROUTER_JEV_BASE_URL = "https://openrouter.ai/api/alpha/decisions"

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; ok: boolean; message: string }

/** Resolve the effective base URL: fixed for OpenRouter, editable for custom. */
export function jevBaseUrlForDraft(draft: Pick<SettingsDraft, "jevProvider" | "jevBaseUrl">): string {
  return draft.jevProvider === "openrouter" ? OPENROUTER_JEV_BASE_URL : draft.jevBaseUrl
}

export function JevSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })

  const draftJevConfig: JevConfig = {
    enabled: draft.jevEnabled,
    provider: draft.jevProvider,
    baseUrl: jevBaseUrlForDraft(draft),
    model: draft.jevModel,
    apiKey: draft.jevApiKey,
    auth: draft.jevAuth,
  }

  async function runHealthCheck() {
    setTestState({ kind: "running" })
    try {
      const result = await invoke<string>("jev_health_check", { config: draftJevConfig })
      const message = typeof result === "string" && result.trim()
        ? result
        : t("settings.sections.jev.testSuccess")
      setTestState({ kind: "done", ok: true, message })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTestState({ kind: "done", ok: false, message })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.jev.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.jev.description")}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <div className="text-sm font-medium">{t("settings.sections.jev.enableLabel")}</div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.jev.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("jevEnabled", !draft.jevEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            draft.jevEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              draft.jevEnabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {draft.jevEnabled && (
        <>
          <div className="space-y-2">
            <Label>{t("settings.sections.jev.provider")}</Label>
            <div className="space-y-1 pl-1">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={draft.jevProvider === "openrouter"}
                  onChange={() => {
                    setDraft("jevProvider", "openrouter")
                    setTestState({ kind: "idle" })
                  }}
                  className="h-4 w-4"
                />
                <span className="text-sm">
                  {t("settings.sections.jev.providerOpenrouter")}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={draft.jevProvider === "custom"}
                  onChange={() => {
                    setDraft("jevProvider", "custom")
                    setTestState({ kind: "idle" })
                  }}
                  className="h-4 w-4"
                />
                <span className="text-sm">
                  {t("settings.sections.jev.providerCustom")}
                </span>
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.jev.baseUrl")}</Label>
            <Input
              value={jevBaseUrlForDraft(draft)}
              onChange={(e) => setDraft("jevBaseUrl", e.target.value)}
              readOnly={draft.jevProvider === "openrouter"}
              placeholder="https://example.com/kev-4b"
              className={draft.jevProvider === "openrouter" ? "bg-muted/50" : undefined}
            />
            <p className="text-xs text-muted-foreground">
              {draft.jevProvider === "openrouter"
                ? t("settings.sections.jev.openrouterHint")
                : t("settings.sections.jev.baseUrlHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.jev.model")}</Label>
            <Input
              value={draft.jevModel}
              onChange={(e) => setDraft("jevModel", e.target.value)}
              placeholder={draft.jevProvider === "custom" ? "kev-latest" : "typesafe/jev-1.13"}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.jev.modelHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.jev.apiKey")}</Label>
            <Input
              type="password"
              value={draft.jevApiKey}
              onChange={(e) => setDraft("jevApiKey", e.target.value)}
              placeholder={t("settings.sections.jev.apiKeyPlaceholder")}
            />
          </div>

          {draft.jevProvider === "custom" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.jev.auth")}</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={draft.jevAuth}
                onChange={(e) =>
                  setDraft("jevAuth", e.target.value as SettingsDraft["jevAuth"])
                }
              >
                <option value="bearer">{t("settings.sections.jev.authBearer")}</option>
                <option value="none">{t("settings.sections.jev.authNone")}</option>
              </select>
            </div>
          )}

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">
                {t("settings.sections.jev.testHeading")}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.sections.jev.testHeadingHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runHealthCheck()}
                disabled={testState.kind === "running"}
              >
                {testState.kind === "running"
                  ? t("settings.sections.jev.testing")
                  : t("settings.sections.jev.testConnection")}
              </Button>
            </div>
            {testState.kind === "done" && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  testState.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
              >
                {testState.message}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
