/**
 * Light / Dark theme switching.
 *
 *   - `"light"`  — force light mode regardless of OS preference.
 *   - `"dark"`   — force dark mode regardless of OS preference.
 *   - `"system"` — follow the OS preference via `prefers-color-scheme`.
 *
 * The actual rendering switch is driven by the `.dark` class on
 * `<html>`. shadcn/Tailwind tokens in `src/index.css` define the
 * full palette under both `:root` and `.dark`, so adding / removing
 * the class flips every semantically-named utility (`bg-background`,
 * `text-foreground`, `border-border`, …) at once. Hardcoded colors
 * with explicit `dark:` variants flip via Tailwind's `dark` variant
 * (which we wired via `@custom-variant dark (&:is(.dark *))`).
 *
 * Default is `"system"` so a first-time user lands in whatever
 * shape their OS theme expects — best-practice for dark-mode
 * support on desktop apps.
 */

export type Theme = "light" | "dark" | "system"

const DARK_CLASS = "dark"
const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"

/** Resolve a Theme to the concrete light/dark mode that should
 *  render right now. `"system"` reads the media query. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (typeof window === "undefined") return "light"
    return window.matchMedia(COLOR_SCHEME_QUERY).matches ? "dark" : "light"
  }
  return theme
}

/** Apply the resolved theme to `<html>`. Safe to call repeatedly. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  const resolved = resolveTheme(theme)
  root.classList.toggle(DARK_CLASS, resolved === "dark")
  // Tell the OS (window chrome, scrollbar) about our scheme so the
  // native bits stay aligned with the in-app palette.
  root.style.colorScheme = resolved
}

/**
 * Subscribe to OS color-scheme changes. Returns the cleanup function.
 *
 * Only meaningful when the user's stored theme is `"system"` — for
 * `"light"` / `"dark"` the OS toggling shouldn't change our render.
 * Callers should still WRAP this with their own subscription so they
 * can re-evaluate when the user flips the in-app preference too.
 */
export function subscribeToSystemThemeChanges(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {}
  }
  const mq = window.matchMedia(COLOR_SCHEME_QUERY)
  const handler = () => onChange()
  // addEventListener is the modern API; older Safari needs addListener.
  // The modern API is available on every supported Tauri webview, so the
  // legacy `addListener` branch is dead in practice — kept defensively
  // for future-proofing without paying the ts-expect-error tax.
  mq.addEventListener("change", handler)
  return () => mq.removeEventListener("change", handler)
}

export const THEMES: ReadonlyArray<{
  value: Theme
  /** i18n key suffix; full key is `settings.sections.interface.theme<Value>`. */
  i18nKey: string
}> = [
  { value: "system", i18nKey: "themeSystem" },
  { value: "light", i18nKey: "themeLight" },
  { value: "dark", i18nKey: "themeDark" },
]
