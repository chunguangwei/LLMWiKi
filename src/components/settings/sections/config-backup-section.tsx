import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { save, open } from "@tauri-apps/plugin-dialog"
import { relaunchApp } from "@/lib/updater"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ShieldCheck,
  Download,
  Upload,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"

interface BackupStatus {
  exists: boolean
  path: string
  last_backup_ms: number | null
}

/**
 * Config Backup / Restore section.
 *
 * Two independent mechanisms:
 *   1. Manual export/import — passphrase-encrypted (Argon2id + AES-256-GCM
 *      in Rust). Portable across machines. The plaintext never leaves Rust
 *      unencrypted; decompiling the app reveals no key.
 *   2. Auto-backup status — the app writes an encrypted copy on every
 *      launch (key held in the OS keychain) to ~/Documents/LLMWiki/ and
 *      auto-restores it on a fresh/empty install. This row just surfaces
 *      the last-backup time + a "Backup now" button.
 */
export function ConfigBackupSection() {
  const { t } = useTranslation()
  const [password, setPassword] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState<"export" | "import" | "backup" | null>(null)
  const [result, setResult] = useState<{ kind: "ok" | "err"; message: string } | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [status, setStatus] = useState<BackupStatus | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<BackupStatus>("config_backup_status")
      setStatus(s)
    } catch (e) {
      console.error("[config-backup] status failed:", e)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const pwTooShort = password.length > 0 && password.length < 8

  const handleExport = useCallback(async () => {
    if (password.length < 8 || busy) return
    setResult(null)
    const target = await save({
      title: t("settings.sections.configBackup.exportTitle", { defaultValue: "Export encrypted config" }),
      defaultPath: `llmwiki-config-${new Date().toISOString().slice(0, 10)}.llmwiki-config`,
      filters: [{ name: "LLM Wiki Config", extensions: ["llmwiki-config"] }],
    })
    if (!target) return
    setBusy("export")
    try {
      await invoke("export_config", { outPath: target, password })
      setResult({ kind: "ok", message: t("settings.sections.configBackup.exportOk", { defaultValue: "Encrypted config exported." }) })
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [password, busy, t])

  const handleImport = useCallback(async () => {
    if (password.length < 1 || busy) return
    setResult(null)
    const picked = await open({
      title: t("settings.sections.configBackup.importTitle", { defaultValue: "Import encrypted config" }),
      multiple: false,
      directory: false,
      filters: [{ name: "LLM Wiki Config", extensions: ["llmwiki-config"] }],
    })
    if (!picked || typeof picked !== "string") return
    setBusy("import")
    try {
      await invoke("import_config", { inPath: picked, password })
      setResult({ kind: "ok", message: t("settings.sections.configBackup.importOk", { defaultValue: "Config imported. Restart to apply." }) })
      setNeedsRestart(true)
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [password, busy, t])

  const handleBackupNow = useCallback(async () => {
    if (busy) return
    setBusy("backup")
    setResult(null)
    try {
      await invoke("config_backup_now")
      await refreshStatus()
      setResult({ kind: "ok", message: t("settings.sections.configBackup.backupOk", { defaultValue: "Backup refreshed." }) })
    } catch (e) {
      setResult({ kind: "err", message: String(e) })
    } finally {
      setBusy(null)
    }
  }, [busy, refreshStatus, t])

  const lastBackupLabel = (() => {
    if (!status?.exists || !status.last_backup_ms) return t("settings.sections.configBackup.never", { defaultValue: "never" })
    return new Date(status.last_backup_ms).toLocaleString()
  })()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          {t("settings.sections.configBackup.title", { defaultValue: "Config Backup" })}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sections.configBackup.description", { defaultValue: "Back up and restore all settings — including API keys. Exports are encrypted with your password (Argon2id + AES-256-GCM); the password is the only way to decrypt them." })}
        </p>
      </div>

      {/* Passphrase */}
      <div className="space-y-2">
        <Label htmlFor="cfg-pw">{t("settings.sections.configBackup.password", { defaultValue: "Encryption password" })}</Label>
        <div className="flex gap-2">
          <Input
            id="cfg-pw"
            type={showPw ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("settings.sections.configBackup.passwordPlaceholder", { defaultValue: "At least 8 characters" })}
            className="flex-1"
            autoComplete="new-password"
          />
          <Button variant="outline" size="icon" type="button" onClick={() => setShowPw((v) => !v)}>
            {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {pwTooShort && (
          <p className="text-xs text-amber-600">{t("settings.sections.configBackup.pwTooShort", { defaultValue: "Password must be at least 8 characters." })}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.configBackup.passwordHint", { defaultValue: "Remember this password — there is no recovery. It's needed to import on another machine." })}
        </p>
      </div>

      {/* Export / Import */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={handleExport} disabled={password.length < 8 || busy !== null} className="gap-1.5">
          {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t("settings.sections.configBackup.export", { defaultValue: "Export encrypted config" })}
        </Button>
        <Button onClick={handleImport} disabled={password.length < 1 || busy !== null} variant="outline" className="gap-1.5">
          {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {t("settings.sections.configBackup.import", { defaultValue: "Import encrypted config" })}
        </Button>
      </div>

      {needsRestart && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3 flex items-center justify-between gap-3">
          <span className="text-sm">{t("settings.sections.configBackup.restartHint", { defaultValue: "Imported config takes effect after restart." })}</span>
          <Button size="sm" onClick={() => void relaunchApp()} className="gap-1.5 shrink-0">
            <RefreshCw className="h-3.5 w-3.5" />
            {t("settings.sections.configBackup.restartNow", { defaultValue: "Restart now" })}
          </Button>
        </div>
      )}

      {result && (
        <div
          className={
            result.kind === "ok"
              ? "rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 break-words"
              : "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive break-words"
          }
        >
          {result.message}
        </div>
      )}

      {/* Auto-backup status */}
      <div className="rounded-md border bg-muted/30 p-4 space-y-2">
        <h3 className="text-sm font-medium">{t("settings.sections.configBackup.autoTitle", { defaultValue: "Automatic backup" })}</h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.configBackup.autoDesc", { defaultValue: "On every launch the app writes an encrypted backup (key held in the OS keychain) to a stable folder, and auto-restores it on a fresh install — so a reinstall keeps your settings." })}
        </p>
        <div className="text-xs text-muted-foreground">
          <span>{t("settings.sections.configBackup.lastBackup", { defaultValue: "Last backup" })}: </span>
          <span className="font-mono">{lastBackupLabel}</span>
        </div>
        {status?.exists && (
          <div className="text-xs text-muted-foreground break-all">
            <span>{t("settings.sections.configBackup.location", { defaultValue: "Location" })}: </span>
            <span className="font-mono">{status.path}</span>
          </div>
        )}
        <Button size="sm" variant="outline" onClick={handleBackupNow} disabled={busy !== null} className="gap-1.5 mt-1">
          {busy === "backup" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("settings.sections.configBackup.backupNow", { defaultValue: "Back up now" })}
        </Button>
      </div>

      {/* Security note */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.configBackup.securityNote", { defaultValue: "The exported file contains your API keys, encrypted. Anyone with the file AND the password can read them. Store both safely; the auto-backup's key lives in your OS keychain and never leaves this machine." })}
        </p>
      </div>
    </div>
  )
}
