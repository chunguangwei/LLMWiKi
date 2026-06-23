import { describe, expect, it } from "vitest"
import { useWikiStore } from "./wiki-store"

// Fork note: upstream's version of these tests also asserts on an
// `externalPreview` field (its AnyTXT external-preview feature). Our
// fork never adopted that field, so the assertions here cover only the
// store shape we actually have: selectedFile / fileContent /
// previewContentPath / activeView, plus our previousView bookkeeping.

describe("wiki preview store actions", () => {
  it("opens a path in the wiki preview and clears the content stash", () => {
    useWikiStore.setState({
      activeView: "chat",
      previousView: "wiki",
      selectedFile: null,
      fileContent: "old",
      previewContentPath: "/old.md",
    })

    useWikiStore.getState().openPathInPreview("/project/wiki/page.md")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    // openPathInPreview does NOT carry content — PreviewPanel reads it
    // from disk, so the stash is cleared and old content left untouched.
    expect(state.fileContent).toBe("old")
    expect(state.previewContentPath).toBeNull()
    // Came from chat → remember it so Esc/back can return there.
    expect(state.previousView).toBe("chat")
  })

  it("opens loaded file content in the wiki preview", () => {
    useWikiStore.setState({
      activeView: "search",
      previousView: "wiki",
      selectedFile: null,
      fileContent: "",
      previewContentPath: null,
    })

    useWikiStore.getState().openFileInPreview("/project/wiki/page.md", "# Page")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    expect(state.fileContent).toBe("# Page")
    // previewContentPath marks the stash so PreviewPanel shows the
    // passed-in content verbatim instead of re-reading from disk.
    expect(state.previewContentPath).toBe("/project/wiki/page.md")
    expect(state.previousView).toBe("search")
  })

  it("does not overwrite previousView when already on the wiki view", () => {
    useWikiStore.setState({
      activeView: "wiki",
      previousView: "chat",
      selectedFile: "/a.md",
      previewContentPath: null,
    })

    // Navigating wiki → wiki (e.g. clicking another tree node) must not
    // make previousView point at "wiki" itself — Esc-from-search should
    // still be able to find the real origin.
    useWikiStore.getState().openPathInPreview("/b.md")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/b.md")
    expect(state.previousView).toBe("chat")
  })

  it("setSelectedFile clears the content stash without changing the view", () => {
    useWikiStore.setState({
      activeView: "sources",
      selectedFile: "/old.md",
      previewContentPath: "/old.md",
    })

    useWikiStore.getState().setSelectedFile("/new.md")

    const state = useWikiStore.getState()
    expect(state.selectedFile).toBe("/new.md")
    expect(state.previewContentPath).toBeNull()
    // Plain selection is view-neutral (used e.g. by delete-clears).
    expect(state.activeView).toBe("sources")
  })

  it("remembers the previous view across setActiveView, including chat", () => {
    useWikiStore.setState({ activeView: "chat", previousView: "wiki" })

    useWikiStore.getState().setActiveView("search")
    expect(useWikiStore.getState().previousView).toBe("chat")

    // Re-selecting the same view must NOT record a self-referential
    // previousView (which would trap Esc inside that view).
    useWikiStore.getState().setActiveView("search")
    expect(useWikiStore.getState().previousView).toBe("chat")
  })
})
