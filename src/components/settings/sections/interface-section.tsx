import { useTranslation } from "react-i18next"
import { Sun, Moon, Monitor } from "lucide-react"
import i18n from "@/i18n"
import { Label } from "@/components/ui/label"
import { saveLanguage, saveTheme } from "@/lib/project-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { Theme } from "@/lib/theme"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

interface ThemeOption {
  value: Theme
  icon: typeof Sun
  /** i18n key under `settings.sections.interface.themeOptions`. */
  i18nKey: string
  /** Fallback label when the translation key is missing. */
  fallback: string
}

const THEME_OPTIONS: ReadonlyArray<ThemeOption> = [
  { value: "system", icon: Monitor, i18nKey: "system", fallback: "System" },
  { value: "light", icon: Sun, i18nKey: "light", fallback: "Light" },
  { value: "dark", icon: Moon, i18nKey: "dark", fallback: "Dark" },
]

export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const theme = useWikiStore((s) => s.theme)
  const setTheme = useWikiStore((s) => s.setTheme)

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

  // Theme is applied via the App-level subscribe-to-store hook (see
  // App.tsx) — set the store value here and the .dark class flips
  // automatically. Persist alongside so a reload reflects the choice.
  const pickTheme = async (value: Theme) => {
    setTheme(value)
    await saveTheme(value).catch((err) =>
      console.warn("[interface] could not persist theme:", err),
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

      <div className="space-y-2">
        <Label>
          {t("settings.sections.interface.theme", { defaultValue: "Theme" })}
        </Label>
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map((opt) => {
            const active = theme === opt.value
            const Icon = opt.icon
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => void pickTheme(opt.value)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t(`settings.sections.interface.themeOptions.${opt.i18nKey}`, {
                  defaultValue: opt.fallback,
                })}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.themeHint", {
            defaultValue:
              "System follows your OS preference and flips live when you toggle it. Light / Dark force the choice regardless of OS.",
          })}
        </p>
      </div>
    </div>
  )
}
