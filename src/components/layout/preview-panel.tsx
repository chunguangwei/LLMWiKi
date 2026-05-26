import { useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { parseFrontmatter, setFrontmatterType } from "@/lib/frontmatter"
import { recategorizeIndexEntry } from "@/lib/index-recategorize"
import { WIKI_TYPE_OPTIONS } from "@/lib/wiki-type-options"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName, normalizePath } from "@/lib/path-utils"

type TFn = (key: string, opts?: { lng?: string }) => string

/**
 * Best-effort sync of `wiki/index.md` after a page's type changes: move
 * its catalog bullet to the section matching the new type. Resolves the
 * index path from the page path, computes localized + English heading
 * aliases so it matches whatever the LLM wrote, and no-ops on any failure
 * (missing index, unknown type) — the type change itself already stuck.
 */
async function syncIndexForType(pagePath: string, pageContent: string, newType: string, t: TFn) {
  const marker = "/wiki/"
  const norm = normalizePath(pagePath)
  const at = norm.indexOf(marker)
  if (at === -1) return
  const indexPath = norm.slice(0, at + marker.length) + "index.md"

  let indexContent: string
  try {
    indexContent = await readFile(indexPath)
  } catch {
    return
  }

  const opt = WIKI_TYPE_OPTIONS.find((o) => o.value === newType)
  if (!opt) return
  const dedup = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const srcKey = "knowledgeTree.types.source"
  const slug = getFileName(pagePath).replace(/\.md$/, "")
  const { frontmatter } = parseFrontmatter(pageContent)
  const desc =
    (typeof frontmatter?.description === "string" && frontmatter.description) ||
    (typeof frontmatter?.title === "string" && frontmatter.title) ||
    ""

  const next = recategorizeIndexEntry(indexContent, {
    slug,
    targetLabel: t(opt.labelKey),
    targetAliases: dedup([t(opt.labelKey), t(opt.labelKey, { lng: "en" }), t(opt.labelKey, { lng: "zh" })]),
    sourcesAliases: dedup(["Sources", "Source", t(srcKey), t(srcKey, { lng: "en" }), t(srcKey, { lng: "zh" })]),
    fallbackDescription: desc,
  })
  if (next !== indexContent) await writeFile(indexPath, next)
}

export function PreviewPanel() {
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const { t } = useTranslation()
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category)) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }

    readFile(selectedFile)
      .then((content) => {
        lastLoadedRef.current = content
        setFileContent(content)
      })
      .catch((err) => {
        lastLoadedRef.current = ""
        setFileContent(`Error loading file: ${err}`)
      })
  }, [selectedFile, setFileContent])

  const handleSave = useCallback(
    (markdown: string) => {
      if (!selectedFile) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        writeFile(selectedFile, markdown)
          .then(() => {
            // Our own write becomes the new "last loaded" — subsequent
            // re-emits from Milkdown that match this content must not
            // trigger another save.
            lastLoadedRef.current = markdown
          })
          .catch((err) => console.error("Failed to save:", err))
      }, 1000)
    },
    [selectedFile]
  )

  // Reassign the page's frontmatter `type:` straight from the preview's
  // type chip. Writes immediately (no debounce — it's a deliberate single
  // action), updates the in-memory content + last-loaded snapshot so the
  // editor's auto-save doesn't fight it, and bumps dataVersion so the
  // left knowledge tree regroups the page.
  const handleChangeType = useCallback(
    (newType: string) => {
      if (!selectedFile) return
      const pagePath = selectedFile
      const before = fileContent
      const next = setFrontmatterType(before, newType)
      const run = async () => {
        if (next !== before) {
          await writeFile(pagePath, next)
          lastLoadedRef.current = next
          setFileContent(next)
        }
        // Keep index.md's catalog in step (best-effort; uses the
        // pre-change content for the page's title/description).
        await syncIndexForType(pagePath, before, newType, t)
        // Regroup the left knowledge tree.
        bumpDataVersion()
      }
      run().catch((err) => console.error("Failed to change page type:", err))
    },
    [selectedFile, fileContent, setFileContent, bumpDataVersion, t],
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("preview.selectFile", { defaultValue: "Select a file to preview" })}
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = getFileName(selectedFile)
  // The type selector only makes sense for wiki pages the left tree groups
  // by type — not project-root docs (purpose.md/schema.md) or the
  // auto-managed index.md / log.md.
  const isTypeableWikiPage =
    normalizePath(selectedFile).includes("/wiki/") &&
    fileName !== "index.md" &&
    fileName !== "log.md"

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {fileName}
        </span>
        <button
          onClick={() => setSelectedFile(null)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
            onChangeType={isTypeableWikiPage ? handleChangeType : undefined}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
    </div>
  )
}
