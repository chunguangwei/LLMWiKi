import { useCallback, useEffect, useRef, useState } from "react"
import { markdownFileSaver, type MarkdownSaveSnapshot } from "@/lib/markdown-file-saver"

export type MarkdownSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

export interface MarkdownAutoSaveState {
  status: MarkdownSaveStatus
  error: string | null
}

function saveError(error: unknown): string | null {
  if (error == null) return null
  return error instanceof Error ? error.message : String(error)
}

function statusFor(snapshot: MarkdownSaveSnapshot | null): MarkdownAutoSaveState {
  if (!snapshot?.dirty) return { status: "idle", error: null }
  if (snapshot.error) return { status: "error", error: saveError(snapshot.error) }
  return { status: snapshot.pending ? "dirty" : "saving", error: null }
}

export function useMarkdownAutoSave(
  path: string | null,
  onSaved: (path: string, contents: string) => void,
) {
  const [state, setState] = useState<MarkdownAutoSaveState>({ status: "idle", error: null })
  const pathRef = useRef(path)
  const revisionRef = useRef(0)
  const loadedRef = useRef<{ path: string; contents: string; revision: number } | null>(null)
  const draftRef = useRef<{ path: string; contents: string } | null>(null)
  const onSavedRef = useRef(onSaved)
  pathRef.current = path
  onSavedRef.current = onSaved

  useEffect(() => {
    const snapshot = path ? markdownFileSaver.getSnapshot(path) : null
    revisionRef.current = snapshot?.revision ?? 0
    setState(statusFor(snapshot))
    if (!path) return
    return () => {
      void markdownFileSaver.flush(path)
    }
  }, [path])

  useEffect(() => markdownFileSaver.subscribe((event) => {
    if (event.path !== pathRef.current) return
    if (event.phase === "started") {
      if (event.revision === revisionRef.current) setState({ status: "saving", error: null })
      return
    }
    if (event.phase === "saved") {
      const loaded = loadedRef.current
      if (loaded?.path === event.path && event.revision >= loaded.revision) {
        loadedRef.current = { path: event.path, contents: event.contents, revision: event.revision }
      }
      if (event.revision < revisionRef.current) return
      if (event.external) {
        loadedRef.current = { path: event.path, contents: event.contents, revision: event.revision }
        draftRef.current = { path: event.path, contents: event.contents }
        revisionRef.current = event.revision
        onSavedRef.current(event.path, event.contents)
        setState({ status: "saved", error: null })
        return
      }
      if (event.revision !== revisionRef.current) return
      if (draftRef.current?.path === event.path && draftRef.current.contents === event.contents) {
        onSavedRef.current(event.path, event.contents)
      }
      setState({ status: "saved", error: null })
      return
    }
    if (event.revision === revisionRef.current) {
      setState({ status: "error", error: saveError(event.error) })
    }
  }), [])

  const markLoaded = useCallback((loadedPath: string, diskContents: string, options?: { cached?: boolean }): string => {
    markdownFileSaver.activate(loadedPath)
    const snapshot = markdownFileSaver.getSnapshot(loadedPath)
    const useSaved = options?.cached && snapshot && !snapshot.dirty
    const restored = snapshot?.dirty ? snapshot.contents : useSaved ? snapshot.savedContents : diskContents
    loadedRef.current = {
      path: loadedPath,
      contents: useSaved ? snapshot.savedContents : diskContents,
      revision: snapshot?.savedRevision ?? 0,
    }
    draftRef.current = { path: loadedPath, contents: restored }
    revisionRef.current = snapshot?.revision ?? 0
    if (pathRef.current === loadedPath) setState(statusFor(snapshot))
    return restored
  }, [])

  const startSave = useCallback((savePath: string, markdown: string, immediate: boolean): boolean => {
    const revision = markdownFileSaver.schedule(savePath, markdown, immediate)
    if (revision === null) return false
    draftRef.current = { path: savePath, contents: markdown }
    revisionRef.current = revision
    setState({ status: immediate ? "saving" : "dirty", error: null })
    return true
  }, [])

  const handleSave = useCallback(async (markdown: string, options?: { immediate?: boolean }): Promise<void> => {
    const savePath = pathRef.current
    if (!savePath) return
    const snapshot = markdownFileSaver.getSnapshot(savePath)
    const draft = draftRef.current?.path === savePath ? draftRef.current.contents : null
    const immediate = options?.immediate ?? false

    if (markdown === draft) {
      if (immediate && snapshot?.dirty) {
        if (snapshot.error) startSave(savePath, markdown, true)
        else {
          setState({ status: "saving", error: null })
          void markdownFileSaver.flush(savePath)
        }
        await markdownFileSaver.waitFor(savePath)
        const error = markdownFileSaver.getSnapshot(savePath)?.error
        if (error) throw error
      }
      return
    }

    const loaded = loadedRef.current
    if (!snapshot?.dirty && loaded?.path === savePath && markdown === loaded.contents) {
      draftRef.current = { path: savePath, contents: markdown }
      setState({ status: "idle", error: null })
      return
    }
    if (immediate && startSave(savePath, markdown, true)) {
      await markdownFileSaver.waitFor(savePath)
      const error = markdownFileSaver.getSnapshot(savePath)?.error
      if (error) throw error
    } else if (!immediate) {
      startSave(savePath, markdown, false)
    }
  }, [startSave])

  const retry = useCallback(() => {
    const savePath = pathRef.current
    const draft = draftRef.current
    if (savePath && draft?.path === savePath) startSave(savePath, draft.contents, true)
  }, [startSave])

  return { ...state, handleSave, markLoaded, retry }
}
