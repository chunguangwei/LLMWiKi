import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./en.json"
import it from "./it.json"
import zh from "./zh.json"
import ru from "./ru.json"

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
    zh: { translation: zh },
    ru: { translation: ru },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
})

function syncDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = language || "en"
}

syncDocumentLanguage(i18n.resolvedLanguage || i18n.language)
i18n.on("languageChanged", syncDocumentLanguage)

export default i18n
