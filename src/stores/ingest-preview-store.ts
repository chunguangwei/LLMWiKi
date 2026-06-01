import { create } from "zustand"

/**
 * Preview-before-write gate for autoIngest.
 *
 * UX problem: autoIngest is a leap of faith — you click Ingest,
 * the agent reads the source, the LLM generates wiki pages, and 5
 * minutes later you discover some pages weren't what you wanted
 * (wrong slug, off-topic split, duplicate concept). The damage is
 * already on disk.
 *
 * This store sits between the LLM "what to write" stage and the
 * actual `writeFile` calls. When the Labs flag is on, autoIngest:
 *   1. Runs LLM analyse + generate (tokens spent regardless)
 *   2. Parses the response into FileBlocks
 *   3. Sets `pending` here with the parsed blocks + a deferred
 *      `resolve` callback
 *   4. Awaits the user's decision via a Promise wrapped around
 *      `resolve`
 *
 * The `IngestPreviewDialog` mounted at app-root subscribes to this
 * store and renders the dialog when `pending` is non-null. Clicking
 * Apply / Cancel calls `resolve(true|false)`, which clears the
 * pending state and unblocks autoIngest's await — autoIngest then
 * proceeds with or skips writeFileBlocks.
 *
 * Tokens are spent regardless of the user's choice (the LLM
 * decisions already happened). The win is that NO files land on
 * disk until the user confirms — they can spot a bad split or a
 * duplicate-slug LLM mistake and bail without disk damage.
 */

export interface IngestPreviewBlock {
  /** Wiki-relative path that would be written (e.g.
   *  "wiki/concepts/transformer.md"). */
  path: string
  /** First N chars of the proposed body — full content omitted to
   *  keep the dialog snappy on big runs. The body lives in the
   *  generation string already; only the path matters for the
   *  user's "is this the right slug?" call. */
  contentPreview: string
  /** Length of the full content in chars. */
  contentLength: number
}

export interface IngestPreview {
  /** Display title for the dialog header (e.g. source filename). */
  title: string
  /** What's about to be written. */
  blocks: IngestPreviewBlock[]
  /** Resolves true when the user accepts, false on cancel. */
  resolve: (apply: boolean) => void
}

interface IngestPreviewState {
  pending: IngestPreview | null
  setPending: (preview: IngestPreview | null) => void
}

export const useIngestPreviewStore = create<IngestPreviewState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}))

/**
 * Helper for the autoIngest side. Pushes a preview onto the store
 * and returns a Promise that resolves to the user's choice.
 *
 * If a preview is ALREADY pending (concurrent autoIngest from the
 * ingest queue), the new one waits its turn — autoIngest runs are
 * intentionally serialized by withProjectLock anyway, so this is
 * defense-in-depth.
 */
export function requestIngestPreview(
  preview: Omit<IngestPreview, "resolve">,
): Promise<boolean> {
  return new Promise((resolve) => {
    useIngestPreviewStore.getState().setPending({
      ...preview,
      resolve: (apply) => {
        useIngestPreviewStore.getState().setPending(null)
        resolve(apply)
      },
    })
  })
}
