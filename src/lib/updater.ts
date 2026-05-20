/**
 * In-place auto-update via tauri-plugin-updater.
 *
 * The updater fetches the signed `latest.json` from our GitHub releases
 * (endpoint + minisign pubkey configured in tauri.conf.json), verifies
 * the signature, downloads the platform artifact, and replaces the app
 * in place. Because it never uninstalls/reinstalls, the OS app-data dir
 * (config + API keys) is untouched — updates preserve all settings.
 *
 * The separate GitHub-API "check for updates" notify flow (update-check.ts)
 * still drives the banner + release notes; THIS module does the actual
 * download+install when the user clicks "Update now".
 */
import { check } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"

export type UpdaterStage =
  | "checking"
  | "downloading"
  | "installing"
  | "done"
  | "uptodate"

export interface UpdaterProgress {
  stage: UpdaterStage
  /** bytes downloaded so far (downloading stage) */
  downloaded?: number
  /** total bytes, 0 if the server didn't send Content-Length */
  total?: number
}

export interface UpdateResult {
  updated: boolean
  version?: string
}

/**
 * Check the updater endpoint and, if a newer signed release exists,
 * download + install it in place. Resolves with `updated: true` once
 * the install is staged — the caller should then offer to relaunch.
 *
 * Throws on signature mismatch, network failure, or a misconfigured
 * endpoint (e.g. no latest.json on the release yet) — the caller renders
 * the error.
 */
export async function runInPlaceUpdate(
  onProgress?: (p: UpdaterProgress) => void,
): Promise<UpdateResult> {
  onProgress?.({ stage: "checking" })
  const update = await check()
  if (!update) {
    onProgress?.({ stage: "uptodate" })
    return { updated: false }
  }

  let downloaded = 0
  let total = 0
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0
        onProgress?.({ stage: "downloading", downloaded: 0, total })
        break
      case "Progress":
        downloaded += event.data.chunkLength
        onProgress?.({ stage: "downloading", downloaded, total })
        break
      case "Finished":
        onProgress?.({ stage: "installing" })
        break
    }
  })

  onProgress?.({ stage: "done" })
  return { updated: true, version: update.version }
}

/** Relaunch the app so the freshly-installed version takes over. */
export async function relaunchApp(): Promise<void> {
  await relaunch()
}
