import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, ArrowLeft, ArrowRight, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { getFileCategory, isBinary, isExtractedTextPreviewFile } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { FindInPage } from "@/components/editor/find-in-page"
import { MarkdownSaveStatusIndicator } from "@/components/editor/markdown-save-status"
import { Button } from "@/components/ui/button"
import { useMarkdownAutoSave } from "@/hooks/use-markdown-auto-save"
import { markdownFileSaver } from "@/lib/markdown-file-saver"
import { getFileName } from "@/lib/path-utils"

type LoadState = {
  path: string | null
  status: "idle" | "loading" | "loaded" | "error"
  error: string | null
}

export function PreviewPanel() {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const previewBackStack = useWikiStore((s) => s.previewBackStack)
  const previewForwardStack = useWikiStore((s) => s.previewForwardStack)
  const navigatePreviewBack = useWikiStore((s) => s.navigatePreviewBack)
  const navigatePreviewForward = useWikiStore((s) => s.navigatePreviewForward)
  const contentRef = useRef<HTMLDivElement>(null)
  const [loadState, setLoadState] = useState<LoadState>({ path: null, status: "idle", error: null })
  const [reloadToken, setReloadToken] = useState(0)
  const save = useMarkdownAutoSave(selectedFile, (path, contents) => {
    if (useWikiStore.getState().selectedFile === path) setFileContent(contents)
  })
  const handleSave = useCallback((markdown: string, options?: { immediate?: boolean }) => {
    if (useWikiStore.getState().selectedFile === selectedFile) setFileContent(markdown)
    return save.handleSave(markdown, options)
  }, [selectedFile, setFileContent, save.handleSave])

  useEffect(() => {
    let cancelled = false
    const path = selectedFile
    if (!path) {
      setFileContent("")
      setLoadState({ path: null, status: "idle", error: null })
      return
    }

    const restore = (diskContents: string, cached = false) => {
      const restored = save.markLoaded(path, diskContents, { cached })
      if (cancelled) return
      setFileContent(restored)
      setLoadState({ path, status: "loaded", error: null })
    }

    if (externalPreview?.path === path) {
      restore(fileContent)
      return
    }

    const cached = previewContentPath === path
    const category = getFileCategory(path)
    if (!cached && isBinary(category) && !isExtractedTextPreviewFile(path)) {
      setFileContent("")
      setLoadState({ path, status: "loaded", error: null })
      return
    }

    setLoadState({ path, status: "loading", error: null })
    void (async () => {
      try {
        await markdownFileSaver.waitFor(path)
        const diskContents = cached ? fileContent : await readFile(path)
        if (!cancelled) restore(diskContents, cached)
      } catch (error) {
        if (cancelled) return
        setFileContent("")
        setLoadState({ path, status: "error", error: String(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedFile, previewContentPath, externalPreview, reloadToken, save.markLoaded, setFileContent])

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("preview.selectFile")}
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)
  const loading = loadState.path !== selectedFile || loadState.status === "loading"
  const loadError = loadState.path === selectedFile && loadState.status === "error"
    ? loadState.error
    : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b bg-background px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" onClick={navigatePreviewBack} disabled={previewBackStack.length === 0} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30" title={t("preview.back")} aria-label={t("preview.back")}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={navigatePreviewForward} disabled={previewForwardStack.length === 0} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30" title={t("preview.forward")} aria-label={t("preview.forward")}>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <span className="truncate text-xs font-medium text-foreground/75" title={selectedFile}>{fileName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {category === "markdown" && !loading && !loadError && (
            <MarkdownSaveStatusIndicator status={save.status} error={save.error} onRetry={save.retry} />
          )}
          <button type="button" onClick={closePreview} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={t("common.close")} aria-label={t("common.close")}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!loading && !loadError && <FindInPage containerRef={contentRef} resetKey={selectedFile} />}
        <div ref={contentRef} className="h-full min-w-0 overflow-hidden">
          {loading ? (
            <div className="mx-auto w-full max-w-3xl p-6" role="status">
              <span className="sr-only">{t("preview.loadingText")}</span>
              <div className="animate-pulse space-y-5" aria-hidden="true">
                <div className="h-8 w-2/5 rounded-md bg-muted" />
                <div className="h-3 w-full rounded bg-muted/80" />
                <div className="h-3 w-11/12 rounded bg-muted/80" />
                <div className="h-3 w-4/5 rounded bg-muted/80" />
                <div className="h-40 w-full rounded-lg bg-muted/60" />
              </div>
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
              <AlertCircle className="h-7 w-7 text-destructive" />
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("preview.loadFailed", { defaultValue: "Could not load this file" })}</p>
                <p className="max-w-lg break-words text-xs leading-5 text-muted-foreground">{loadError}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((value) => value + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          ) : externalPreview?.path === selectedFile ? (
            <ExternalReferencePreview
              source={externalPreview.source}
              title={externalPreview.title}
              path={externalPreview.url}
              snippet={externalPreview.snippet || fileContent}
            />
          ) : category === "markdown" ? (
            <WikiEditor
              key={selectedFile}
              content={fileContent}
              onSave={handleSave}
              filePath={selectedFile}
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
    </div>
  )
}

function ExternalReferencePreview({
  source,
  title,
  path,
  snippet,
}: {
  source: string
  title: string
  path: string
  snippet: string
}) {
  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {source}
          </span>
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-background p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {snippet || "(No preview fragment returned.)"}
        </pre>
      </div>
    </div>
  )
}
