import { writeFile, readFile, createDirectory, deleteFile, fileExists } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

/**
 * Two state directories per project:
 *
 *   .llm-wiki/        — project-shared metadata (ingest cache, review
 *                       queue, page history). Safe to put on iCloud /
 *                       OneDrive / Dropbox; teammates see the same data.
 *
 *   .llm-wiki-local/  — per-user private state (chat history, draft
 *                       messages). MUST NOT be synced to cloud — each
 *                       teammate keeps their own conversations.
 *
 * One-time migration on first load: if a project still has the old
 * `.llm-wiki/conversations.json` / `.llm-wiki/chats/`, move them into
 * `.llm-wiki-local/` so existing users don't lose their chat history.
 */
const SHARED_DIR = ".llm-wiki"
const LOCAL_DIR = ".llm-wiki-local"

function sharedDir(pp: string) {
  return `${pp}/${SHARED_DIR}`
}
function localDir(pp: string) {
  return `${pp}/${LOCAL_DIR}`
}
function chatsDir(pp: string) {
  return `${localDir(pp)}/chats`
}
function conversationsFile(pp: string) {
  return `${localDir(pp)}/conversations.json`
}
function chatFile(pp: string, convId: string) {
  return `${chatsDir(pp)}/${convId}.json`
}

async function ensureSharedDir(projectPath: string): Promise<void> {
  await createDirectory(sharedDir(projectPath)).catch(() => {})
}

async function ensureLocalDir(projectPath: string): Promise<void> {
  await createDirectory(localDir(projectPath)).catch(() => {})
  await createDirectory(chatsDir(projectPath)).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureSharedDir(pp)
  await writeFile(`${sharedDir(pp)}/review.json`, JSON.stringify(items, null, 2))
}

export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${sharedDir(pp)}/review.json`)
    return JSON.parse(content) as ReviewItem[]
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

/**
 * Delete one conversation's message file. Used by chat-panel when the
 * user removes a conversation from the sidebar. Routes to .llm-wiki-local/
 * so callers don't have to know which directory holds chats.
 */
export async function deleteChatConversation(projectPath: string, convId: string): Promise<void> {
  const pp = normalizePath(projectPath)
  await deleteFile(chatFile(pp, convId)).catch(() => {})
}

export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[]
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureLocalDir(pp)

  await writeFile(conversationsFile(pp), JSON.stringify(conversations, null, 2))

  const byConversation = new Map<string, DisplayMessage[]>()
  for (const msg of messages) {
    const list = byConversation.get(msg.conversationId) ?? []
    list.push(msg)
    byConversation.set(msg.conversationId, list)
  }

  for (const [convId, msgs] of byConversation) {
    // Keep last 100 messages per conversation
    const toSave = msgs.slice(-100)
    await writeFile(chatFile(pp, convId), JSON.stringify(toSave, null, 2))
  }
}

/**
 * Migrate legacy chats from .llm-wiki/ to .llm-wiki-local/.
 * Best-effort: if move fails we leave the legacy copy alone so we can
 * retry on next launch.
 */
async function migrateLegacyChats(pp: string): Promise<void> {
  const legacyConvFile = `${sharedDir(pp)}/conversations.json`
  if (!(await fileExists(legacyConvFile).catch(() => false))) {
    return
  }
  await ensureLocalDir(pp)
  try {
    const convContent = await readFile(legacyConvFile)
    await writeFile(conversationsFile(pp), convContent)
    const conversations = JSON.parse(convContent) as Conversation[]
    for (const conv of conversations) {
      const legacyChat = `${sharedDir(pp)}/chats/${conv.id}.json`
      if (await fileExists(legacyChat).catch(() => false)) {
        try {
          const msgContent = await readFile(legacyChat)
          await writeFile(chatFile(pp, conv.id), msgContent)
          await deleteFile(legacyChat).catch(() => {})
        } catch {
          // skip this one, keep going
        }
      }
    }
    await deleteFile(legacyConvFile).catch(() => {})
    // chats dir cleanup is best-effort; deleteFile on dir may fail and that's fine
  } catch {
    // leave legacy alone, retry next time
  }
}

export async function loadChatHistory(projectPath: string): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  await migrateLegacyChats(pp)

  try {
    const convContent = await readFile(conversationsFile(pp))
    const conversations = JSON.parse(convContent) as Conversation[]

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      try {
        const msgContent = await readFile(chatFile(pp, conv.id))
        const msgs = JSON.parse(msgContent) as DisplayMessage[]
        allMessages.push(...msgs)
      } catch {
        // Conversation file missing, skip
      }
    }

    return { conversations, messages: allMessages }
  } catch {
    // Fall back to very old combined format
    try {
      const content = await readFile(`${sharedDir(pp)}/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        const legacyMessages = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacyMessages[0]?.timestamp ?? Date.now(),
          updatedAt: legacyMessages[legacyMessages.length - 1]?.timestamp ?? Date.now(),
        }
        const migratedMessages = legacyMessages.map((m) => ({
          ...m,
          conversationId: "default",
        }))
        return { conversations: [defaultConv], messages: migratedMessages }
      }

      const data = parsed as PersistedChatData
      return data
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}
