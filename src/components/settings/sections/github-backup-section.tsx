import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  GitBranch,
  Loader2,
  Eye,
  EyeOff,
  AlertTriangle,
  CheckCircle2,
  History,
  RotateCcw,
  CloudUpload,
  CloudDownload,
  LogOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { GITHUB_OAUTH_CLIENT_ID } from "@/lib/app-repo"
import { listDirectory, readFile } from "@/commands/fs"
import {
  DEFAULT_GITHUB_BACKUP_CONFIG,
  loadGithubBackupConfig,
  saveGithubBackupConfig,
  githubTokenStatus,
  githubSaveToken,
  githubClearToken,
  githubOAuthDeviceStart,
  githubOAuthDevicePoll,
  githubValidateAndPrepare,
  githubBackupNow,
  githubListVersions,
  githubRestoreVersion,
  pullAndApply,
  startGithubBackup,
  stopGithubBackup,
  type GithubBackupConfig,
  type GithubTokenStatus,
  type GithubVersion,
} from "@/lib/github-backup"

/**
 * GitHub Backup / multi-device-sync settings section.
 *
 * Self-managed like config-backup-section.tsx — it reads/writes its OWN
 * state via invoke + the per-device config persist helper, runs its own
 * busy/result banners, and is NOT wired into the global Save bar (it
 * persists each change inline). The Rust side owns the actual git work
 * and token storage.
 *
 * Auth supports two methods:
 *   - PAT: paste a token → github_save_token. Always available.
 *   - OAuth device flow: only when GITHUB_OAUTH_CLIENT_ID is set;
 *     otherwise the radio is disabled with a "needs setup" note while
 *     PAT stays fully usable.
 */
export function GithubBackupSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)

  const oauthEnabled = GITHUB_OAUTH_CLIENT_ID.length > 0

  // ── Config (persisted per-device) ──────────────────────────────────
  const [cfg, setCfg] = useState<GithubBackupConfig>(DEFAULT_GITHUB_BACKUP_CONFIG)
  const [cfgLoaded, setCfgLoaded] = useState(false)

  // ── Token / connection state ───────────────────────────────────────
  const [tokenStatus, setTokenStatus] = useState<GithubTokenStatus>({ hasToken: false })
  const [pat, setPat] = useState("")
  const [showPat, setShowPat] = useState(false)

  // ── OAuth device flow ──────────────────────────────────────────────
  const [oauth, setOauth] = useState<{
    userCode: string
    verificationUri: string
  } | null>(null)
  const oauthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Versions list ──────────────────────────────────────────────────
  const [versions, setVersions] = useState<GithubVersion[] | null>(null)

  // ── Busy + result banners ──────────────────────────────────────────
  const [busy, setBusy] = useState<
    | "savePat"
    | "disconnect"
    | "oauth"
    | "verifyRepo"
    | "backup"
    | "pull"
    | "versions"
    | "restore"
    | null
  >(null)
  const [result, setResult] = useState<{ kind: "ok" | "err" | "warn"; message: string } | null>(
    null,
  )

  // ── Refresh the token status (drives the "connected as" line) ───────
  const refreshTokenStatus = useCallback(async () => {
    try {
      const s = await githubTokenStatus()
      setTokenStatus(s)
      // Default the owner field to the connected login the first time we
      // learn it, so the common "back up to my own account" case is
      // one-click.
      if (s.login) {
        setCfg((prev) => (prev.owner ? prev : { ...prev, owner: s.login as string }))
      }
    } catch (e) {
      console.error("[github-backup] token status failed:", e)
    }
  }, [])

  // ── Load config + token status on mount / project change ───────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (project) {
        const loaded = await loadGithubBackupConfig(project.path)
        if (!cancelled) setCfg(loaded)
      }
      if (!cancelled) {
        setCfgLoaded(true)
        await refreshTokenStatus()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project, refreshTokenStatus])

  // Stop any pending OAuth poll loop when the component unmounts.
  useEffect(() => {
    return () => {
      if (oauthTimer.current) clearTimeout(oauthTimer.current)
    }
  }, [])

  // Persist a config patch and reflect it in local state. Returns the
  // merged config so callers can act on the fresh value synchronously.
  const persistCfg = useCallback(
    async (patch: Partial<GithubBackupConfig>): Promise<GithubBackupConfig> => {
      const next = { ...cfg, ...patch }
      setCfg(next)
      if (project) {
        await saveGithubBackupConfig(project.path, next).catch((e) =>
          console.error("[github-backup] persist failed:", e),
        )
      }
      return next
    },
    [cfg, project],
  )

  // ── Post-sync UI refresh ────────────────────────────────────────────
  //
  // Mirror App.tsx's project-open refresh: rebuild the top-level file
  // tree, bump the data version (invalidates cached graphs/views), and —
  // if the currently open file was touched — reload its content. Callers
  // pass the changed/restored paths so we only reload when relevant.
  const refreshAfterSync = useCallback(
    async (touched: string[]) => {
      if (!project) return
      try {
        const tree = await listDirectory(project.path)
        useWikiStore.getState().setFileTree(tree)
      } catch (e) {
        console.error("[github-backup] file-tree rebuild failed:", e)
      }
      useWikiStore.getState().bumpDataVersion()
      const selected = useWikiStore.getState().selectedFile
      if (selected && touched.some((p) => p === selected || selected.endsWith(p))) {
        try {
          const content = await readFile(selected)
          useWikiStore.getState().setFileContent(content)
        } catch (e) {
          console.error("[github-backup] reload of open file failed:", e)
        }
      }
    },
    [project],
  )

  // ── Auth: PAT ───────────────────────────────────────────────────────
  const handleSavePat = useCallback(async () => {
    if (!pat.trim() || busy) return
    setBusy("savePat")
    setResult(null)
    try {
      await githubSaveToken({ token: pat.trim() })
      setPat("")
      await refreshTokenStatus()
      setResult({
        kind: "ok",
        message: t("settings.sections.githubBackup.patSaved", { defaultValue: "Token saved." }),
      })
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [pat, busy, refreshTokenStatus, t])

  const handleDisconnect = useCallback(async () => {
    if (busy) return
    setBusy("disconnect")
    setResult(null)
    try {
      await githubClearToken()
      await refreshTokenStatus()
      setResult({
        kind: "ok",
        message: t("settings.sections.githubBackup.disconnected", {
          defaultValue: "Disconnected.",
        }),
      })
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, refreshTokenStatus, t])

  // ── Auth: OAuth device flow ─────────────────────────────────────────
  const handleOAuthSignIn = useCallback(async () => {
    if (!oauthEnabled || busy) return
    setBusy("oauth")
    setResult(null)
    setOauth(null)
    try {
      const start = await githubOAuthDeviceStart({
        clientId: GITHUB_OAUTH_CLIENT_ID,
        scope: "repo",
      })
      setOauth({ userCode: start.userCode, verificationUri: start.verificationUri })
      // Open the verification page in the system browser so the user can
      // paste the code GitHub shows us.
      void openUrl(start.verificationUri).catch((err) =>
        console.error("[github-backup] openUrl failed:", err),
      )

      const deadline = Date.now() + start.expiresIn * 1000
      // GitHub asks us to honor `interval` (and back off on slow_down).
      let pollMs = Math.max(1, start.interval) * 1000

      const poll = async () => {
        if (Date.now() > deadline) {
          setBusy(null)
          setOauth(null)
          setResult({
            kind: "err",
            message: t("settings.sections.githubBackup.oauthExpired", {
              defaultValue: "Sign-in code expired. Try again.",
            }),
          })
          return
        }
        try {
          const p = await githubOAuthDevicePoll({
            clientId: GITHUB_OAUTH_CLIENT_ID,
            deviceCode: start.deviceCode,
          })
          if (p.status === "authorized") {
            if (p.token) await githubSaveToken({ token: p.token })
            setOauth(null)
            setBusy(null)
            await refreshTokenStatus()
            await persistCfg({ authMethod: "oauth" })
            setResult({
              kind: "ok",
              message: t("settings.sections.githubBackup.oauthOk", {
                defaultValue: "Signed in with GitHub.",
              }),
            })
            return
          }
          if (p.status === "error") {
            setBusy(null)
            setOauth(null)
            setResult({
              kind: "err",
              message: t("settings.sections.githubBackup.oauthFailed", {
                defaultValue: "GitHub sign-in failed.",
              }),
            })
            return
          }
          // slow_down → back off an extra 5s per GitHub's guidance.
          if (p.status === "slow_down") pollMs += 5000
        } catch (e) {
          console.error("[github-backup] oauth poll error:", e)
        }
        oauthTimer.current = setTimeout(() => void poll(), pollMs)
      }
      oauthTimer.current = setTimeout(() => void poll(), pollMs)
    } catch (e) {
      setBusy(null)
      setResult({ kind: "err", message: String(e) })
    }
  }, [oauthEnabled, busy, refreshTokenStatus, persistCfg, t])

  // ── Repo: create / verify ───────────────────────────────────────────
  const handleVerifyRepo = useCallback(async () => {
    if (busy || !cfg.owner.trim() || !cfg.repo.trim()) return
    setBusy("verifyRepo")
    setResult(null)
    try {
      const r = await githubValidateAndPrepare({
        owner: cfg.owner.trim(),
        repo: cfg.repo.trim(),
        private: true,
      })
      await persistCfg({ owner: r.login, repo: cfg.repo.trim() })
      setResult({
        kind: "ok",
        message: r.created
          ? t("settings.sections.githubBackup.repoCreated", {
              defaultValue: "Private repo created.",
            })
          : t("settings.sections.githubBackup.repoExists", {
              defaultValue: "Repo verified (already exists).",
            }),
      })
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, cfg.owner, cfg.repo, persistCfg, t])

  // ── Scope / interval / enable ───────────────────────────────────────
  const handleToggleIncludeRaw = useCallback(
    async (value: boolean) => {
      await persistCfg({ includeRawSources: value })
    },
    [persistCfg],
  )

  const handleIntervalChange = useCallback(
    async (minutes: number) => {
      const clamped = Math.max(1, Math.min(1440, minutes || 30))
      const next = await persistCfg({ intervalMinutes: clamped })
      // Restart the scheduler so the new interval takes effect immediately.
      if (project && next.enabled && tokenStatus.hasToken) {
        startGithubBackup(project, next, (res) => {
          void refreshAfterSync(res.pushedFiles)
        })
      }
    },
    [persistCfg, project, tokenStatus.hasToken, refreshAfterSync],
  )

  const handleToggleEnabled = useCallback(
    async (value: boolean) => {
      const next = await persistCfg({ enabled: value })
      if (!project) return
      if (value && tokenStatus.hasToken) {
        startGithubBackup(project, next, (res) => {
          void refreshAfterSync(res.pushedFiles)
        })
      } else {
        stopGithubBackup()
      }
    },
    [persistCfg, project, tokenStatus.hasToken, refreshAfterSync],
  )

  // ── Actions: Backup now ─────────────────────────────────────────────
  const handleBackupNow = useCallback(async () => {
    if (busy || !project) return
    setBusy("backup")
    setResult(null)
    try {
      const r = await githubBackupNow({
        projectDir: project.path,
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        includeRawSources: cfg.includeRawSources,
        lastSyncSha: cfg.lastSyncSha,
      })
      await persistCfg({
        lastSyncSha: r.newSha || cfg.lastSyncSha,
        lastSyncAt: Date.now(),
      })
      // A backup pulls-first, so remote-side changes may have landed —
      // refresh the UI against the pushed set.
      await refreshAfterSync(r.pushedFiles)
      const base = t("settings.sections.githubBackup.backupOk", {
        defaultValue: "Backed up {{count}} file(s).",
        count: r.pushedFiles.length,
      })
      if (r.skippedOversize.length > 0) {
        setResult({
          kind: "warn",
          message: `${base} ${t("settings.sections.githubBackup.skippedOversize", {
            defaultValue: "Skipped {{count}} oversize file(s): {{list}}",
            count: r.skippedOversize.length,
            list: r.skippedOversize.join(", "),
          })}`,
        })
      } else {
        setResult({ kind: "ok", message: base })
      }
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, project, cfg, persistCfg, refreshAfterSync, t])

  // ── Actions: Pull now ───────────────────────────────────────────────
  const handlePullNow = useCallback(async () => {
    if (busy || !project) return
    setBusy("pull")
    setResult(null)
    try {
      const r = await pullAndApply(project, cfg)
      // pullAndApply already persisted the cursor; mirror it into state.
      setCfg((prev) => ({
        ...prev,
        lastSyncSha: r.newSha || prev.lastSyncSha,
        lastSyncAt: Date.now(),
      }))
      await refreshAfterSync([...r.changedFiles, ...r.deletedFiles])
      const base = t("settings.sections.githubBackup.pullOk", {
        defaultValue: "Pulled: {{changed}} changed, {{deleted}} deleted.",
        changed: r.changedFiles.length,
        deleted: r.deletedFiles.length,
      })
      if (r.conflicts.length > 0) {
        setResult({
          kind: "warn",
          message: `${base} ${t("settings.sections.githubBackup.conflicts", {
            defaultValue: "{{count}} conflict(s) (latest modified wins): {{list}}",
            count: r.conflicts.length,
            list: r.conflicts.join(", "),
          })}`,
        })
      } else {
        setResult({ kind: "ok", message: base })
      }
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, project, cfg, refreshAfterSync, t])

  // ── Versions ────────────────────────────────────────────────────────
  const handleShowVersions = useCallback(async () => {
    if (busy) return
    setBusy("versions")
    setResult(null)
    try {
      const list = await githubListVersions({
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        limit: 30,
      })
      setVersions(list)
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, cfg.owner, cfg.repo, cfg.branch])

  const handleRestore = useCallback(
    async (sha: string) => {
      if (busy || !project) return
      const ok = window.confirm(
        t("settings.sections.githubBackup.restoreConfirm", {
          defaultValue:
            "Restore this version? Local files will be overwritten with the snapshot at this commit.",
        }),
      )
      if (!ok) return
      setBusy("restore")
      setResult(null)
      try {
        const r = await githubRestoreVersion({
          projectDir: project.path,
          owner: cfg.owner,
          repo: cfg.repo,
          sha,
          includeRawSources: cfg.includeRawSources,
        })
        await refreshAfterSync(r.restoredFiles)
        setResult({
          kind: "ok",
          message: t("settings.sections.githubBackup.restoreOk", {
            defaultValue: "Restored {{count}} file(s).",
            count: r.restoredFiles.length,
          }),
        })
      } catch (e) {
        setResult({ kind: "err", message: String(e) })
      } finally {
        setBusy(null)
      }
    },
    [busy, project, cfg.owner, cfg.repo, cfg.includeRawSources, refreshAfterSync, t],
  )

  // ── Derived display values ──────────────────────────────────────────
  const lastSyncLabel = cfg.lastSyncAt
    ? new Date(cfg.lastSyncAt).toLocaleString()
    : t("settings.sections.githubBackup.never", { defaultValue: "never" })

  const repoReady = cfg.owner.trim().length > 0 && cfg.repo.trim().length > 0
  const canSync = tokenStatus.hasToken && repoReady && !!project

  if (!cfgLoaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("settings.sections.githubBackup.loading", { defaultValue: "Loading…" })}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <GitBranch className="h-5 w-5 text-foreground" />
          {t("settings.sections.githubBackup.title", { defaultValue: "GitHub Backup & Sync" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.githubBackup.description", {
            defaultValue:
              "Back up your wiki to a private GitHub repo with full version history, and sync it across your devices. Each push is a commit you can restore later.",
          })}
        </p>
      </div>

      {!project && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          {t("settings.sections.githubBackup.noProject", {
            defaultValue: "Open a project to configure GitHub backup.",
          })}
        </div>
      )}

      {/* ── Auth ───────────────────────────────────────────────── */}
      <div className="space-y-3">
        <Label>{t("settings.sections.githubBackup.auth", { defaultValue: "Authentication" })}</Label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void persistCfg({ authMethod: "pat" })}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              cfg.authMethod === "pat"
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/50"
            }`}
          >
            {t("settings.sections.githubBackup.authPat", { defaultValue: "Personal Access Token" })}
          </button>
          <button
            type="button"
            disabled={!oauthEnabled}
            onClick={() => oauthEnabled && void persistCfg({ authMethod: "oauth" })}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              cfg.authMethod === "oauth" && oauthEnabled
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/50"
            }`}
          >
            {t("settings.sections.githubBackup.authOauth", { defaultValue: "OAuth device login" })}
          </button>
        </div>
        {!oauthEnabled && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("settings.sections.githubBackup.oauthNeedsSetup", {
              defaultValue:
                "OAuth login needs an OAuth App client id (GITHUB_OAUTH_CLIENT_ID) — use a Personal Access Token for now.",
            })}
          </p>
        )}

        {/* Connected banner */}
        {tokenStatus.hasToken ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
            <span className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {tokenStatus.login
                ? t("settings.sections.githubBackup.connectedAs", {
                    defaultValue: "Connected as {{login}}",
                    login: tokenStatus.login,
                  })
                : t("settings.sections.githubBackup.connected", { defaultValue: "Connected" })}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDisconnect}
              disabled={busy !== null}
              className="shrink-0 gap-1.5"
            >
              {busy === "disconnect" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              {t("settings.sections.githubBackup.disconnect", { defaultValue: "Disconnect" })}
            </Button>
          </div>
        ) : cfg.authMethod === "pat" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type={showPat ? "text" : "password"}
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder={t("settings.sections.githubBackup.patPlaceholder", {
                  defaultValue: "ghp_… (needs 'repo' scope)",
                })}
                className="flex-1"
                autoComplete="off"
              />
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={() => setShowPat((v) => !v)}
              >
                {showPat ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button onClick={handleSavePat} disabled={!pat.trim() || busy !== null}>
                {busy === "savePat" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("settings.sections.githubBackup.savePat", { defaultValue: "Save" })
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.githubBackup.patHint", {
                defaultValue:
                  "Create a fine-grained or classic token with 'repo' scope. It's stored in your OS keychain, never in the project.",
              })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button onClick={handleOAuthSignIn} disabled={!oauthEnabled || busy !== null} className="gap-1.5">
              {busy === "oauth" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )}
              {t("settings.sections.githubBackup.signIn", { defaultValue: "Sign in with GitHub" })}
            </Button>
            {oauth && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
                <p className="text-muted-foreground">
                  {t("settings.sections.githubBackup.oauthEnterCode", {
                    defaultValue: "Enter this code at {{uri}}:",
                    uri: oauth.verificationUri,
                  })}
                </p>
                <p className="mt-1 font-mono text-lg tracking-widest">{oauth.userCode}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Repo ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label>{t("settings.sections.githubBackup.repo", { defaultValue: "Repository" })}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={cfg.owner}
            onChange={(e) => void persistCfg({ owner: e.target.value })}
            placeholder={t("settings.sections.githubBackup.ownerPlaceholder", {
              defaultValue: "owner",
            })}
            className="w-40"
          />
          <span className="text-muted-foreground">/</span>
          <Input
            value={cfg.repo}
            onChange={(e) => void persistCfg({ repo: e.target.value })}
            placeholder={t("settings.sections.githubBackup.repoPlaceholder", {
              defaultValue: "repo-name",
            })}
            className="w-48"
          />
          <Button
            variant="outline"
            onClick={handleVerifyRepo}
            disabled={busy !== null || !repoReady || !tokenStatus.hasToken}
          >
            {busy === "verifyRepo" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("settings.sections.githubBackup.verifyRepo", {
                defaultValue: "Create / verify repo",
              })
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.githubBackup.repoHint", {
            defaultValue: "The repo is created private. Branch: {{branch}}.",
            branch: cfg.branch,
          })}
        </p>
      </div>

      {/* ── Scope ──────────────────────────────────────────────── */}
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.includeRawSources}
            onChange={(e) => void handleToggleIncludeRaw(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">
              {t("settings.sections.githubBackup.includeRaw", {
                defaultValue: "Include raw sources (raw/, sources/)",
              })}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("settings.sections.githubBackup.includeRawHint", {
                defaultValue:
                  "Backs up your original imported files too. The repo can get large — turn off to back up only the generated wiki.",
              })}
            </span>
          </span>
        </label>
      </div>

      {/* ── Interval + Enable ──────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="gh-interval" className="shrink-0">
            {t("settings.sections.githubBackup.interval", { defaultValue: "Auto-backup every" })}
          </Label>
          <Input
            id="gh-interval"
            type="number"
            min={1}
            max={1440}
            value={cfg.intervalMinutes}
            onChange={(e) => void handleIntervalChange(parseInt(e.target.value, 10))}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">
            {t("settings.sections.githubBackup.minutes", { defaultValue: "minutes" })}
          </span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => void handleToggleEnabled(e.target.checked)}
            disabled={!canSync}
            className="h-4 w-4"
          />
          <span className={!canSync ? "text-muted-foreground" : ""}>
            {t("settings.sections.githubBackup.enable", {
              defaultValue: "Enable automatic background backup",
            })}
          </span>
        </label>
        {!canSync && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.githubBackup.enableBlocked", {
              defaultValue: "Connect a token and verify a repo to enable auto-backup.",
            })}
          </p>
        )}
      </div>

      {/* ── Conflict policy (static) ──────────────────────────────── */}
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {t("settings.sections.githubBackup.conflictPolicy", {
            defaultValue: "Conflict policy",
          })}
          :{" "}
        </span>
        {t("settings.sections.githubBackup.conflictPolicyValue", {
          defaultValue: "Latest modified wins",
        })}
      </div>

      {/* ── Actions ────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={handleBackupNow} disabled={!canSync || busy !== null} className="gap-1.5">
          {busy === "backup" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CloudUpload className="h-4 w-4" />
          )}
          {t("settings.sections.githubBackup.backupNow", { defaultValue: "Backup now" })}
        </Button>
        <Button
          variant="outline"
          onClick={handlePullNow}
          disabled={!canSync || busy !== null}
          className="gap-1.5"
        >
          {busy === "pull" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CloudDownload className="h-4 w-4" />
          )}
          {t("settings.sections.githubBackup.pullNow", { defaultValue: "Pull now" })}
        </Button>
        <Button
          variant="outline"
          onClick={handleShowVersions}
          disabled={!repoReady || !tokenStatus.hasToken || busy !== null}
          className="gap-1.5"
        >
          {busy === "versions" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <History className="h-4 w-4" />
          )}
          {t("settings.sections.githubBackup.showVersions", { defaultValue: "Show versions" })}
        </Button>
      </div>

      {/* ── Result banner ──────────────────────────────────────── */}
      {result && (
        <div
          className={
            result.kind === "ok"
              ? "break-words rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300"
              : result.kind === "warn"
                ? "break-words rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300"
                : "break-words rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          }
        >
          {result.message}
        </div>
      )}

      {/* ── Versions list ──────────────────────────────────────── */}
      {versions && (
        <div className="space-y-1 rounded-md border">
          <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.sections.githubBackup.versionsTitle", { defaultValue: "Versions" })}
          </div>
          {versions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {t("settings.sections.githubBackup.noVersions", {
                defaultValue: "No commits yet.",
              })}
            </div>
          ) : (
            <ul className="divide-y">
              {versions.map((v) => (
                <li key={v.sha} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{v.message}</div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{v.sha.slice(0, 7)}</span>
                      {" · "}
                      {v.author}
                      {" · "}
                      {v.date}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleRestore(v.sha)}
                    disabled={busy !== null || !project}
                    className="shrink-0 gap-1.5"
                  >
                    {busy === "restore" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    {t("settings.sections.githubBackup.restore", { defaultValue: "Restore" })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Status line ────────────────────────────────────────── */}
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <div>
          <span>{t("settings.sections.githubBackup.lastSync", { defaultValue: "Last sync" })}: </span>
          <span className="font-mono">{lastSyncLabel}</span>
        </div>
        {tokenStatus.login && (
          <div>
            <span>{t("settings.sections.githubBackup.account", { defaultValue: "Account" })}: </span>
            <span className="font-mono">{tokenStatus.login}</span>
          </div>
        )}
      </div>

      {/* ── Privacy note ──────────────────────────────────────── */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.githubBackup.privacyNote", {
            defaultValue:
              "Your content is pushed to GitHub. Always use a PRIVATE repo (the verify button creates one private). Anyone with repo access can read the backed-up files.",
          })}
        </p>
      </div>
    </div>
  )
}
