import { create } from "zustand"

export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query"
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
  createdAt: number
}

interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten">>) => void
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
