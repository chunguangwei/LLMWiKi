import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { markdownFileSaver, type MarkdownSaveFailure } from "@/lib/markdown-file-saver"

export const MARKDOWN_SAVE_EXIT_EVENT = "llmwiki://save-before-exit"

interface MarkdownSaveExitOptions {
  onFailure: (failures: MarkdownSaveFailure[]) => void | Promise<void>
  flush?: () => Promise<MarkdownSaveFailure[]>
  confirmExit?: () => Promise<void>
  cancelExit?: () => Promise<void>
}

export function createMarkdownSaveExitHandler({
  onFailure,
  flush = () => markdownFileSaver.flushAll(),
  confirmExit = () => invoke("finish_markdown_save_exit"),
  cancelExit = () => invoke("cancel_markdown_save_exit"),
}: MarkdownSaveExitOptions): () => Promise<void> {
  let running = false
  let queued = false

  return async () => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      do {
        queued = false
        try {
          const failures = await flush()
          if (failures.length === 0) {
            await confirmExit()
          } else {
            await cancelExit()
            await onFailure(failures)
          }
        } catch (error) {
          await cancelExit()
          await onFailure([{ path: "", error }])
        }
      } while (queued)
    } finally {
      running = false
    }
  }
}

export function installMarkdownSaveExitHandler(
  onFailure: (failures: MarkdownSaveFailure[]) => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen(MARKDOWN_SAVE_EXIT_EVENT, createMarkdownSaveExitHandler({ onFailure }))
}
