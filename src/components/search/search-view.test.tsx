// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { searchWiki, type SearchResult } from "@/lib/search"
import { useWikiStore } from "@/stores/wiki-store"
import { SearchView } from "./search-view"

vi.mock("@/lib/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search")
  return { ...actual, searchWiki: vi.fn() }
})

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: (url: string) => url,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mockSearchWiki = vi.mocked(searchWiki)
const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
const projectA = { id: "project-a", name: "Project A", path: "/project-a" }

let container: HTMLDivElement
let root: Root | null

beforeEach(() => {
  mockSearchWiki.mockReset()
  useWikiStore.setState({
    project: projectA,
    activeView: "search",
    previousView: "wiki",
    searchFocusRequest: 0,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  const mountedRoot = root
  root = null
  if (mountedRoot) {
    await act(async () => mountedRoot.unmount())
  }
  container.remove()
  useWikiStore.setState({ project: null })
  vi.restoreAllMocks()
})

async function renderSearchView() {
  await act(async () => root!.render(<SearchView />))
}

function searchInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error("Search input not found")
  return input
}

async function changeQuery(value: string) {
  await act(async () => {
    inputValueSetter.call(searchInput(), value)
    searchInput().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function submitQuery(value: string) {
  await changeQuery(value)
  await act(async () => {
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    )
  })
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeResult(title: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    path: `/project-a/wiki/${title}.md`,
    title,
    snippet: `${title} snippet`,
    titleMatch: true,
    score: 1,
    images: [],
    ...overrides,
  }
}

describe("SearchView", () => {
  it("keeps the newest results when responses resolve out of order", async () => {
    const first = deferred<SearchResult[]>()
    const second = deferred<SearchResult[]>()
    mockSearchWiki
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    await renderSearchView()

    await submitQuery("old query")
    await submitQuery("new query")
    await act(async () => {
      second.resolve([makeResult("newest page")])
      await second.promise
    })
    expect(container.textContent).toContain("newest page")

    await act(async () => {
      first.resolve([makeResult("stale page")])
      await first.promise
    })
    expect(container.textContent).toContain("newest page")
    expect(container.textContent).not.toContain("stale page")
  })

  it("does not let an old finally finish a newer pending search", async () => {
    const first = deferred<SearchResult[]>()
    const second = deferred<SearchResult[]>()
    mockSearchWiki
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    await renderSearchView()

    await submitQuery("old query")
    await submitQuery("new query")
    await act(async () => {
      first.resolve([makeResult("stale page")])
      await first.promise
    })
    expect(container.textContent).toContain("Searching...")
    expect(container.textContent).not.toContain("stale page")

    await act(async () => {
      second.resolve([makeResult("newest page")])
      await second.promise
    })
    expect(container.textContent).toContain("newest page")
    expect(container.textContent).not.toContain("Searching...")
  })

  it("uses the submitted query for images and highlighting, including adjacent matches", async () => {
    mockSearchWiki.mockResolvedValue([
      makeResult("alphaalpha", {
        snippet: "alpha snippet",
        images: [{ url: "media/source/img-1.png", alt: "alpha diagram" }],
      }),
    ])
    await renderSearchView()
    await submitQuery("alpha")

    const highlights = Array.from(container.querySelectorAll("mark")).map((mark) => mark.textContent)
    expect(highlights).toEqual(["alpha", "alpha", "alpha", "alpha"])
    expect(container.querySelector('img[alt="alpha diagram"]')).not.toBeNull()

    await changeQuery("unsubmitted draft")
    expect(searchInput().value).toBe("unsubmitted draft")
    expect(Array.from(container.querySelectorAll("mark")).map((mark) => mark.textContent)).toEqual(
      highlights,
    )
    expect(container.querySelector('img[alt="alpha diagram"]')).not.toBeNull()
    expect(container.textContent).not.toContain("unsubmitted draft")
  })

  it("keeps the submitted query in the empty state while the input changes", async () => {
    mockSearchWiki.mockResolvedValue([])
    await renderSearchView()
    await submitQuery("committed empty query")

    await changeQuery("unsubmitted empty query")
    expect(container.textContent).toContain("No results found")
    expect(container.textContent).toContain('"committed empty query"')
    expect(container.textContent).not.toContain("unsubmitted empty query")
  })

  it("shows an error instead of an empty state and retries the submitted query", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockSearchWiki
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([makeResult("recovered alpha")])
    await renderSearchView()
    await submitQuery("alpha failure")

    expect(container.textContent).toContain("Search failed. Please try again.")
    expect(container.textContent).not.toContain("No results found")

    await changeQuery("unsubmitted retry draft")
    await act(async () => {
      buttonWithText("Retry").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(mockSearchWiki).toHaveBeenNthCalledWith(2, "/project-a", "alpha failure")
    expect(container.textContent).toContain("recovered alpha")
    expect(searchInput().value).toBe("unsubmitted retry draft")
  })

  it("ignores an old project response after the project changes", async () => {
    const pending = deferred<SearchResult[]>()
    mockSearchWiki.mockImplementationOnce(() => pending.promise)
    await renderSearchView()
    await submitQuery("old project query")

    await act(async () => {
      useWikiStore.setState({
        project: { id: "project-b", name: "Project B", path: "/project-b" },
      })
    })
    expect(container.textContent).toContain("Press Enter to search")

    await act(async () => {
      pending.resolve([makeResult("old project page")])
      await pending.promise
    })
    expect(container.textContent).not.toContain("old project page")

    mockSearchWiki.mockResolvedValueOnce([makeResult("new project page")])
    await submitQuery("new project query")
    expect(mockSearchWiki).toHaveBeenLastCalledWith("/project-b", "new project query")
    expect(container.textContent).toContain("new project page")
  })

  it("ignores a rejection after unmount", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pending = deferred<SearchResult[]>()
    mockSearchWiki.mockImplementationOnce(() => pending.promise)
    await renderSearchView()
    await submitQuery("unmounted query")

    const mountedRoot = root!
    root = null
    await act(async () => mountedRoot.unmount())
    await act(async () => {
      pending.reject(new Error("late failure"))
      await pending.promise.catch(() => {})
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
