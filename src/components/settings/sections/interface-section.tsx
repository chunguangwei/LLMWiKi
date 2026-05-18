import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { Label } from "@/components/ui/label"
import { saveLanguage } from "@/lib/project-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  // One-click language switch: take effect immediately AND persist,
  // without forcing the user to click Save afterwards. The draft
  // assignment still happens so the global Save bar (which collects
  // other unsaved fields) doesn't roll the language back.
  const pickLanguage = async (value: string) => {
    setDraft("uiLanguage", value)
    if (i18n.language === value) return
    await i18n.changeLanguage(value)
    await saveLanguage(value).catch((err) =>
      console.warn("[interface] could not persist language:", err),
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.interface.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.interface.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.uiLanguage")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((l) => {
            const active = draft.uiLanguage === l.value
            return (
              <button
                key={l.value}
                type="button"
                onClick={() => void pickLanguage(l.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {l.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.uiLanguageHint")}
        </p>
      </div>
    </div>
  )
}
