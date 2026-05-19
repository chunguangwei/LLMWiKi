import { useCallback, useEffect, useState } from "react"
import {
  HardDrive,
  Cloud,
  Server,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Copy,
  FolderOpen,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"

interface StorageInfo {
  kind:
    | "local"
    | "icloud"
    | "dropbox"
    | "onedrive"
    | "gdrive"
    | "smb"
    | "afp"
    | "nfs"
    | "webdav"
    | "synology-drive"
    | "fnos-drive"
    | "qsync"
    | "terrasync"
    | "unknown"
  fsType: string | null
  mountPoint: string | null
  isNetwork: boolean
  sourceWatchUnsupported: boolean
  vendorHint: "synology" | "fnos" | "qnap" | "terramaster" | null
  accessible: boolean
  writable: boolean
}

export function StorageLocationSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const sourceWatchEnabled = useWikiStore((s) => s.sourceWatchConfig.enabled)
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!project?.path) {
      setInfo(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<StorageInfo>("detect_storage", { path: project.path })
      setInfo(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [project?.path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCopy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(null), 1800)
    } catch (e) {
      console.error("[storage] clipboard copy failed:", e)
    }
  }, [])

  if (!project) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          {t("settings.sections.storageLocation.noProject", {
            defaultValue: "Open or create a project first — storage detection runs against the project path.",
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header />

      {/* Path + refresh */}
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.sections.storageLocation.projectPath", { defaultValue: "Project path" })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("settings.sections.storageLocation.recheck", { defaultValue: "Recheck" })}
          </Button>
        </div>
        <div className="break-all font-mono text-xs text-foreground/80">{project.path}</div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {info && <StorageBadge info={info} />}
      {info && <StorageDetails info={info} />}
      {info && info.isNetwork && sourceWatchEnabled && <SourceWatchWarning />}
      {info && (
        <ExcludeCommandCard
          info={info}
          copied={copied}
          onCopy={handleCopy}
        />
      )}
    </div>
  )
}

function Header() {
  const { t } = useTranslation()
  return (
    <div>
      <h2 className="text-xl font-semibold">
        {t("settings.sections.storageLocation.title", { defaultValue: "Storage Location" })}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settings.sections.storageLocation.description", {
          defaultValue:
            "Detects whether the current project lives on local disk, a cloud sync folder, or a network share (SMB / AFP / NFS), and gives setup hints for that storage type.",
        })}
      </p>
    </div>
  )
}

function StorageBadge({ info }: { info: StorageInfo }) {
  const { t } = useTranslation()
  const meta = kindMeta(info.kind)
  const Icon = meta.icon
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-4 py-3">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${meta.iconBg}`}>
        <Icon className={`h-5 w-5 ${meta.iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t(meta.labelKey, { defaultValue: meta.fallback })}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t(meta.subtitleKey, { defaultValue: meta.subtitleFallback })}
        </div>
      </div>
      {info.isNetwork && (
        <span className="shrink-0 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          {t("settings.sections.storageLocation.networkBadge", { defaultValue: "Network mount" })}
        </span>
      )}
    </div>
  )
}

function StorageDetails({ info }: { info: StorageInfo }) {
  const { t } = useTranslation()
  const rows: Array<{ label: string; value: string }> = []
  if (info.fsType) {
    rows.push({
      label: t("settings.sections.storageLocation.fsType", { defaultValue: "Filesystem" }),
      value: info.fsType,
    })
  }
  if (info.mountPoint) {
    rows.push({
      label: t("settings.sections.storageLocation.mountPoint", { defaultValue: "Mount point" }),
      value: info.mountPoint,
    })
  }
  rows.push({
    label: t("settings.sections.storageLocation.accessible", { defaultValue: "Accessible" }),
    value: info.accessible ? "✓" : "✗",
  })
  rows.push({
    label: t("settings.sections.storageLocation.writable", { defaultValue: "Writable" }),
    value: info.writable ? "✓" : "✗ (read-only)",
  })
  if (rows.length === 0) return null
  return (
    <div className="rounded-md border divide-y">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="text-sm text-muted-foreground">{r.label}</span>
          <span className="font-mono text-xs">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function SourceWatchWarning() {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">
          {t("settings.sections.storageLocation.watchWarningTitle", {
            defaultValue: "Source Watch won't fire reliably on network mounts",
          })}
        </div>
        <div className="text-xs leading-relaxed">
          {t("settings.sections.storageLocation.watchWarningBody", {
            defaultValue:
              "FSEvents / inotify / ReadDirectoryChangesW don't watch SMB / AFP / NFS paths. To keep auto-ingest working, use a NAS-vendor sync client (Synology Drive, fnOS Drive, Qsync) that syncs the share to a real local path, then point the project at that local path instead.",
          })}
        </div>
      </div>
    </div>
  )
}

function ExcludeCommandCard({
  info,
  copied,
  onCopy,
}: {
  info: StorageInfo
  copied: string | null
  onCopy: (id: string, text: string) => void
}) {
  const { t } = useTranslation()
  const groups = excludeRecipes(info)
  if (groups.length === 0) return null
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <div className="text-sm font-medium">
          {t("settings.sections.storageLocation.excludeTitle", {
            defaultValue: "Exclude .llm-wiki-local/ from sync",
          })}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.storageLocation.excludeDescription", {
            defaultValue:
              ".llm-wiki-local/ holds your personal chat history. Don't sync it — it produces conflict files across devices and leaks private conversations.",
          })}
        </p>
      </div>
      {groups.map((g, gi) => (
        <div key={gi} className="rounded border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">{g.label}</span>
          </div>
          {g.note && (
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{g.note}</p>
          )}
          {g.commands.map((cmd, ci) => {
            const id = `${gi}-${ci}`
            return (
              <div key={ci} className="mb-2 flex items-start gap-2 last:mb-0">
                <code className="flex-1 break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  {cmd}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 gap-1.5 px-2"
                  onClick={() => onCopy(id, cmd)}
                  title={t("settings.sections.storageLocation.copy", { defaultValue: "Copy" })}
                >
                  {copied === id ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface KindMeta {
  icon: typeof HardDrive
  iconBg: string
  iconColor: string
  labelKey: string
  fallback: string
  subtitleKey: string
  subtitleFallback: string
}

function kindMeta(kind: StorageInfo["kind"]): KindMeta {
  // Visual + label per storage kind. Keys are namespaced under
  // settings.sections.storageLocation.kinds.* with English defaults
  // baked in so the UI still reads sensibly if the i18n file lags.
  const base = "settings.sections.storageLocation.kinds"
  switch (kind) {
    case "local":
      return {
        icon: HardDrive,
        iconBg: "bg-emerald-500/15",
        iconColor: "text-emerald-600 dark:text-emerald-400",
        labelKey: `${base}.local.label`,
        fallback: "Local disk",
        subtitleKey: `${base}.local.subtitle`,
        subtitleFallback: "Lives on this device's filesystem. No sync involved.",
      }
    case "icloud":
      return {
        icon: Cloud,
        iconBg: "bg-sky-500/15",
        iconColor: "text-sky-600 dark:text-sky-400",
        labelKey: `${base}.icloud.label`,
        fallback: "iCloud Drive",
        subtitleKey: `${base}.icloud.subtitle`,
        subtitleFallback: "Synced via iCloud. Add .nosync suffix to exclude chat history.",
      }
    case "dropbox":
      return {
        icon: Cloud,
        iconBg: "bg-blue-500/15",
        iconColor: "text-blue-600 dark:text-blue-400",
        labelKey: `${base}.dropbox.label`,
        fallback: "Dropbox",
        subtitleKey: `${base}.dropbox.subtitle`,
        subtitleFallback: "Synced via Dropbox. Use xattr to ignore .llm-wiki-local/.",
      }
    case "onedrive":
      return {
        icon: Cloud,
        iconBg: "bg-indigo-500/15",
        iconColor: "text-indigo-600 dark:text-indigo-400",
        labelKey: `${base}.onedrive.label`,
        fallback: "OneDrive",
        subtitleKey: `${base}.onedrive.subtitle`,
        subtitleFallback: "Synced via OneDrive.",
      }
    case "gdrive":
      return {
        icon: Cloud,
        iconBg: "bg-yellow-500/15",
        iconColor: "text-yellow-700 dark:text-yellow-400",
        labelKey: `${base}.gdrive.label`,
        fallback: "Google Drive",
        subtitleKey: `${base}.gdrive.subtitle`,
        subtitleFallback: "Synced via Google Drive.",
      }
    case "synology-drive":
      return {
        icon: Server,
        iconBg: "bg-cyan-500/15",
        iconColor: "text-cyan-600 dark:text-cyan-400",
        labelKey: `${base}.synologyDrive.label`,
        fallback: "Synology Drive",
        subtitleKey: `${base}.synologyDrive.subtitle`,
        subtitleFallback: "Synced to a Synology NAS via the Drive Client.",
      }
    case "fnos-drive":
      return {
        icon: Server,
        iconBg: "bg-cyan-500/15",
        iconColor: "text-cyan-600 dark:text-cyan-400",
        labelKey: `${base}.fnosDrive.label`,
        fallback: "fnOS Drive",
        subtitleKey: `${base}.fnosDrive.subtitle`,
        subtitleFallback: "Synced to a fnOS (FeiNiu) NAS via the fnOS Drive client.",
      }
    case "qsync":
      return {
        icon: Server,
        iconBg: "bg-cyan-500/15",
        iconColor: "text-cyan-600 dark:text-cyan-400",
        labelKey: `${base}.qsync.label`,
        fallback: "QNAP Qsync",
        subtitleKey: `${base}.qsync.subtitle`,
        subtitleFallback: "Synced to a QNAP NAS via the Qsync client.",
      }
    case "terrasync":
      return {
        icon: Server,
        iconBg: "bg-cyan-500/15",
        iconColor: "text-cyan-600 dark:text-cyan-400",
        labelKey: `${base}.terrasync.label`,
        fallback: "TerraMaster Sync",
        subtitleKey: `${base}.terrasync.subtitle`,
        subtitleFallback: "Synced to a TerraMaster NAS via TerraSync.",
      }
    case "smb":
      return {
        icon: Server,
        iconBg: "bg-violet-500/15",
        iconColor: "text-violet-600 dark:text-violet-400",
        labelKey: `${base}.smb.label`,
        fallback: "SMB / CIFS share",
        subtitleKey: `${base}.smb.subtitle`,
        subtitleFallback: "Mounted network share. Source Watch won't fire here.",
      }
    case "afp":
      return {
        icon: Server,
        iconBg: "bg-violet-500/15",
        iconColor: "text-violet-600 dark:text-violet-400",
        labelKey: `${base}.afp.label`,
        fallback: "AFP share",
        subtitleKey: `${base}.afp.subtitle`,
        subtitleFallback: "Legacy Apple Filing Protocol mount. SMB is recommended instead.",
      }
    case "nfs":
      return {
        icon: Server,
        iconBg: "bg-violet-500/15",
        iconColor: "text-violet-600 dark:text-violet-400",
        labelKey: `${base}.nfs.label`,
        fallback: "NFS share",
        subtitleKey: `${base}.nfs.subtitle`,
        subtitleFallback: "Mounted NFS export. Source Watch won't fire here.",
      }
    case "webdav":
      return {
        icon: Cloud,
        iconBg: "bg-violet-500/15",
        iconColor: "text-violet-600 dark:text-violet-400",
        labelKey: `${base}.webdav.label`,
        fallback: "WebDAV mount",
        subtitleKey: `${base}.webdav.subtitle`,
        subtitleFallback: "Mounted WebDAV share. Performance varies.",
      }
    default:
      return {
        icon: HardDrive,
        iconBg: "bg-muted",
        iconColor: "text-muted-foreground",
        labelKey: `${base}.unknown.label`,
        fallback: "Unknown",
        subtitleKey: `${base}.unknown.subtitle`,
        subtitleFallback: "Couldn't classify this path's storage type — treat as local.",
      }
  }
}

interface ExcludeGroup {
  label: string
  note?: string
  commands: string[]
}

function excludeRecipes(info: StorageInfo): ExcludeGroup[] {
  // Order: most-specific match first. For a clear cloud/NAS kind we
  // show ONLY that recipe; for "smb"/"afp"/"nfs"/"unknown" we show
  // generic guidance so the user has something actionable even when
  // we can't pin the vendor.
  switch (info.kind) {
    case "icloud":
      return [{
        label: "iCloud Drive",
        note:
          "Append a .nosync suffix to the folder so iCloud retains it locally but never uploads it.",
        commands: ["mv .llm-wiki-local .llm-wiki-local.nosync"],
      }]
    case "dropbox":
      return [{
        label: "Dropbox",
        note: "Sets the Dropbox-recognised extended attribute that marks a folder as ignored.",
        commands: ["xattr -w com.dropbox.ignored 1 .llm-wiki-local"],
      }]
    case "onedrive":
      return [{
        label: "OneDrive",
        note:
          "OneDrive has no per-folder ignore CLI on macOS. Use the desktop client: right-click the folder → \"Always keep on this device\" → uncheck \"Free up space\" → then \"Stop syncing\".",
        commands: [],
      }]
    case "gdrive":
      return [{
        label: "Google Drive",
        note:
          "Drive for desktop → Preferences → My Laptop → select the project folder → exclude .llm-wiki-local/.",
        commands: [],
      }]
    case "synology-drive":
      return [{
        label: "Synology Drive Client",
        note:
          "Drive Client → Global Settings → Sync Rules → Filters → add .llm-wiki-local to the \"Folders not to sync\" list. Applies to every sync task on this client.",
        commands: [],
      }]
    case "fnos-drive":
      return [{
        label: "fnOS Drive Client",
        note:
          "Drive client → edit the sync task → Filter Rules → add .llm-wiki-local. (fnOS 0.9+; on older builds set the exclusion on the NAS side instead.)",
        commands: [],
      }]
    case "qsync":
      return [{
        label: "QNAP Qsync Client",
        note:
          "Qsync Client → Preferences → Filter Settings → add .llm-wiki-local under \"Folders to exclude\".",
        commands: [],
      }]
    case "terrasync":
      return [{
        label: "TerraMaster Sync",
        note:
          "Sync client → Preferences → Exclude rules → add .llm-wiki-local; same rule lives in TerraSync backup tasks.",
        commands: [],
      }]
    case "smb":
    case "afp":
    case "nfs":
    case "webdav":
      return genericNasRecipes(info)
    default:
      return []
  }
}

function genericNasRecipes(info: StorageInfo): ExcludeGroup[] {
  const groups: ExcludeGroup[] = []

  // The most reliable strategy on a bare network mount: don't put
  // .llm-wiki-local/ on the share at all. Keep it in a per-device
  // local cache and symlink it into the project.
  groups.push({
    label: "Generic network share (recommended)",
    note:
      "Move .llm-wiki-local/ to a per-device local cache and symlink it back into the project. Chats stay private to each device; no exclusion needed because the directory is no longer on the share.",
    commands: [
      "mkdir -p ~/.llm-wiki-local-cache/$(basename \"$PWD\")",
      "mv .llm-wiki-local ~/.llm-wiki-local-cache/$(basename \"$PWD\")/llm-wiki-local 2>/dev/null || true",
      "ln -s ~/.llm-wiki-local-cache/$(basename \"$PWD\")/llm-wiki-local .llm-wiki-local",
    ],
  })

  // Vendor-specific tweaks if we recognised the mount.
  if (info.vendorHint === "synology") {
    groups.push({
      label: "Synology — exclude on NAS side",
      note:
        "DSM → Control Panel → Shared Folder → edit your share → Advanced → \"Hide folders\" → add .llm-wiki-local. Also: install Synology Drive Client locally and switch to client-sync mode for faster + watchable access.",
      commands: [],
    })
  } else if (info.vendorHint === "fnos") {
    groups.push({
      label: "fnOS (FeiNiu) — exclude on NAS side",
      note:
        "fnOS Web → Shared Folders → edit → Hide Folders → add .llm-wiki-local. Or use the fnOS Drive client (recommended) — it syncs to a local path so Source Watch works.",
      commands: [],
    })
  } else if (info.vendorHint === "qnap") {
    groups.push({
      label: "QNAP — exclude on NAS side",
      note:
        "Control Panel → Privilege → Shared Folders → edit → Advanced → Hidden folder list. Or move to Qsync client mode for local-path performance.",
      commands: [],
    })
  } else if (info.vendorHint === "terramaster") {
    groups.push({
      label: "TerraMaster — exclude on NAS side",
      note:
        "TOS → Control Panel → File Sharing → Shared Folder → edit → Hidden Folder rules. Or use TerraSync client for local-cache mode.",
      commands: [],
    })
  }

  return groups
}
