/**
 * Shared "Save Q&A to Wiki" content/title derivation.
 *
 * Both the chat message "Save to Wiki" button and the review-view `save:`
 * action persist an assistant turn as a wiki query page. They must produce the
 * SAME title from the SAME raw content, so this logic lives in one module:
 *   - cleanAssistantContentForWikiSave: strips the bits the user never sees
 *     (hidden save-worthy / sources HTML comments, <think>/<thinking> blocks)
 *     so they don't bleed into the saved page or its derived title.
 *   - titleFromCleanAssistantContent: takes the first VISIBLE line (after the
 *     strip) as the title — earlier code took content.split("\n")[0], which
 *     could be a hidden comment / blank line and produced a misleading title.
 */
export function cleanAssistantContentForWikiSave(content: string): string {
  return content
    .replace(/<!--\s*(?:save-worthy|sources):[^\n]*?-->/g, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
    .replace(/^\s+/, "")
    .trimEnd()
}

export function titleFromCleanAssistantContent(clean: string): string {
  const firstVisibleLine = clean
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0)
  return firstVisibleLine?.slice(0, 60) || "Saved Query"
}
