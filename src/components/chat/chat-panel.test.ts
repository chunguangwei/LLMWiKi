/**
 * Guard test — chat deletion must route through persist.ts's
 * deleteChatConversation, which targets `.llm-wiki-local/chats/`.
 *
 * Locks the v0.6.19 regression: chat-panel used to delete
 * `.llm-wiki/chats/<id>.json` (upstream's legacy shared path), which
 * silently missed the real file; the orphan was then resurrected by
 * loadChatHistory's orphan recovery on the next launch.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/chat/chat-panel.tsx"),
  "utf8",
)
describe("chat conversation deletion path", () => {
  it("chat-panel deletes via deleteChatConversation, never the legacy shared chats path", () => {
    expect(panelSource).toMatch(/deleteChatConversation\(/)
    expect(panelSource).not.toMatch(/\.llm-wiki\/chats/)
  })
})
