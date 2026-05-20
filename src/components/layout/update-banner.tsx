import { useCallback, useState } from "react"
import { Sparkles, X, Download, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useUpdateStore, shouldShowUpdateBanner } from "@/stores/update-store"
import { saveUpdateCheckState } from "@/lib/project-store"
import { toLatestReleaseUrl } from "@/lib/update-check"
import { runInPlaceUpdate, relaunchApp } from "@/lib/updater"

/**
 * App-wide update-available banner.
 *
 * Sits above the main flex row (IconSidebar + content). Renders ONLY
 * when `shouldShowUpdateBanner(state)` returns true — that helper
 * already gates on:
 *   - we have a successful "available" check result
 *   - the user hasn't dismissed THIS exact remote version
 * so a closed banner stays closed for the dismissed version, and
 * automatically reappears the moment a NEWER release ships
 * (dismissedVersion no longer matches the new remote).
 *
 * Persistence: the X handler writes the dismissed version through
 * `saveUpdateCheckState` so the close decision survives a restart.
 *
 * Why not use the same component as the About-page banner: that one
 * is opt-in (user navigated to settings), so it shows full release
 * notes and a "Later" button. This one is uninvited and must stay
 * compact / single-line so it doesn't disrupt the working layout —
 * just version + one CTA + close.
 */
export function UpdateBanner() {
  const { t } = useTranslation()
  const visible = useUpdateStore((s) => shouldShowUpdateBanner(s))
  const result = useUpdateStore((s) => s.lastResult)
  // Compact in-place-update state for this single-line banner.
  const [phase, setPhase] = useState<"idle" | "working" | "ready">("idle")

  // Manual-download fallback: open /releases/latest in the browser.
  // /latest always follows GitHub's redirect to the newest release.
  const handleOpen = useCallback(async () => {
    if (!result || result.kind !== "available") return
    try {
      await openUrl(toLatestReleaseUrl(result.release.html_url))
    } catch (err) {
      console.error("[update-banner] openUrl failed:", err)
    }
  }, [result])

  // Primary CTA: in-place update. On any failure (dev build with no
  // updater artifacts, signature/Gatekeeper issue) fall back to opening
  // the manual download page so the button is never a dead end.
  const handleUpdateNow = useCallback(async () => {
    setPhase("working")
    try {
      const res = await runInPlaceUpdate()
      if (res.updated) {
        setPhase("ready")
      } else {
        setPhase("idle")
      }
    } catch (err) {
      console.error("[update-banner] in-place update failed, opening download page:", err)
      setPhase("idle")
      await handleOpen()
    }
  }, [handleOpen])

  const handleRestart = useCallback(async () => {
    try {
      await relaunchApp()
    } catch (err) {
      console.error("[update-banner] relaunch failed:", err)
    }
  }, [])

  const handleDismiss = useCallback(async () => {
    if (!result || result.kind !== "available") return
    // Mark THIS remote version as dismissed; helper hides banner.
    // Future newer releases re-pop because their version doesn't
    // match dismissedVersion anymore. Persist so the choice
    // survives a restart — without that, the banner re-appears
    // every cold start, which is the user complaint we're fixing.
    useUpdateStore.getState().setDismissed(result.remote)
    await saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt ?? Date.now(),
      dismissedVersion: result.remote,
    })
  }, [result])

  if (!visible || !result || result.kind !== "available") return null

  return (
    // Visual style notes:
    //   - subtle gradient (left primary tint → right transparent) so
    //     the eye lands on the icon + text first
    //   - thin 1px bottom border separates it from the chrome
    //     without screaming at the user
    //   - py-2 / px-4 gives a comfortable single-row height (~36px)
    //     without dominating the viewport
    //   - text-sm at medium weight reads cleanly without feeling
    //     promotional
    //   - the action button uses bg-primary fill so it's the
    //     unambiguous CTA; close button stays ghost so it doesn't
    //     compete
    <div className="flex shrink-0 items-center gap-3 border-b border-primary/20 bg-gradient-to-r from-primary/8 via-primary/4 to-transparent px-4 py-2 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        </div>
        <span className="truncate font-medium text-foreground">
          {t("updateBanner.message", {
            version: result.remote.replace(/^v/, ""),
            defaultValue: `Version ${result.remote.replace(/^v/, "")} is available`,
          })}
        </span>
      </div>
      {phase === "ready" ? (
        <button
          type="button"
          onClick={handleRestart}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("updateBanner.restart", { defaultValue: "Restart to apply" })}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleUpdateNow}
          disabled={phase === "working"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-70"
        >
          <Download className={`h-3.5 w-3.5 ${phase === "working" ? "animate-pulse" : ""}`} />
          {phase === "working"
            ? t("updateBanner.working", { defaultValue: "Updating…" })
            : t("updateBanner.updateNow", { defaultValue: "Update now" })}
        </button>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("updateBanner.dismiss", { defaultValue: "Dismiss" })}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
