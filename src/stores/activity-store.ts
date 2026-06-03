import { create } from "zustand"

export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query"
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
  createdAt: number
  /**
   * Absolute path of the source file this activity ingested, when known.
   * Set for classic source-ingest items so an interrupted/errored run can
   * offer a one-click "Resume" — re-enqueueing the same path transparently
   * resumes from the long-source checkpoint (see ingest.ts). Persisted
   * across reloads, so resume survives the webview teardown that caused
   * the interruption in the first place. Absent for lint/query items.
   */
  sourcePath?: string
  /**
   * Determinate progress for a long, multi-step run (e.g. a big source
   * analyzed in hundreds of chunks). When present, the activity row draws
   * a progress bar + percentage instead of just a spinner, so the user can
   * see it advancing. `etaMs` is a rough estimate from the rate of chunks
   * completed this session (omitted until there's enough data). Cleared
   * once the chunked phase finishes.
   */
  progress?: { current: number; total: number; etaMs?: number }
}

interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten" | "progress">>) => void
  removeItem: (id: string) => void
  appendDetail: (id: string, text: string) => void
  clearDone: () => void
  /**
   * Replace the entire item list — used by the App startup hydration
   * path. Caller is responsible for normalising the input (e.g. flipping
   * stale "running" entries to "error", since the actual task process
   * died with the previous webview).
   */
  setItems: (items: ActivityItem[]) => void
}

let counter = 0

export const useActivityStore = create<ActivityState>((set) => ({
  items: [],

  addItem: (item) => {
    const id = `activity-${++counter}`
    set((state) => ({
      items: [
        { ...item, id, createdAt: Date.now() },
        ...state.items,
      ],
    }))
    return id
  },

  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  appendDetail: (id, text) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, detail: item.detail + text } : item
      ),
    })),

  clearDone: () =>
    set((state) => ({
      items: state.items.filter((i) => i.status === "running"),
    })),

  setItems: (items) => {
    // Bump the counter past anything we just loaded so freshly-added
    // ids don't collide with hydrated ones.
    for (const it of items) {
      const m = /^activity-(\d+)$/.exec(it.id)
      if (m) counter = Math.max(counter, Number(m[1]))
    }
    set({ items })
  },
}))
