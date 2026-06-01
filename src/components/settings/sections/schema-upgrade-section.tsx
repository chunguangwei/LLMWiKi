import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Sparkles, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  readFile,
  writeFile,
  createDirectory,
  fileExists,
  listDirectory,
} from "@/commands/fs"
import { getTemplate, type SchemaLang } from "@/lib/templates"
import { normalizePath } from "@/lib/path-utils"
import i18n from "@/i18n"

/**
 * Schema Upgrade section — one-click migration of legacy 5-template schema.md
 * to the new comprehensive schema (34 categories, single-page rules).
 *
 * What it does (and does NOT do):
 *   - Backs up the current schema.md to schema.md.bak-YYYYMMDD
 *   - Overwrites schema.md with the comprehensive template (lang follows UI)
 *   - Pre-creates the 34 category directories (.gitkeep stubs)
 *   - Leaves existing wiki/entities/, wiki/concepts/, wiki/sources/ files
 *     where they are — does NOT auto-classify them. Future imports route
 *     to the new directories per the new schema; old pages stay put.
 *
 * The user can run a re-ingest (delete cache + re-import) later if they
 * want existing pages re-routed; that is intentionally a separate manual
 * step because LLM-driven file relocation is expensive and error-prone.
 */
export function SchemaUpgradeSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const [currentSchema, setCurrentSchema] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const [result, setResult] = useState<{ kind: "ok" | "err"; message: string } | null>(null)

  const lang: SchemaLang = i18n.language.startsWith("zh") ? "zh" : "en"

  const refresh = useCallback(async () => {
    if (!project?.path) {
      setCurrentSchema(null)
      return
    }
    setLoading(true)
    try {
      const pp = normalizePath(project.path)
      const exists = await fileExists(`${pp}/schema.md`)
      if (exists) {
        const content = await readFile(`${pp}/schema.md`)
        setCurrentSchema(content)
      } else {
        setCurrentSchema(null)
      }
    } catch (e) {
      console.error("[schema-upgrade] failed to read schema.md:", e)
      setCurrentSchema(null)
    } finally {
      setLoading(false)
    }
  }, [project?.path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Detect whether the current schema is a legacy / pre-comprehensive one.
  // Heuristic: the comprehensive template has a distinctive title; anything
  // else is treated as upgradable. (False positives here are harmless —
  // upgrading is opt-in via the button and creates a backup.)
  const isAlreadyComprehensive = currentSchema
    ? currentSchema.includes("# Wiki Schema — 综合（推荐默认）") ||
      currentSchema.includes("# Wiki Schema — Comprehensive (Recommended Default)")
    : false

  const upgrade = useCallback(async () => {
    if (!project?.path || upgrading) return
    setUpgrading(true)
    setResult(null)
    try {
      const pp = normalizePath(project.path)
      const template = getTemplate("comprehensive", lang)

      // 1. Backup current schema.md → schema.md.bak-YYYYMMDD
      if (currentSchema !== null) {
        const date = new Date().toISOString().slice(0, 10)
        const backupPath = `${pp}/schema.md.bak-${date}`
        await writeFile(backupPath, currentSchema)
      }

      // 2. Write new schema
      await writeFile(`${pp}/schema.md`, template.schema)

      // 3. Pre-create the 34 category directories. createDirectory is
      //    idempotent (mkdir -p semantics), so safe to call even when a
      //    dir already exists (e.g. wiki/concepts/ from the old schema).
      for (const dir of template.extraDirs) {
        try {
          await createDirectory(`${pp}/${dir}`)
        } catch (e) {
          console.warn(`[schema-upgrade] mkdir failed for ${dir}:`, e)
        }
      }

      // 4. Refresh tree + bump data version so the file panel updates.
      try {
        const tree = await listDirectory(pp)
        setFileTree(tree)
        bumpDataVersion()
      } catch {
        // non-critical
      }

      await refresh()
      setResult({ kind: "ok", message: t("settings.sections.schemaUpgrade.success") })
    } catch (e) {
      console.error("[schema-upgrade] upgrade failed:", e)
      setResult({ kind: "err", message: String(e) })
    } finally {
      setUpgrading(false)
    }
  }, [project?.path, upgrading, currentSchema, lang, refresh, t, bumpDataVersion, setFileTree])

  if (!project) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t("settings.sections.schemaUpgrade.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.sections.schemaUpgrade.noProject")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("settings.sections.schemaUpgrade.title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sections.schemaUpgrade.description")}
        </p>
      </div>

      <div className="rounded-md border bg-muted/30 p-4 space-y-3">
        <h3 className="text-sm font-medium">{t("settings.sections.schemaUpgrade.whatItDoes")}</h3>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>{t("settings.sections.schemaUpgrade.point1")}</li>
          <li>{t("settings.sections.schemaUpgrade.point2")}</li>
          <li>{t("settings.sections.schemaUpgrade.point3")}</li>
          <li>{t("settings.sections.schemaUpgrade.point4")}</li>
        </ul>
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div>
            <h3 className="text-sm font-medium">{t("settings.sections.schemaUpgrade.warningTitle")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {t("settings.sections.schemaUpgrade.warningBody")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm">
          <span className="text-muted-foreground">{t("settings.sections.schemaUpgrade.currentStatus")}：</span>
          {loading ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("settings.sections.schemaUpgrade.loading")}
            </span>
          ) : isAlreadyComprehensive ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              {t("settings.sections.schemaUpgrade.alreadyComprehensive")}
            </span>
          ) : currentSchema === null ? (
            <span className="text-muted-foreground">{t("settings.sections.schemaUpgrade.notFound")}</span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">{t("settings.sections.schemaUpgrade.legacy")}</span>
          )}
        </div>

        <Button
          onClick={upgrade}
          disabled={upgrading || loading || isAlreadyComprehensive}
          className="gap-2"
        >
          {upgrading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("settings.sections.schemaUpgrade.upgrading")}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              {t("settings.sections.schemaUpgrade.button")}
            </>
          )}
        </Button>
      </div>

      {result && (
        <div
          className={
            result.kind === "ok"
              ? "rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300"
              : "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          }
        >
          {result.message}
        </div>
      )}
    </div>
  )
}
