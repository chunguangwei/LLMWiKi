import { useCallback, useEffect, useRef, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { IconSidebar } from "./icon-sidebar"
import { UpdateBanner } from "./update-banner"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { ResearchPanel } from "./research-panel"
import { ActivityPanel } from "./activity-panel"
import { useResearchStore } from "@/stores/research-store"
import { ErrorBoundary } from "@/components/error-boundary"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { getAppLayoutVisibility } from "./app-layout-visibility"
import { PanelLeftOpen } from "lucide-react"
import { useTranslation } from "react-i18next"

const LEFT_PANEL_COLLAPSED_KEY = "llm-wiki:left-panel-collapsed"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem(LEFT_PANEL_COLLAPSED_KEY) === "true",
  )
  const resizeCleanupRef = useRef<number | null>(null)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: true,
    })
  }, [project])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  // GraphView uses this signal to keep WebGL canvases unmounted during resize.
  const handlePanelLayoutChange = useCallback(() => {
    window.clearTimeout(resizeCleanupRef.current ?? undefined)
    resizeCleanupRef.current = null
    document.body.dataset.panelResizing = "true"
  }, [])
  const handlePanelLayoutChanged = useCallback(() => {
    window.clearTimeout(resizeCleanupRef.current ?? undefined)
    resizeCleanupRef.current = window.setTimeout(() => {
      resizeCleanupRef.current = null
      delete document.body.dataset.panelResizing
    }, 0)
  }, [])

  useEffect(() => () => {
    window.clearTimeout(resizeCleanupRef.current ?? undefined)
    delete document.body.dataset.panelResizing
  }, [])

  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, researchPanelOpen)
  const toggleLeftPanel = () => {
    setLeftCollapsed((value) => {
      const next = !value
      localStorage.setItem(LEFT_PANEL_COLLAPSED_KEY, String(next))
      return next
    })
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <IconSidebar onSwitchProject={onSwitchProject} />
        <ResizablePanelGroup
          id="app-layout-panels"
          direction="horizontal"
          onLayoutChange={handlePanelLayoutChange}
          onLayoutChanged={handlePanelLayoutChanged}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {showLeftPanel && !leftCollapsed && (
            <>
              <ResizablePanel
                id="left-panel"
                defaultSize="20%"
                minSize="15%"
                maxSize="25%"
                className="flex flex-col border-r"
                style={{ overflow: "hidden" }}
              >
                <div className="min-h-0 flex-1 overflow-hidden">
                  <SidebarPanel onCollapse={toggleLeftPanel} />
                </div>
                <ActivityPanel />
              </ResizablePanel>
              <ResizableHandle
                id="left-panel-resize-handle"
                withHandle
                aria-label={t("layout.resizeLeftPanel", "Resize left panel")}
              />
            </>
          )}

          {showLeftPanel && leftCollapsed && (
            <ResizablePanel
              id="collapsed-left-panel"
              defaultSize={36}
              minSize={36}
              maxSize={36}
              disabled
              groupResizeBehavior="preserve-pixel-size"
              className="flex justify-center border-r bg-muted/20 pt-2"
              style={{ overflow: "hidden" }}
            >
              <button
                type="button"
                onClick={toggleLeftPanel}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("layout.showSidebar", "Show sidebar")}
                aria-label={t("layout.showSidebar", "Show sidebar")}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </ResizablePanel>
          )}

          <ResizablePanel
            id="content-panel"
            minSize="40%"
            className="min-w-0"
            style={{ overflow: "hidden" }}
          >
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <ErrorBoundary>
                  <ContentArea />
                </ErrorBoundary>
              </div>
              {!showLeftPanel && <ActivityPanel />}
            </div>
          </ResizablePanel>

          {hasRightPanel && (
            <>
              <ResizableHandle
                id="research-panel-resize-handle"
                withHandle
                aria-label={t("layout.resizeResearchPanel", "Resize research panel")}
              />
              <ResizablePanel
                id="research-panel"
                defaultSize="30%"
                minSize="20%"
                maxSize="35%"
                className="flex flex-col border-l"
                style={{ overflow: "hidden" }}
              >
                <ErrorBoundary>
                  <ResearchPanel />
                </ErrorBoundary>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
