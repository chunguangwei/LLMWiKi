// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import i18n from "./index"

describe("document language", () => {
  it("follows the active UI language", async () => {
    for (const language of ["zh", "it", "ru", "en"]) {
      await i18n.changeLanguage(language)
      expect(document.documentElement.lang).toBe(language)
    }
  })
})
