import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { open, save, message } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Download, Upload, FileSearch, Loader2 } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  exportPackage,
  importPackage,
  inspectPackage,
  suggestPackageFileName,
} from "@/lib/package"
import type { PackageManifest, ConflictStrategy } from "@/lib/package-manifest"

const APP_VERSION = "0.4.10" // matches Cargo.toml — bump together on releases

export function ImportExportSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)

  const [exportedBy, setExportedBy] = useState("")
  const [includePageHistory, setIncludePageHistory] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [conflictStrategy, setConflictStrategy] =
    useState<ConflictStrategy>("skip-existing")
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [inspectResult, setInspectResult] = useState<PackageManifest | null>(null)

  const handleExport = useCallback(async () => {
    if (!project || exporting) return
    const defaultName = suggestPackageFileName(project.name)
    const target = await save({
      title: t("settings.sections.importExport.exportTitle", {
        defaultValue: "Export wiki package",
      }),
      defaultPath: defaultName,
      filters: [{ name: "LLM Wiki Package", extensions: ["llmwiki"] }],
    })
    if (!target) return

    setExporting(true)
    setLastResult(null)
    try {
      const manifest = await exportPackage(project.path, target, {
        app_version: APP_VERSION,
        project_name: project.name,
        exported_by: exportedBy.trim() || null,
        includes: { page_history: includePageHistory, embeddings: false },
      })
      setLastResult(
        t("settings.sections.importExport.exportSuccess", {
          defaultValue: "Exported {{count}} files to {{path}}",
          count: manifest.files.length,
          path: target,
        }),
      )
    } catch (err) {
      await message(String(err), {
        kind: "error",
        title: t("settings.sections.importExport.exportFailed", {
          defaultValue: "Export failed",
        }),
      })
    } finally {
      setExporting(false)
    }
  }, [project, exporting, exportedBy, includePageHistory, t])

  const handleInspect = useCallback(async () => {
    if (inspecting) return
    const selected = await open({
      title: t("settings.sections.importExport.inspectTitle", {
        defaultValue: "Inspect wiki package",
      }),
      filters: [{ name: "LLM Wiki Package", extensions: ["llmwiki"] }],
    })
    if (!selected || typeof selected !== "string") return

    setInspecting(true)
    setLastResult(null)
    setInspectResult(null)
    try {
      const manifest = await inspectPackage(selected)
      setInspectResult(manifest)
    } catch (err) {
      await message(String(err), {
        kind: "error",
        title: t("settings.sections.importExport.inspectFailed", {
          defaultValue: "Inspect failed",
        }),
      })
    } finally {
      setInspecting(false)
    }
  }, [inspecting, t])

  const handleImport = useCallback(async () => {
    if (importing) return
    const pkg = await open({
      title: t("settings.sections.importExport.selectPackage", {
        defaultValue: "Select package to import",
      }),
      filters: [{ name: "LLM Wiki Package", extensions: ["llmwiki"] }],
    })
    if (!pkg || typeof pkg !== "string") return

    const target = await open({
      directory: true,
      title: t("settings.sections.importExport.selectTargetDir", {
        defaultValue: "Choose target directory for the imported project",
      }),
    })
    if (!target || typeof target !== "string") return

    setImporting(true)
    setLastResult(null)
    try {
      const result = await importPackage(pkg, target, {
        conflict_strategy: conflictStrategy,
      })
      setLastResult(
        t("settings.sections.importExport.importSuccess", {
          defaultValue:
            "Imported {{written}} files (skipped {{skipped}}, mismatches {{mismatches}}) into {{path}}",
          written: result.files_written,
          skipped: result.files_skipped,
          mismatches: result.checksum_mismatches.length,
          path: target,
        }),
      )
    } catch (err) {
      await message(String(err), {
        kind: "error",
        title: t("settings.sections.importExport.importFailed", {
          defaultValue: "Import failed",
        }),
      })
    } finally {
      setImporting(false)
    }
  }, [importing, conflictStrategy, t])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.importExport.title", {
            defaultValue: "Import / Export",
          })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.importExport.description", {
            defaultValue:
              "Bundle the current project into a portable .llmwiki package for cross-device or team transfer. Chat history is intentionally excluded.",
          })}
        </p>
      </div>

      {/* Export */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.importExport.exportHeader", { defaultValue: "Export" })}
          </h3>
        </div>

        <div className="space-y-2">
          <Label htmlFor="exportedBy">
            {t("settings.sections.importExport.exportedBy", {
              defaultValue: "Your name (optional)",
            })}
          </Label>
          <Input
            id="exportedBy"
            value={exportedBy}
            onChange={(e) => setExportedBy(e.target.value)}
            placeholder={t("settings.sections.importExport.exportedByPlaceholder", {
              defaultValue: "Recorded in the package manifest",
            })}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includePageHistory}
            onChange={(e) => setIncludePageHistory(e.target.checked)}
          />
          {t("settings.sections.importExport.includePageHistory", {
            defaultValue: "Include page history (larger package)",
          })}
        </label>

        <Button
          onClick={handleExport}
          disabled={!project || exporting}
          className="w-full"
        >
          {exporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.importExport.exporting", {
                defaultValue: "Packing…",
              })}
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              {t("settings.sections.importExport.exportNow", {
                defaultValue: "Export package…",
              })}
            </>
          )}
        </Button>
        {!project && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.importExport.openProjectFirst", {
              defaultValue: "Open a project first.",
            })}
          </p>
        )}
      </div>

      {/* Inspect */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <FileSearch className="h-4 w-4" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.importExport.inspectHeader", {
              defaultValue: "Inspect package",
            })}
          </h3>
        </div>
        <Button variant="outline" onClick={handleInspect} disabled={inspecting}>
          {inspecting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.importExport.inspecting", {
                defaultValue: "Reading manifest…",
              })}
            </>
          ) : (
            t("settings.sections.importExport.inspectNow", {
              defaultValue: "Choose .llmwiki…",
            })
          )}
        </Button>
        {inspectResult && (
          <div className="rounded bg-muted/40 p-3 text-xs">
            <div><b>{inspectResult.project_name}</b> — schema v{inspectResult.schema_version}</div>
            <div>{t("settings.sections.importExport.appVersion", { defaultValue: "App version" })}: {inspectResult.app_version}</div>
            <div>{t("settings.sections.importExport.exportedAt", { defaultValue: "Exported" })}: {inspectResult.exported_at}</div>
            {inspectResult.exported_by && (
              <div>{t("settings.sections.importExport.exportedBy", { defaultValue: "By" })}: {inspectResult.exported_by}</div>
            )}
            <div>{t("settings.sections.importExport.fileCount", { defaultValue: "Files" })}: {inspectResult.files.length}</div>
          </div>
        )}
      </div>

      {/* Import */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.importExport.importHeader", { defaultValue: "Import" })}
          </h3>
        </div>

        <div className="space-y-2">
          <Label>{t("settings.sections.importExport.conflictStrategy", {
            defaultValue: "If target files already exist",
          })}</Label>
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="conflict"
                checked={conflictStrategy === "skip-existing"}
                onChange={() => setConflictStrategy("skip-existing")}
              />
              {t("settings.sections.importExport.skipExisting", {
                defaultValue: "Skip existing files (safe)",
              })}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="conflict"
                checked={conflictStrategy === "overwrite-all"}
                onChange={() => setConflictStrategy("overwrite-all")}
              />
              {t("settings.sections.importExport.overwriteAll", {
                defaultValue: "Overwrite everything",
              })}
            </label>
          </div>
        </div>

        <Button onClick={handleImport} disabled={importing}>
          {importing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.importExport.importing", {
                defaultValue: "Importing…",
              })}
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              {t("settings.sections.importExport.importNow", {
                defaultValue: "Import .llmwiki…",
              })}
            </>
          )}
        </Button>
      </div>

      {lastResult && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          {lastResult}
        </div>
      )}
    </div>
  )
}
