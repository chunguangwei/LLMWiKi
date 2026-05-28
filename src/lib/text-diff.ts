// Minimal line-level diff (LCS-based), pure TS, no dependencies.
// Used to preview an LLM-proposed wiki page edit (old vs new) before the
// user applies it. Wiki pages are small (hundreds of lines at most), so
// the O(n·m) LCS table is fine.

export type DiffLineType = "ctx" | "add" | "del"

export interface DiffLine {
  type: DiffLineType
  text: string
}

/**
 * Compute a line-level diff between `oldText` and `newText`.
 * Returns lines in display order: unchanged ("ctx"), removed ("del"),
 * and added ("add"). A pure replacement shows as del lines followed by
 * add lines.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n")
  const b = newText.replace(/\r\n/g, "\n").split("\n")
  const n = a.length
  const m = b.length

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i] })
      i++
    } else {
      out.push({ type: "add", text: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] })
    i++
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] })
    j++
  }
  return out
}

export interface DiffStats {
  added: number
  removed: number
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === "add") added++
    else if (l.type === "del") removed++
  }
  return { added, removed }
}

/** True when the two texts are identical ignoring trailing whitespace/EOF newline. */
export function isUnchanged(oldText: string, newText: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "")
  return norm(oldText) === norm(newText)
}
