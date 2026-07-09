import { writeFile, readFile, createDirectory, deleteFile, fileExists, listDirectory } from "@/commands/fs"
import { normalizeReviewItems, type ReviewItem } from "@/stores/review-store"
import type { LintItem } from "@/stores/lint-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import type { ActivityItem } from "@/stores/activity-store"
import type { ChatAgentMode } from "@/lib/chat-agent-types"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

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
    return normalizeReviewItems(JSON.parse(content) as ReviewItem[])
  } catch {
    return []
  }
}

export async function saveLintItems(projectPath: string, items: LintItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureSharedDir(pp)
  await writeFile(`${sharedDir(pp)}/lint.json`, JSON.stringify(items, null, 2))
}

export async function loadLintItems(projectPath: string): Promise<LintItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${sharedDir(pp)}/lint.json`)
    return JSON.parse(content) as LintItem[]
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

/**
 * Per-project chat-agent search toggles (ported from upstream cea0029's
 * chat-agent routing). These are user preferences, not project data —
 * so like chat history they live under `.llm-wiki-local/` and MUST NOT
 * be synced to cloud (upstream parked them in `.llm-wiki/`, but our fork
 * keeps all per-user chat state local; see the dir comment at the top).
 */
export interface ChatPreferences {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  // v0.5.1: agent routing mode (fast/standard/deep/local_first). Persisted
  // per-device alongside the search toggles so the chosen mode survives
  // project switches and restarts. Stays under `.llm-wiki-local/`.
  agentMode: ChatAgentMode
  // v0.6.0 (upstream): per-project skill selection for the chat agent.
  selectedSkills: string[]
  disabledSkills: string[]
}

function chatPreferencesFile(pp: string) {
  return `${localDir(pp)}/chat-preferences.json`
}

/**
 * Activity items persist to .llm-wiki-local/ — per-user, not shared.
 * The reasoning: an activity log is "what I just did", not project
 * history; teammates don't need to see each other's ingest spinners.
 *
 * Items keep their original status, BUT see hydrateActivityItems below
 * for the "stale running → error" pass that runs at App startup.
 */
function activityFile(pp: string): string {
  return `${localDir(pp)}/activity.json`
}

const MAX_ACTIVITY_PERSIST = 200

export async function saveActivityItems(
  projectPath: string,
  items: ActivityItem[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureLocalDir(pp)
  // Cap the persisted history — activity items can pile up after
  // a long session of ingest runs and there's no value in keeping
  // every single one across reloads.
  const trimmed = items.slice(0, MAX_ACTIVITY_PERSIST)
  await writeFile(activityFile(pp), JSON.stringify(trimmed, null, 2))
}

export async function loadActivityItems(projectPath: string): Promise<ActivityItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(activityFile(pp))
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    // Drop shape-invalid entries quietly — old persisted files might
    // not match the current type after schema changes.
    return parsed.filter(
      (x): x is ActivityItem =>
        x &&
        typeof x === "object" &&
        typeof x.id === "string" &&
        typeof x.title === "string" &&
        typeof x.status === "string" &&
        typeof x.detail === "string" &&
        Array.isArray(x.filesWritten) &&
        typeof x.createdAt === "number",
    )
  } catch {
    return []
  }
}

/**
 * Hydrate-time normalisation: stale `running` entries get flipped to
 * `error` because the actual task process died with the previous
 * webview. Without this the user sees ghost spinners that never finish.
 */
export function hydrateActivityItems(items: ActivityItem[]): ActivityItem[] {
  return items.map((it) =>
    it.status === "running"
      ? {
          ...it,
          status: "error" as const,
          detail:
            it.detail +
            (it.detail.endsWith("\n") ? "" : "\n") +
            "⚠️ Interrupted by app reload — original task did not complete.",
        }
      : it,
  )
}

function stripPersistedMessageImages(msg: DisplayMessage): DisplayMessage {
  if (!msg.images || msg.images.length === 0) return msg
  const { images: _images, ...rest } = msg
  return rest
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
    // Images can be multi-megabyte base64 payloads. Keep them in memory for the
    // current chat turn, but don't persist them into chat JSON where they would
    // quickly bloat auto-save files and project backups.
    list.push(stripPersistedMessageImages(msg))
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

    if (conversations.length > 0 || allMessages.length > 0) {
      return { conversations, messages: allMessages }
    }

    // A previous startup race could overwrite conversations.json with [] while
    // leaving .llm-wiki/chats/<id>.json intact. Rebuild a minimal conversation
    // index from those orphan message files so users do not have to recreate
    // chat sessions manually.
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered
    return { conversations, messages: allMessages }
  } catch {
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered

    // Fall back to old format
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

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      out.push(...flattenFiles(node.children ?? []))
    } else {
      out.push(node)
    }
  }
  return out
}

function conversationFromMessages(id: string, messages: DisplayMessage[]): Conversation | null {
  if (messages.length === 0) return null
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp))
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : Date.now()
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : createdAt
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim())
  return {
    id,
    title: firstUser?.content.slice(0, 50) || "Previous Conversation",
    createdAt,
    updatedAt,
  }
}

async function recoverChatHistoryFromOrphanChatFiles(projectPath: string): Promise<PersistedChatData> {
  try {
    // Fork keeps all per-user chat state under `.llm-wiki-local/chats/`
    // (never cloud-synced), unlike upstream which uses `.llm-wiki/chats`.
    const chatDir = chatsDir(normalizePath(projectPath))
    const files = flattenFiles(await listDirectory(chatDir))
      .filter((node) => node.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
    const conversations: Conversation[] = []
    const allMessages: DisplayMessage[] = []

    for (const file of files) {
      try {
        const raw = await readFile(file.path)
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) continue
        const id = file.name.replace(/\.json$/i, "")
        const messages = (parsed as DisplayMessage[])
          .filter((message) => message && typeof message === "object")
          .map((message) => ({
            ...message,
            conversationId: typeof message.conversationId === "string" && message.conversationId
              ? message.conversationId
              : id,
          }))
        const conversation = conversationFromMessages(id, messages)
        if (!conversation) continue
        conversations.push(conversation)
        allMessages.push(...messages)
      } catch {
        // Ignore one corrupt chat file and continue recovering the others.
      }
    }

    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    return { conversations, messages: allMessages }
  } catch {
    return { conversations: [], messages: [] }
  }
}

/**
 * Persist the chat-agent search toggles. Written into `.llm-wiki-local/`
 * (per-user, never cloud-synced) — see ChatPreferences above.
 */
export async function saveChatPreferences(
  projectPath: string,
  preferences: ChatPreferences,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureLocalDir(pp)
  await writeFile(chatPreferencesFile(pp), JSON.stringify(preferences, null, 2))
}

/**
 * Load the chat-agent search toggles. Missing / malformed file → both
 * toggles default off (matches upstream's defensive `=== true` coercion).
 */
export async function loadChatPreferences(projectPath: string): Promise<ChatPreferences> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(chatPreferencesFile(pp))
    const parsed = JSON.parse(content) as Partial<ChatPreferences>
    return {
      useWebSearch: parsed.useWebSearch === true,
      useAnyTxtSearch: parsed.useAnyTxtSearch === true,
      agentMode: normalizePersistedAgentMode(parsed.agentMode),
      selectedSkills: normalizePersistedSkillList(parsed.selectedSkills),
      disabledSkills: normalizePersistedSkillList(parsed.disabledSkills),
    }
  } catch {
    return {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      selectedSkills: [],
      disabledSkills: [],
    }
  }
}

function normalizePersistedSkillList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

/**
 * Coerce a persisted agent-mode value back into a known `ChatAgentMode`.
 * Anything unrecognised (older preference files written before v0.5.1, or
 * a hand-edited/garbage value) falls back to "standard".
 */
function normalizePersistedAgentMode(value: unknown): ChatAgentMode {
  switch (value) {
    case "fast":
    case "standard":
    case "deep":
    case "local_first":
      return value
    default:
      return "standard"
  }
}
