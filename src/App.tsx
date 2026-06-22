import { useState, useEffect } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { listDirectory, openProject } from "@/commands/fs"
import { getLastProject, getRecentProjects, saveLastProject, loadLlmConfig, loadLanguage, loadSearchApiConfig, loadEmbeddingConfig, loadMultimodalConfig, loadOutputLanguage, loadProviderConfigs, loadActivePresetId, loadProxyConfig, loadScheduledImportConfig, saveScheduledImportConfig, loadSourceWatchConfig, loadApiConfig, loadExperimentalAgentIngest, loadExperimentalAiLintFix, loadExperimentalChatAgent, loadExperimentalChatAgentCanWrite, loadExperimentalRawSaveToWiki, loadExperimentalIndexAnnotations, loadExperimentalIngestPreview, loadTheme } from "@/lib/project-store"
import { applyTheme, subscribeToSystemThemeChanges, type Theme } from "@/lib/theme"
import { loadReviewItems, loadLintItems, loadChatHistory, loadActivityItems, hydrateActivityItems } from "@/lib/persist"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import { IngestPreviewDialog } from "@/components/ingest-preview-dialog"
import type { WikiProject } from "@/types/wiki"
import { APP_REPO, APP_RELEASES_URL } from "@/lib/app-repo"

function App() {
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
  }, [])

  // Theme switching: re-apply whenever the store's theme changes,
  // AND subscribe to OS color-scheme changes so a "system"-mode user
  // sees the app flip live when they toggle their OS theme. The
  // store subscription handles explicit Light/Dark too — same path,
  // same render seam, no fork.
  useEffect(() => {
    applyTheme(useWikiStore.getState().theme)
    const unsubStore = useWikiStore.subscribe((state, prev) => {
      if (state.theme !== prev.theme) applyTheme(state.theme)
    })
    const unsubSystem = subscribeToSystemThemeChanges(() => {
      // Only re-apply when the user is in "system" mode — otherwise
      // their explicit Light/Dark override should win.
      if (useWikiStore.getState().theme === "system") {
        applyTheme("system")
      }
    })
    return () => {
      unsubStore()
      unsubSystem()
    }
  }, [])

  // Cmd+R / Ctrl+R — reload the webview. Tauri's webview does NOT
  // bind this by default (the OS chrome that normally hosts reload
  // doesn't exist in a Tauri window), so users get stuck whenever a
  // markdown link or an external nav takes the webview away from the
  // app shell. We intercept the keystroke at the document level and
  // call window.location.reload(). preventDefault stops any focus-
  // dependent default that the underlying webview might still emit.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (isMeta && (e.key === "r" || e.key === "R")) {
        e.preventDefault()
        // A reload tears down the webview and kills any in-flight task
        // (ingest, lint, query) — those run as frontend JS, not a
        // background process. A long-source ingest can be hundreds of
        // sequential LLM calls; an accidental Cmd/Ctrl+R would wipe it.
        // Guard the keystroke when something is running so the user has
        // to confirm. (Progress is checkpointed, so a confirmed reload
        // is recoverable via the activity panel's Resume — but the
        // confirm stops the *accidental* case, which is the common one.)
        const running = useActivityStore.getState().items.some((i) => i.status === "running")
        if (running && !window.confirm(i18n.t("activity.reloadWhileRunningConfirm"))) {
          return
        }
        window.location.reload()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // Cmd/Ctrl+F — smart find. When a wiki page is open, find-in-page
  // (preview-panel) intercepts the keystroke FIRST in the capture phase
  // and stops propagation, so this bubble-phase handler never runs. When
  // there's no page to search over (graph/lint/sources/review/search
  // views, or the wiki view with nothing selected), find-in-page isn't
  // mounted, so the keystroke bubbles up to here and we jump to the global
  // search instead — the natural "locate a wiki page by name" entry point.
  // `requestSearchFocus()` re-focuses the input even when the search view
  // is already showing (where the input's autoFocus wouldn't re-fire).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (isMeta && (e.key === "f" || e.key === "F") && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        const store = useWikiStore.getState()
        store.setActiveView("search")
        store.requestSearchFocus()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // Dev-only helper for visually testing the update-banner UX.
  // Open dev tools and run:
  //   __llmwiki_testUpdateBanner()
  // to inject a fake "available" result into the update store —
  // banner appears at the top + red dot lights up the gear icon.
  // Run again with arg `false` (or call setDismissed via the store)
  // to clear. Gated on `import.meta.env.DEV` so the helper never
  // ships in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(async () => {
      const storeMod = await import("@/stores/update-store")
      const { useUpdateStore } = storeMod
      // Expose the live store getter on window so you can inspect
      // state from devtools when debugging banner behavior.
      ;(window as unknown as { __llmwiki_updateStore?: typeof useUpdateStore }).__llmwiki_updateStore = useUpdateStore
      ;(window as unknown as { __llmwiki_testUpdateBanner?: (clear?: boolean) => void }).__llmwiki_testUpdateBanner = (clear = false) => {
        if (clear) {
          useUpdateStore.getState().setResult(
            { kind: "up-to-date", local: __APP_VERSION__, remote: __APP_VERSION__ },
            Date.now(),
          )
          useUpdateStore.getState().setDismissed(null)
          console.log("[test] update banner cleared")
          return
        }
        useUpdateStore.getState().setResult(
          {
            kind: "available",
            local: __APP_VERSION__,
            remote: "v999.0.0",
            release: {
              name: "v999.0.0 (test)",
              tag_name: "v999.0.0",
              body:
                "Test release for banner-UX verification.\n\n" +
                "- Bigger red dot on the Settings icon\n" +
                "- Top banner with one-click dismiss\n" +
                "- Once dismissed, won't reappear for this version",
              html_url: APP_RELEASES_URL,
              published_at: new Date().toISOString(),
            },
          },
          Date.now(),
        )
        useUpdateStore.getState().setDismissed(null)
        console.log(
          "[test] update banner injected. Run __llmwiki_testUpdateBanner(true) to clear.",
        )
      }
    })()
  }, [])

  // Background update check — hydrate persisted user preferences, then
  // hit GitHub at most once every UPDATE_CHECK_CACHE_MS. Runs 1.5 s
  // after mount so it doesn't contend with the heaviest startup work
  // (project load, file tree, vector store init) but still surfaces
  // a new release in time for the user to notice it during their
  // first interaction. Silent on failure; the UI in Settings → About
  // lets the user retry manually.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      try {
        const { loadUpdateCheckState, saveUpdateCheckState } = await import(
          "@/lib/project-store"
        )
        const { useUpdateStore } = await import("@/stores/update-store")
        const { checkForUpdates, UPDATE_CHECK_CACHE_MS } = await import(
          "@/lib/update-check"
        )

        const persisted = await loadUpdateCheckState()
        if (persisted) useUpdateStore.getState().hydrate(persisted)

        const state = useUpdateStore.getState()
        if (!state.enabled) {
          console.log("[update-check] skipped: user disabled auto-check in settings")
          return
        }

        const now = Date.now()
        // Cache hit requires BOTH the timestamp AND the in-memory
        // result to be present. `lastCheckedAt` is persisted to
        // disk but `lastResult` deliberately is not — keeping the
        // GitHub payload out of the persisted store keeps disk
        // size + privacy footprint small. The downside: a fresh
        // cold start has `lastResult === null` even when
        // `lastCheckedAt` is recent, in which case we MUST refetch
        // — otherwise we'd skip the check AND have no result to
        // display, leaving the banner permanently stuck off.
        // (This was the user-reported bug: "kind=none, no banner".)
        const fresh =
          state.lastCheckedAt !== null &&
          state.lastResult !== null &&
          now - state.lastCheckedAt < UPDATE_CHECK_CACHE_MS
        if (fresh) {
          const ageMin = Math.round((now - (state.lastCheckedAt ?? 0)) / 60_000)
          console.log(
            `[update-check] skipped: cache hit (last check ${ageMin} min ago, ` +
              `cache window ${UPDATE_CHECK_CACHE_MS / 60_000} min). ` +
              `Last result: kind=${state.lastResult?.kind ?? "none"}`,
          )
          return
        }

        useUpdateStore.getState().setChecking(true)
        console.log(
          `[update-check] fetching GitHub releases (local=${__APP_VERSION__})`,
        )
        const result = await checkForUpdates({
          currentVersion: __APP_VERSION__,
          repo: APP_REPO,
        })
        if (cancelled) return
        useUpdateStore.getState().setResult(result, Date.now())
        if (result.kind === "available") {
          console.log(
            `[update-check] update available: local=${result.local} → remote=${result.remote}`,
          )
        } else if (result.kind === "up-to-date") {
          console.log(
            `[update-check] up to date: local=${result.local}, remote latest=${result.remote}`,
          )
        } else {
          console.log(`[update-check] error: ${result.message}`)
        }
        await saveUpdateCheckState({
          enabled: useUpdateStore.getState().enabled,
          lastCheckedAt: Date.now(),
          dismissedVersion: useUpdateStore.getState().dismissedVersion,
        })
      } catch {
        // Silent — Settings → About lets the user retry manually.
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // Auto-open last project on startup
  useEffect(() => {
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedProviderConfigs = await loadProviderConfigs()
        if (savedProviderConfigs) {
          useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
        }
        const savedActivePreset = await loadActivePresetId()
        if (savedActivePreset) {
          useWikiStore.getState().setActivePresetId(savedActivePreset)
          // Re-resolve the active preset's LlmConfig from (preset defaults
          // + saved overrides). Without this, preset default updates
          // (e.g. a corrected Anthropic model ID shipped in a release)
          // never reach users who are relying on defaults — their stored
          // `llmConfig` snapshot from a previous launch would keep the
          // old value. Overrides still win, so an explicit user choice
          // is preserved.
          const { LLM_PRESETS } = await import("@/components/settings/llm-presets")
          const { resolveConfig } = await import("@/components/settings/preset-resolver")
          const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
          if (preset) {
            const currentFallback = useWikiStore.getState().llmConfig
            const override = (savedProviderConfigs ?? {})[savedActivePreset]
            const resolved = resolveConfig(preset, override, currentFallback)
            useWikiStore.getState().setLlmConfig(resolved)
            const { saveLlmConfig } = await import("@/lib/project-store")
            await saveLlmConfig(resolved)
          }
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        const savedMultimodalConfig = await loadMultimodalConfig()
        if (savedMultimodalConfig) {
          useWikiStore.getState().setMultimodalConfig(savedMultimodalConfig)
        }
        const savedProxy = await loadProxyConfig()
        if (savedProxy) {
          useWikiStore.getState().setProxyConfig(savedProxy)
        }
        // Local HTTP API server config — global (single token + enable
        // flag for the whole install, not per-project). The Rust side
        // reads `apiConfig.{enabled,token}` from `app-state.json`
        // directly; this only hydrates the Zustand store so the
        // Settings UI reflects the persisted values.
        const savedApi = await loadApiConfig()
        if (savedApi) {
          useWikiStore.getState().setApiConfig({
            enabled: typeof savedApi.enabled === "boolean" ? savedApi.enabled : true,
            allowUnauthenticated:
              typeof savedApi.allowUnauthenticated === "boolean"
                ? savedApi.allowUnauthenticated
                : false,
            token: typeof savedApi.token === "string" ? savedApi.token : "",
          })
        }
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        // Theme. "system" by default, persisted as a plain string —
        // apply to <html> right after loading so first paint already
        // reflects the user's choice. Falls back to "system" when the
        // stored value is missing or corrupt (a fresh install or a
        // user who never opened Settings).
        try {
          const savedTheme = (await loadTheme()) as Theme | null
          const theme: Theme = savedTheme === "light" || savedTheme === "dark" || savedTheme === "system"
            ? savedTheme
            : "system"
          useWikiStore.getState().setTheme(theme)
          applyTheme(theme)
        } catch {
          applyTheme("system")
        }
        // Experimental / Labs flags. Default false when missing —
        // a fresh install never auto-enables an experimental
        // feature; users must opt in explicitly.
        try {
          const flag = await loadExperimentalAgentIngest()
          useWikiStore.getState().setExperimentalAgentIngest(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalAiLintFix()
          useWikiStore.getState().setExperimentalAiLintFix(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalChatAgent()
          useWikiStore.getState().setExperimentalChatAgent(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalChatAgentCanWrite()
          useWikiStore.getState().setExperimentalChatAgentCanWrite(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalRawSaveToWiki()
          useWikiStore.getState().setExperimentalRawSaveToWiki(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalIndexAnnotations()
          useWikiStore.getState().setExperimentalIndexAnnotations(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        try {
          const flag = await loadExperimentalIngestPreview()
          useWikiStore.getState().setExperimentalIngestPreview(flag)
        } catch {
          // missing or corrupt → keep default false
        }
        const lastProject = await getLastProject()
        if (lastProject) {
          try {
            const proj = await openProject(lastProject.path)
            await handleProjectOpened(proj)
          } catch {
            // Last project no longer valid
          }
        }
      } catch {
        // ignore init errors
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  async function handleProjectOpened(proj: WikiProject) {
    // Flush the OUTGOING project's review/lint/chat state to disk and suspend
    // auto-save before reset empties the stores — otherwise the debounced
    // writers would persist empty arrays back over the old project's pending
    // review / deep-research items.
    const { runWithSuspendedAutoSave } = await import("@/lib/auto-save")
    await runWithSuspendedAutoSave(async () => {
      // Clear all per-project state BEFORE loading new project data
      // to prevent cross-project contamination. MUST be awaited so the
      // ingest queue / graph cache are actually cleared before the new
      // project's state is populated.
      const { resetProjectState } = await import("@/lib/reset-project-state")
      await resetProjectState()

      setProject(proj)
      const projectOutputLang = await loadOutputLanguage(proj.id)
      useWikiStore.getState().setOutputLanguage(projectOutputLang ?? "auto")
      setSelectedFile(null)
      setActiveView("wiki")
      // Bump data version so any cached graphs/views invalidate
      useWikiStore.getState().bumpDataVersion()
      await saveLastProject(proj)

      // Restore ingest queue (resume interrupted tasks). Keyed by the
      // project's stable UUID so the queue still finds the right project
      // even if the filesystem path changed since the task was enqueued.
      // Await this before starting file sync: watcher events for raw/sources
      // may enqueue ingest tasks and require an active project queue.
      try {
        const { restoreQueue } = await import("@/lib/ingest-queue")
        await restoreQueue(proj.id, proj.path)
      } catch (err) {
        console.error("Failed to restore ingest queue:", err)
      }
      // Same handshake for the dedup-merge queue.
      import("@/lib/dedup-queue").then(({ restoreQueue }) => {
        restoreQueue(proj.id, proj.path).catch((err) =>
          console.error("Failed to restore dedup queue:", err)
        )
      })
      // Load per-project scheduled import config
      try {
        const savedScheduledImport = await loadScheduledImportConfig(proj.path)
        if (savedScheduledImport) {
          // Migrate relative path to absolute (backward compatibility)
          let path = savedScheduledImport.path
          if (path && !path.startsWith("/") && !path.match(/^[a-zA-Z]:[/\\]/)) {
            path = `${proj.path}/${path}`
          }
          useWikiStore.getState().setScheduledImportConfig({
            ...savedScheduledImport,
            path,
          })
        } else {
          // Reset to default for new projects
          useWikiStore.getState().setScheduledImportConfig({
            enabled: false,
            path: `${proj.path}/raw/sources`,
            interval: 60,
            lastScan: null,
          })
        }
      } catch {
        // ignore
      }
      // Start scheduled import if enabled
      const scheduledImportConfig = useWikiStore.getState().scheduledImportConfig
      if (scheduledImportConfig.enabled && scheduledImportConfig.path && scheduledImportConfig.interval > 0) {
        import("@/lib/scheduled-import").then(({ startScheduledImport }) => {
          startScheduledImport(proj, scheduledImportConfig)
        }).catch((err) =>
          console.error("Failed to start scheduled import:", err)
        )
      }

      // Start project source watch if enabled
      import("@/lib/project-file-sync").then(async ({ startProjectFileSync, stopProjectFileSync }) => {
        const config = await loadSourceWatchConfig(proj.id)
        useWikiStore.getState().setSourceWatchConfig(config)
        if (config.enabled) {
          startProjectFileSync(proj, config).catch((err) =>
            console.error("Failed to start project file sync:", err)
          )
        } else {
          stopProjectFileSync().catch(() => {})
        }
      }).catch((err) => console.error("Failed to configure project file sync:", err))
      // Notify local clip server of the current project + all recent projects
      fetch("http://127.0.0.1:19827/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: proj.path }),
      }).catch(() => {})

      // Send all recent projects to clip server for extension project picker
      getRecentProjects().then((recents) => {
        const projects = recents.map((p) => ({ name: p.name, path: p.path }))
        fetch("http://127.0.0.1:19827/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projects }),
        }).catch(() => {})
      }).catch(() => {})
      try {
        const tree = await listDirectory(proj.path)
        setFileTree(tree)
      } catch (err) {
        console.error("Failed to load file tree:", err)
      }
      // Load persisted review items
      try {
        const savedReview = await loadReviewItems(proj.path)
        if (savedReview.length > 0) {
          useReviewStore.getState().setItems(savedReview)
        }
      } catch {
        // ignore, start fresh
      }
      // Load persisted lint items
      useLintStore.getState().setItems([])
      try {
        const savedLint = await loadLintItems(proj.path)
        useLintStore.getState().setItems(savedLint)
      } catch {
        useLintStore.getState().setItems([])
      }
      // Load persisted chat history
      try {
        const savedChat = await loadChatHistory(proj.path)
        if (savedChat.conversations.length > 0) {
          useChatStore.getState().setConversations(savedChat.conversations)
          useChatStore.getState().setMessages(savedChat.messages)
          // Set most recent conversation as active
          const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
          if (sorted[0]) {
            useChatStore.getState().setActiveConversation(sorted[0].id)
          }
        }
      } catch {
        // ignore, start fresh
      }
      // Load persisted activity items + flip any stale "running" status
      // to error (the previous webview died with those tasks still
      // in-flight, so the user shouldn't see a ghost spinner).
      try {
        const savedActivity = await loadActivityItems(proj.path)
        const hydrated = hydrateActivityItems(savedActivity)
        useActivityStore.getState().setItems(hydrated)
      } catch {
        // ignore, start fresh
      }
      // The new project's persisted state is fully loaded. runWithSuspendedAutoSave
      // re-arms auto-save in its finally once this callback returns, so further
      // edits persist to THIS project.
    }, () => {
      // If project loading fails after resetProjectState() and before persisted
      // review/lint/chat/activity state has been restored, do not leave auto-save
      // armed against a half-loaded project with empty stores. Clearing the
      // active project here (before resume) means a post-failure store change
      // can't write empty data over the half-opened project's files.
      setProject(null)
      setFileTree([])
      setSelectedFile(null)
    })
  }

  async function handleSelectRecent(proj: WikiProject) {
    try {
      const validated = await openProject(proj.path)
      await handleProjectOpened(validated)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleOpenProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Wiki Project",
    })
    if (!selected) return
    try {
      const proj = await openProject(selected)
      await handleProjectOpened(proj)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleSwitchProject() {
    // Stop scheduled import before switching projects
    import("@/lib/scheduled-import").then(({ stopScheduledImport }) => {
      stopScheduledImport()
    }).catch(() => {})

    // Save current project's scheduled import config before clearing
    const currentProject = useWikiStore.getState().project
    if (currentProject) {
      const currentConfig = useWikiStore.getState().scheduledImportConfig
      saveScheduledImportConfig(currentProject.path, currentConfig).catch(() => {})
    }

    // Flush outgoing project's review/lint/chat to disk and suspend auto-save
    // before reset empties the stores. resumeAutoSave() runs when the next
    // project opens via handleProjectOpened.
    const { flushAndSuspendAutoSave } = await import("@/lib/auto-save")
    await flushAndSuspendAutoSave()

    // Clear all per-project state BEFORE flipping back to the welcome screen
    // so old data cannot leak in via any async render pass.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectOpened}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectOpened}
      />
      <IngestPreviewDialog />
    </>
  )
}

export default App
