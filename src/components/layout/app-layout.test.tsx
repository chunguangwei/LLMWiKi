// @vitest-environment jsdom

import { act, type PropsWithChildren } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppLayout } from "./app-layout"

const mocks = vi.hoisted(() => ({
  activityIdle: false,
  refreshProjectFileTree: vi.fn(),
  researchState: { panelOpen: false },
  wikiState: {
    activeView: "wiki",
    project: null as { id: string; path: string } | null,
  },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: typeof mocks.wikiState) => unknown) =>
    selector(mocks.wikiState),
}))

vi.mock("@/stores/research-store", () => ({
  useResearchStore: (selector: (state: typeof mocks.researchState) => unknown) =>
    selector(mocks.researchState),
}))

vi.mock("@/lib/project-file-tree-refresh", () => ({
  refreshProjectFileTree: mocks.refreshProjectFileTree,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}))

vi.mock("./icon-sidebar", () => ({
  IconSidebar: ({ onSwitchProject }: { onSwitchProject: () => void }) => (
    <button id="icon-sidebar" onClick={onSwitchProject} />
  ),
}))

vi.mock("./update-banner", () => ({
  UpdateBanner: () => <div id="update-banner" />,
}))

vi.mock("./sidebar-panel", () => ({
  SidebarPanel: ({ onCollapse }: { onCollapse: () => void }) => (
    <div id="sidebar-panel">
      <button type="button" aria-label="Hide sidebar" onClick={onCollapse} />
    </div>
  ),
}))

vi.mock("./content-area", () => ({
  ContentArea: () => <div id="content-area" />,
}))

vi.mock("./research-panel", () => ({
  ResearchPanel: () => <div id="research-content" />,
}))

vi.mock("./activity-panel", () => ({
  ActivityPanel: () =>
    mocks.activityIdle ? null : <div id="activity-panel" />,
}))

vi.mock("@/components/error-boundary", () => ({
  ErrorBoundary: ({ children }: PropsWithChildren) => (
    <div id="error-boundary">{children}</div>
  ),
}))

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  private elements = new Set<Element>()

  constructor(private callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.elements.add(target)
  }

  unobserve(target: Element) {
    this.elements.delete(target)
  }

  disconnect() {
    this.elements.clear()
  }

  trigger(target: Element) {
    if (!this.elements.has(target)) return
    this.callback(
      [{ target, borderBoxSize: [{ inlineSize: 1000, blockSize: 800 }] } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

const globalActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
globalActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const storedValues = new Map<string, string>()
const localStorageMock: Storage = {
  get length() {
    return storedValues.size
  },
  clear() {
    storedValues.clear()
  },
  getItem(key) {
    return storedValues.get(key) ?? null
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null
  },
  removeItem(key) {
    storedValues.delete(key)
  },
  setItem(key, value) {
    storedValues.set(key, String(value))
  },
}

describe("AppLayout", () => {
  let container: HTMLDivElement
  let root: Root

  async function renderLayout(onSwitchProject = vi.fn()) {
    await act(async () => {
      root.render(<AppLayout onSwitchProject={onSwitchProject} />)
    })
    return onSwitchProject
  }

  async function measurePanels() {
    const group = container.querySelector("#app-layout-panels")
    expect(group).not.toBeNull()
    await act(async () => {
      for (const observer of TestResizeObserver.instances) {
        observer.trigger(group as Element)
      }
    })
  }

  beforeEach(() => {
    mocks.activityIdle = false
    mocks.wikiState.activeView = "wiki"
    mocks.wikiState.project = null
    mocks.researchState.panelOpen = false
    mocks.refreshProjectFileTree.mockReset()
    mocks.refreshProjectFileTree.mockResolvedValue(undefined)
    TestResizeObserver.instances = []
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    vi.stubGlobal("localStorage", localStorageMock)
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      const widths: Record<string, number> = {
        "left-panel": 200,
        "left-panel-resize-handle": 6,
        "content-panel": 500,
        "research-panel-resize-handle": 6,
        "research-panel": 300,
        "collapsed-left-panel": 36,
      }
      return widths[this.id] ?? 0
    })
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      const offsets: Record<string, number> = {
        "left-panel": 0,
        "left-panel-resize-handle": 200,
        "content-panel": 200,
        "research-panel-resize-handle": 700,
        "research-panel": 700,
        "collapsed-left-panel": 0,
      }
      return offsets[this.id] ?? 0
    })
    localStorage.clear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("uses constrained accessible panels and preserves workspace chrome", async () => {
    mocks.wikiState.project = { id: "project-1", path: "/project" }
    mocks.researchState.panelOpen = true
    const onSwitchProject = await renderLayout()
    await measurePanels()

    expect(container.querySelector("#update-banner")).not.toBeNull()
    expect(container.querySelectorAll("#left-panel, #content-panel, #research-panel")).toHaveLength(3)
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(2)
    expect(container.querySelectorAll("#error-boundary")).toHaveLength(2)
    expect(container.querySelector<HTMLElement>("#left-panel")?.style.flexGrow).toBe("20")
    expect(container.querySelector<HTMLElement>("#content-panel")?.style.flexGrow).toBe("50")
    expect(container.querySelector<HTMLElement>("#research-panel")?.style.flexGrow).toBe("30")

    const leftHandle = container.querySelector("#left-panel-resize-handle") as HTMLElement
    expect(leftHandle.getAttribute("role")).toBe("separator")
    expect(leftHandle.getAttribute("aria-label")).toBe("Resize left panel")
    expect(leftHandle.getAttribute("aria-controls")).toBe("left-panel")
    expect(leftHandle.getAttribute("aria-orientation")).toBe("vertical")
    expect(leftHandle.getAttribute("aria-valuemin")).toBe("15")
    expect(leftHandle.getAttribute("aria-valuemax")).toBe("25")
    expect(leftHandle.getAttribute("aria-valuenow")).toBe("20")
    expect(leftHandle.tabIndex).toBe(0)

    const researchHandle = container.querySelector("#research-panel-resize-handle") as HTMLElement
    expect(researchHandle.getAttribute("aria-label")).toBe("Resize research panel")
    expect(researchHandle.getAttribute("aria-controls")).toBe("content-panel")
    expect(researchHandle.tabIndex).toBe(0)

    vi.useFakeTimers()
    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      leftHandle.dispatchEvent(arrowRight)
    })
    expect(arrowRight.defaultPrevented).toBe(true)
    expect(leftHandle.getAttribute("aria-valuenow")).toBe("25")
    expect(document.body.dataset.panelResizing).toBe("true")
    await act(async () => {
      vi.runAllTimers()
    })
    expect(document.body.dataset.panelResizing).toBeUndefined()
    vi.useRealTimers()

    await act(async () => {
      leftHandle.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(leftHandle.getAttribute("aria-valuenow")).toBe("15")

    const activity = container.querySelector("#activity-panel") as HTMLElement
    expect(container.querySelectorAll("#activity-panel")).toHaveLength(1)
    expect(container.querySelector("#left-panel")?.contains(activity)).toBe(true)
    expect(container.querySelector("#content-panel")?.contains(activity)).toBe(false)

    const iconSidebar = container.querySelector("#icon-sidebar") as HTMLButtonElement
    await act(async () => {
      iconSidebar.click()
    })
    expect(onSwitchProject).toHaveBeenCalledOnce()
    expect(mocks.refreshProjectFileTree).toHaveBeenCalledWith("/project", {
      projectId: "project-1",
      clearDisplayTreeFirst: true,
    })
  })

  it("renders standalone activity below ContentArea without project side panels", async () => {
    mocks.wikiState.activeView = "chat"
    mocks.researchState.panelOpen = true
    await renderLayout()

    expect(container.querySelector("#left-panel")).toBeNull()
    expect(container.querySelector("#research-panel")).toBeNull()
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0)
    expect(container.querySelectorAll("#error-boundary")).toHaveLength(1)

    const contentArea = container.querySelector("#content-area") as HTMLElement
    const activity = container.querySelector("#activity-panel") as HTMLElement
    expect(container.querySelectorAll("#activity-panel")).toHaveLength(1)
    expect(container.querySelector("#content-panel")?.contains(activity)).toBe(true)
    expect(activity.previousElementSibling?.contains(contentArea)).toBe(true)
  })

  it("keeps the standalone activity slot empty when ActivityPanel is idle", async () => {
    mocks.wikiState.activeView = "settings"
    mocks.activityIdle = true
    await renderLayout()

    expect(container.querySelector("#content-area")).not.toBeNull()
    expect(container.querySelector("#activity-panel")).toBeNull()
  })

  it("preserves left-panel collapse state without adding an activity copy", async () => {
    localStorage.setItem("llm-wiki:left-panel-collapsed", "true")
    await renderLayout()

    expect(container.querySelector("#collapsed-left-panel")).not.toBeNull()
    expect(container.querySelector("#left-panel")).toBeNull()
    expect(container.querySelector("#activity-panel")).toBeNull()
    expect(container.querySelector("#left-panel-resize-handle")).toBeNull()

    const showButton = container.querySelector('[aria-label="Show sidebar"]') as HTMLButtonElement
    await act(async () => {
      showButton.click()
    })
    expect(localStorage.getItem("llm-wiki:left-panel-collapsed")).toBe("false")
    expect(container.querySelector("#collapsed-left-panel")).toBeNull()
    expect(container.querySelector("#left-panel")).not.toBeNull()
    expect(container.querySelectorAll("#activity-panel")).toHaveLength(1)

    const hideButton = container.querySelector('[aria-label="Hide sidebar"]') as HTMLButtonElement
    await act(async () => {
      hideButton.click()
    })
    expect(localStorage.getItem("llm-wiki:left-panel-collapsed")).toBe("true")
    expect(container.querySelector("#collapsed-left-panel")).not.toBeNull()
    expect(container.querySelector("#activity-panel")).toBeNull()
  })
})
