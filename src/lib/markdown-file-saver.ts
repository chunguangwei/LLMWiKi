import { writeFile } from "@/commands/fs"

export type MarkdownSaveEvent = {
  path: string
  contents: string
  revision: number
  phase: "started" | "saved" | "error"
  error?: unknown
}

export interface MarkdownSaveSnapshot {
  contents: string
  savedContents: string
  revision: number
  savedRevision: number
  dirty: boolean
  pending: boolean
  running: boolean
  error: unknown | null
}

export interface MarkdownSaveFailure {
  path: string
  error: unknown
}

type SaveEntry = {
  contents: string
  savedContents: string
  revision: number
  savedRevision: number
  pendingRevision: number | null
  timer: ReturnType<typeof setTimeout> | null
  tail: Promise<void>
  running: number
  error: unknown | null
}

type WriteMarkdown = (path: string, contents: string) => Promise<void>

export class MarkdownFileSaver {
  private readonly entries = new Map<string, SaveEntry>()
  private readonly invalidated = new Set<string>()
  private readonly listeners = new Set<(event: MarkdownSaveEvent & { external?: boolean }) => void>()

  constructor(
    private readonly write: WriteMarkdown = writeFile,
    private readonly delay = 1000,
  ) {}

  subscribe(listener: (event: MarkdownSaveEvent & { external?: boolean }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(path: string): MarkdownSaveSnapshot | null {
    const entry = this.entries.get(path)
    if (!entry || this.invalidated.has(path)) return null
    return {
      contents: entry.contents,
      savedContents: entry.savedContents,
      revision: entry.revision,
      savedRevision: entry.savedRevision,
      dirty: entry.savedRevision < entry.revision,
      pending: entry.pendingRevision !== null,
      running: entry.running > 0,
      error: entry.error,
    }
  }

  activate(path: string): void {
    if (!this.entries.has(path)) this.invalidated.delete(path)
  }

  schedule(path: string, contents: string, immediate = false): number | null {
    if (this.invalidated.has(path)) return null
    const entry = this.entry(path)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.contents = contents
    entry.revision += 1
    entry.pendingRevision = entry.revision
    entry.error = null

    if (immediate) {
      void this.flush(path)
    } else {
      entry.timer = setTimeout(() => {
        entry.timer = null
        void this.flush(path)
      }, this.delay)
    }
    return entry.revision
  }

  async flush(path: string): Promise<void> {
    if (this.invalidated.has(path)) return
    const entry = this.entries.get(path)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    if (entry.pendingRevision !== null) {
      const revision = entry.pendingRevision
      const contents = entry.contents
      entry.pendingRevision = null
      entry.running += 1
      const operation = entry.tail.then(async () => {
        if (this.invalidated.has(path)) return false
        this.emit({ path, contents, revision, phase: "started" })
        await this.write(path, contents)
        return true
      })
      entry.tail = operation.then(
        (written) => {
          if (!written || this.invalidated.has(path)) return
          if (revision >= entry.savedRevision) {
            entry.savedRevision = revision
            entry.savedContents = contents
          }
          if (entry.revision === revision) entry.error = null
          this.emit({ path, contents, revision, phase: "saved" })
        },
        (error: unknown) => {
          if (this.invalidated.has(path)) return
          if (entry.revision === revision) entry.error = error
          this.emit({ path, contents, revision, phase: "error", error })
        },
      ).finally(() => {
        entry.running -= 1
      })
    }

    await entry.tail
  }

  async waitFor(path: string): Promise<void> {
    for (;;) {
      if (this.invalidated.has(path)) return
      await this.flush(path)
      const entry = this.entries.get(path)
      if (!entry || (entry.pendingRevision === null && entry.running === 0)) return
    }
  }

  async waitForPrefix(prefix: string): Promise<void> {
    const normalized = prefix.replace(/\\/g, "/").replace(/\/+$/, "")
    await Promise.all([...this.entries.keys()]
      .filter((path) => {
        const candidate = path.replace(/\\/g, "/")
        return candidate === normalized || candidate.startsWith(`${normalized}/`)
      })
      .map((path) => this.waitFor(path)))
  }

  async flushAll(): Promise<MarkdownSaveFailure[]> {
    for (;;) {
      const paths = [...this.entries.keys()].filter((path) => !this.invalidated.has(path))
      await Promise.all(paths.map((path) => this.waitFor(path)))
      if ([...this.entries.values()].every((entry) => entry.pendingRevision === null && entry.running === 0)) {
        return paths.flatMap((path) => {
          const snapshot = this.getSnapshot(path)
          return snapshot?.dirty && snapshot.error ? [{ path, error: snapshot.error }] : []
        })
      }
    }
  }

  async invalidate(path: string): Promise<MarkdownSaveSnapshot | null> {
    const snapshot = this.getSnapshot(path)
    this.invalidated.add(path)
    const entry = this.entries.get(path)
    if (!entry) return snapshot
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.pendingRevision = null
    await entry.tail
    if (this.entries.get(path) === entry) this.entries.delete(path)
    return snapshot
  }

  restoreInvalidated(path: string, snapshot: MarkdownSaveSnapshot | null): void {
    if (!snapshot || !this.invalidated.has(path) || this.entries.has(path)) return
    const entry = this.entry(path)
    entry.contents = snapshot.contents
    entry.savedContents = snapshot.savedContents
    entry.revision = snapshot.revision
    entry.savedRevision = snapshot.savedRevision
    entry.pendingRevision = snapshot.dirty ? snapshot.revision : null
    entry.error = snapshot.error
    this.invalidated.delete(path)
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const normalized = prefix.replace(/\\/g, "/").replace(/\/+$/, "")
    const paths = new Set([...this.entries.keys(), ...this.invalidated])
    await Promise.all([...paths]
      .filter((path) => {
        const candidate = path.replace(/\\/g, "/")
        return candidate === normalized || candidate.startsWith(`${normalized}/`)
      })
      .map((path) => this.invalidate(path)))
  }

  async writeExternal(
    path: string,
    fallbackContents: string,
    operation: (currentContents: string) => Promise<string>,
  ): Promise<string> {
    this.activate(path)
    await this.waitFor(path)
    if (this.invalidated.has(path)) throw new Error(`Cannot write deleted file: ${path}`)
    const entry = this.entry(path)
    if (entry.error) throw entry.error
    const currentContents = entry.savedRevision > 0 ? entry.savedContents : fallbackContents
    const previousRevision = entry.revision
    const revision = previousRevision + 1
    entry.revision = revision
    entry.running += 1
    this.emit({ path, contents: currentContents, revision, phase: "started" })

    const pending = entry.tail.then(() => operation(currentContents))
    entry.tail = pending.then(
      (contents) => {
        if (this.invalidated.has(path)) return
        entry.savedContents = contents
        entry.savedRevision = revision
        if (entry.revision === revision) entry.contents = contents
        entry.error = null
        this.emit({ path, contents, revision, phase: "saved", external: true })
      },
      () => {
        if (entry.revision === revision) entry.revision = previousRevision
      },
    ).finally(() => {
      entry.running -= 1
    })
    return pending
  }

  private entry(path: string): SaveEntry {
    let entry = this.entries.get(path)
    if (!entry) {
      entry = {
        contents: "",
        savedContents: "",
        revision: 0,
        savedRevision: 0,
        pendingRevision: null,
        timer: null,
        tail: Promise.resolve(),
        running: 0,
        error: null,
      }
      this.entries.set(path, entry)
    }
    return entry
  }

  private emit(event: MarkdownSaveEvent & { external?: boolean }): void {
    for (const listener of this.listeners) listener(event)
  }
}

export const markdownFileSaver = new MarkdownFileSaver()
