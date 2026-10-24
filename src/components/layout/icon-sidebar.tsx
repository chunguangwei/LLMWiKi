import { useState, useEffect } from "react"
import {
  FileText, FolderOpen, Search, Network, ClipboardCheck, Settings, ArrowLeftRight, ClipboardList, Globe, MessageSquare, Sparkles,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useResearchStore } from "@/stores/research-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { useTranslation } from "react-i18next"
import logoImg from "@/assets/logo.png"
import type { WikiState } from "@/stores/wiki-store"
import {
  isResearchPanelVisible,
  nextResearchPanelNavState,
} from "./research-panel-nav"

type NavView = WikiState["activeView"]

const NAV_ITEMS: { view: NavView; icon: typeof FileText; labelKey: string }[] = [
  { view: "chat", icon: MessageSquare, labelKey: "nav.chat" },
  { view: "wiki", icon: FileText, labelKey: "nav.wiki" },
  { view: "sources", icon: FolderOpen, labelKey: "nav.sources" },
  { view: "search", icon: Search, labelKey: "nav.search" },
  { view: "graph", icon: Network, labelKey: "nav.graph" },
  { view: "lint", icon: ClipboardCheck, labelKey: "nav.lint" },
  { view: "review", icon: ClipboardList, labelKey: "nav.review" },
]

function navigationButtonClass(active: boolean): string {
  return `relative flex h-10 w-10 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
    active
      ? "bg-sidebar-accent text-sidebar-primary ring-1 ring-inset ring-sidebar-primary/15"
      : "text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
  }`
}

interface IconSidebarProps {
  onSwitchProject: () => void
}

export function IconSidebar({ onSwitchProject }: IconSidebarProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const pendingCount = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const researchActiveCount = useResearchStore((s) => s.tasks.filter((t) => t.status !== "done" && t.status !== "error").length)
  const toggleResearchPanel = useResearchStore((s) => s.setPanelOpen)
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))
  const [daemonStatus, setDaemonStatus] = useState<string>("starting")

  useEffect(() => {
    const check = async () => {
      try {
        const { clipServerStatus } = await import("@/commands/fs")
        const status = await clipServerStatus()
        setDaemonStatus(status)
      } catch {
        setDaemonStatus("error")
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [])

  function handleResearchPanelToggle() {
    const next = nextResearchPanelNavState(activeView, researchPanelOpen)
    if (next.activeView !== activeView) setActiveView(next.activeView)
    toggleResearchPanel(next.researchPanelOpen)
  }

  const daemonStatusText = daemonStatus === "running"
    ? "Clip server running"
    : daemonStatus === "starting"
      ? "Clip server starting..."
      : daemonStatus === "port_conflict"
        ? "Port 19827 is occupied. Web Clipper unavailable."
        : "Clip server error. Restarting..."

  return (
    <TooltipProvider delay={300}>
      <nav aria-label="LLM Wiki" className="flex h-full w-12 flex-col items-center border-r border-sidebar-border bg-sidebar py-2 text-sidebar-foreground">
        <div className="mb-2 flex items-center justify-center">
          <img src={logoImg} alt="LLM Wiki" className="h-8 w-8 rounded-[22%]" />
        </div>
        <div className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map(({ view, icon: Icon, labelKey }) => (
            <Tooltip key={view}>
              <TooltipTrigger
                type="button"
                aria-label={t(labelKey)}
                aria-current={activeView === view ? "page" : undefined}
                onClick={() => setActiveView(view)}
                className={navigationButtonClass(activeView === view)}
              >
                <Icon className="h-5 w-5" strokeWidth={1.8} />
                {view === "review" && pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-primary px-1 text-[10px] font-bold text-sidebar-primary-foreground ring-2 ring-sidebar">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">
                {t(labelKey)}
                {view === "review" && pendingCount > 0 && ` (${pendingCount})`}
              </TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={t("research.title")}
              aria-pressed={isResearchPanelVisible(activeView, researchPanelOpen)}
              onClick={handleResearchPanelToggle}
              className={navigationButtonClass(isResearchPanelVisible(activeView, researchPanelOpen))}
            >
              <Globe className="h-5 w-5" strokeWidth={1.8} />
              {researchActiveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-primary px-1 text-[10px] font-bold text-sidebar-primary-foreground ring-2 ring-sidebar">
                  {researchActiveCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">{t("research.title")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={t("nav.skills")}
              aria-current={activeView === "skills" ? "page" : undefined}
              onClick={() => setActiveView("skills")}
              className={navigationButtonClass(activeView === "skills")}
            >
              <Sparkles className="h-5 w-5" strokeWidth={1.8} />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.skills")}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-col items-center gap-1 pb-1">
          <Tooltip>
            <TooltipTrigger aria-label={daemonStatusText} className="flex h-7 w-7 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 rounded-full ${
                  daemonStatus === "running" ? "bg-emerald-500" :
                  daemonStatus === "starting" ? "bg-amber-400 animate-pulse" :
                  daemonStatus === "port_conflict" ? "bg-red-500" :
                  "bg-red-500 animate-pulse"
                }`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">{daemonStatusText}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={t("nav.settings")}
              aria-current={activeView === "settings" ? "page" : undefined}
              onClick={() => setActiveView("settings")}
              className={navigationButtonClass(activeView === "settings")}
            >
              <Settings className="h-5 w-5" strokeWidth={1.8} />
              {updateAvailable && (
                <span
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-sidebar"
                  title={t("nav.updateAvailable")}
                />
              )}
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("nav.settings")}
              {t("nav.settingsShortcut")}
              {updateAvailable ? t("nav.updateAvailableSuffix") : ""}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={t("nav.switchProject")}
              onClick={onSwitchProject}
              className={navigationButtonClass(false)}
            >
              <ArrowLeftRight className="h-5 w-5" strokeWidth={1.8} />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.switchProject")}</TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  )
}
