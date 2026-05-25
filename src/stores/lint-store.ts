import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

export interface LintItem {
  id: string
  type: LintResult["type"]
  severity: LintResult["severity"]
  page: string
  detail: string
  affectedPages?: string[]
  createdAt: number
}

function lintResultToItem(result: LintResult): LintItem {
  return {
    type: result.type,
    severity: result.severity,
    page: result.page,
    detail: result.detail,
    affectedPages: result.affectedPages,
    id: `lint-${++counter}`,
    createdAt: Date.now(),
  }
}

interface LintState {
  items: LintItem[]
  setItems: (items: LintItem[]) => void
  addItems: (results: LintResult[]) => void
  removeItem: (id: string) => void
  clearItems: () => void
}

let counter = 0

export const useLintStore = create<LintState>((set) => ({
  items: [],

  setItems: (items) => set({ items }),

  addItems: (results) =>
    set((state) => ({
      items: [...state.items, ...results.map(lintResultToItem)],
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearItems: () => set({ items: [] }),
}))