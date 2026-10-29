import { useCallback, useEffect, useRef, useState } from "react"
import { listDirectory } from "@/commands/fs"
import { listIngestedSourceIdentities } from "@/lib/ingest-cache"
import { filterRawSourceTree } from "@/lib/source-filter"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode, WikiProject } from "@/types/wiki"

interface Snapshot {
  key: string
  scope: string
  ready: boolean
  sources: FileNode[]
  identities: string[]
  error: string | null
}

/** Publish directory and ingest status together, and discard obsolete reads. */
export function useSourceSnapshot(project: WikiProject | null, dataVersion: number) {
  const path = project ? normalizePath(project.path) : null
  const scope = JSON.stringify([project?.id, path])
  const key = JSON.stringify([scope, dataVersion])
  const currentKey = useRef(key)
  currentKey.current = key
  const generation = useRef(0)
  const mounted = useRef(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const reload = useCallback(async () => {
    if (!mounted.current || currentKey.current !== key || !path) return
    const request = ++generation.current
    setSnapshot((previous) => ({
      key, scope, ready: false, error: null,
      sources: previous?.scope === scope ? previous.sources : [],
      identities: previous?.scope === scope ? previous.identities : [],
    }))
    try {
      const [tree, identities] = await Promise.all([
        listDirectory(path + "/raw/sources", true),
        listIngestedSourceIdentities(path),
      ])
      if (mounted.current && currentKey.current === key && generation.current === request) {
        setSnapshot({ key, scope, ready: true, sources: filterRawSourceTree(tree), identities, error: null })
      }
    } catch (error) {
      if (mounted.current && currentKey.current === key && generation.current === request) {
        setSnapshot((previous) => ({
          key, scope, ready: false, error: String(error),
          sources: previous?.scope === scope ? previous.sources : [],
          identities: previous?.scope === scope ? previous.identities : [],
        }))
      }
    }
  }, [key, scope, path])
  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; generation.current++ }
  }, [reload])
  const current = snapshot?.scope === scope ? snapshot : null
  return {
    sources: current?.sources ?? [],
    identities: current?.identities ?? [],
    ready: current?.key === key && current.ready,
    error: current?.key === key ? current.error : null,
    reload,
  }
}
