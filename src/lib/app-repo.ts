/**
 * Single source of truth for the GitHub repo that hosts releases and
 * auto-update artifacts. Repointed from the upstream `nashsu/llm_wiki`
 * to our own fork so update checks + in-place updates pull from our
 * releases. The Tauri updater endpoint in `tauri.conf.json` must point
 * at the SAME repo's `releases/latest/download/latest.json`.
 */
export const APP_REPO = "chunguangwei/LLMWiKi"
export const APP_REPO_URL = `https://github.com/${APP_REPO}`
export const APP_RELEASES_URL = `${APP_REPO_URL}/releases`

/**
 * OAuth App client id for the GitHub device-login flow used by the
 * versioned-backup feature. Left EMPTY until an OAuth App is registered
 * on GitHub — while empty the Settings → GitHub Backup section disables
 * the "OAuth device login" option (with a "needs setup" note) and keeps
 * the Personal Access Token path fully usable. Fill this with the OAuth
 * App's Client ID to enable the device-login button.
 */
export const GITHUB_OAUTH_CLIENT_ID = ""
