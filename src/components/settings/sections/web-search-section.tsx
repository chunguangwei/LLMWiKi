import { useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  useWikiStore,
  type AnyTxtConfig,
  type DeepResearchSource,
  type SearchApiConfig,
  type SearchProvider,
  type SearchProviderOverride,
} from "@/stores/wiki-store"
import { normalizeAnyTxtConfig } from "@/lib/anytxt-search"
import {
  SEARXNG_CATEGORY_OPTIONS,
  SERPAPI_ENGINE_OPTIONS,
  resolveSearchConfig,
  DEFAULT_FIRECRAWL_URL,
  webSearch,
} from "@/lib/web-search"

// `configKind` describes what each provider needs in its expanded
// panel: "key" → an API key input, "url" → an instance URL (SearXNG),
// "none" → nothing (Firecrawl's anonymous Search API). Replaces the old
// boolean `needsApiKey` so the third (key-free) shape has a name.
const SEARCH_PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama",
    hint: "Ollama Web Search API",
    keyPlaceholder: "Enter your Ollama API key (ollama.com)",
    configKind: "key",
  },
  {
    id: "tavily",
    label: "Tavily",
    hint: "General web search for Deep Research",
    keyPlaceholder: "Enter your Tavily API key (tavily.com)",
    configKind: "key",
  },
  {
    id: "serpapi",
    label: "SerpApi",
    hint: "Google, Bing, DuckDuckGo, Scholar, News, Images, Videos, YouTube",
    keyPlaceholder: "Enter your SerpApi API key (serpapi.com)",
    configKind: "key",
  },
  {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch via the SearXNG JSON API",
    urlPlaceholder: "https://search.example.com",
    configKind: "url",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    hint: "Anonymous or authenticated Firecrawl Search API",
    configKind: "none",
  },
  {
    id: "brave",
    label: "Brave Search",
    hint: "Independent index with privacy focus (api.search.brave.com)",
    keyPlaceholder: "Enter your Brave Search API subscription token",
    configKind: "key",
  },
] as const

export function WebSearchSection() {
  const { t } = useTranslation()
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const resolvedConfig = resolveSearchConfig(searchApiConfig)
  // AnyTXT local-search config (ported from upstream). Our fork's
  // `resolveSearchConfig` spreads `...config`, so `resolvedConfig.anyTxt`
  // is the raw (possibly-undefined) stored value; we normalize it here
  // for display the same way the chat-agent normalizes it at call time.
  // AnyTXT is a Windows-only local server (ATGUI.exe); on other
  // platforms users simply leave it unconfigured.
  const anyTxtConfig = normalizeAnyTxtConfig(resolvedConfig.anyTxt)
  const anyTxtFilterDir = resolvedConfig.anyTxt?.filterDir ?? ""
  const showBroadAnyTxtWarning = isBroadAnyTxtFilterDir(anyTxtFilterDir)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)
  // Per-provider "Test search" result. Keyed by provider id; cleared
  // when the provider's config changes (a new key invalidates the old
  // test). `testRunRef` carries a per-provider run counter so a stale
  // in-flight test can't overwrite a newer one's result.
  const [testStatus, setTestStatus] = useState<Record<string, { state: "testing" | "ok" | "warning" | "error"; message: string }>>({})
  const testRunRef = useRef<Record<string, number>>({})

  async function persist(next: SearchApiConfig) {
    const { saveSearchApiConfig } = await import("@/lib/project-store")
    setSearchApiConfig(next)
    await saveSearchApiConfig(next)
  }

  function updateProvider(id: Exclude<SearchProvider, "none">, patch: SearchProviderOverride) {
    setTestStatus((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    const currentConfigs = resolvedConfig.providerConfigs ?? {}
    const merged = { ...(currentConfigs[id] ?? {}), ...patch }
    const nextConfigs = { ...currentConfigs, [id]: merged }
    const next = resolveSearchConfig({
      ...resolvedConfig,
      providerConfigs: nextConfigs,
    })
    persist(next).catch(() => {})
    setSavedId(id)
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  function toggleActive(id: Exclude<SearchProvider, "none">) {
    const nextProvider = resolvedConfig.provider === id ? "none" : id
    persist(resolveSearchConfig({ ...resolvedConfig, provider: nextProvider })).catch(() => {})
  }

  // Patch the AnyTXT config (separate from the provider list above —
  // AnyTXT is a local search source the chat-agent toggles per-turn, not
  // one of the online web providers). We merge onto the normalized
  // config so partial edits keep the other AnyTXT fields intact, then
  // persist; `hasConfiguredAnyTxt` (read in chat-panel) flips the chat
  // AnyTXT toggle's availability once `enabled` + a valid endpoint exist.
  function updateAnyTxt(patch: AnyTxtConfig) {
    const next = resolveSearchConfig({
      ...resolvedConfig,
      anyTxt: {
        ...anyTxtConfig,
        ...patch,
      },
    })
    persist(next).catch(() => {})
    setSavedId("anytxt")
    setTimeout(() => setSavedId((cur) => (cur === "anytxt" ? null : cur)), 1500)
  }

  // Run a live "wikipedia" probe against a provider using its own
  // resolved config (independent of which provider is currently active),
  // so the user can verify a key / instance / Firecrawl reachability
  // before flipping it on. Stale runs are discarded via the run counter.
  async function testProvider(id: Exclude<SearchProvider, "none">) {
    const runId = (testRunRef.current[id] ?? 0) + 1
    testRunRef.current[id] = runId
    const testConfig = resolveSearchConfig({ ...resolvedConfig, provider: id })
    setTestStatus((prev) => ({
      ...prev,
      [id]: { state: "testing", message: t("settings.sections.webSearch.testRunning") },
    }))
    try {
      const results = await webSearch("wikipedia", testConfig, 1)
      if (testRunRef.current[id] !== runId) return
      setTestStatus((prev) => ({
        ...prev,
        [id]: {
          state: results.length > 0 ? "ok" : "warning",
          message: results.length > 0
            ? t("settings.sections.webSearch.testSuccess", { count: results.length })
            : t("settings.sections.webSearch.testNoResults"),
        },
      }))
    } catch (err) {
      if (testRunRef.current[id] !== runId) return
      setTestStatus((prev) => ({
        ...prev,
        [id]: {
          state: "error",
          message: localizeSearchTestError(err, t),
        },
      }))
    }
  }

  function updateDeepResearchSource(deepResearchSource: DeepResearchSource) {
    persist(resolveSearchConfig({ ...resolvedConfig, deepResearchSource })).catch(() => {})
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.webSearch.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.webSearch.description")}
        </p>
      </div>

      {/*
        AnyTXT local file search (ported from upstream). A Windows-only
        local JSON-RPC desktop-search server (ATGUI.exe) the chat-agent
        can query as an extra source. Lives above the online providers
        because it's a fundamentally different kind of source (local
        index vs. web). Configuring + enabling it here is what makes the
        chat AnyTXT pill usable (chat-panel gates on hasConfiguredAnyTxt).
      */}
      <div className="space-y-2 rounded-lg border p-3">
        <div>
          <Label>{t("settings.sections.webSearch.deepResearchSources")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.sections.webSearch.deepResearchSourcesHint")}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["web", t("settings.sections.webSearch.sourceWeb")],
            ["anytxt", t("settings.sections.webSearch.sourceAnyTxt")],
            ["both", t("settings.sections.webSearch.sourceBoth")],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => updateDeepResearchSource(value)}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                (resolvedConfig.deepResearchSource ?? "web") === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-accent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>{t("settings.sections.webSearch.anyTxtTitle")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.sections.webSearch.anyTxtDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedId === "anytxt" && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                {t("settings.sections.webSearch.savedBadge")}
              </span>
            )}
            {anyTxtConfig.enabled && (
              <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("settings.sections.webSearch.activeBadge")}
              </span>
            )}
            <button
              type="button"
              onClick={() => updateAnyTxt({ enabled: !anyTxtConfig.enabled })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                anyTxtConfig.enabled
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
              }`}
              aria-label={anyTxtConfig.enabled ? t("settings.sections.webSearch.deactivate") : t("settings.sections.webSearch.activate")}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 dark:ring-white/20 transition-transform ${
                  anyTxtConfig.enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtEndpoint")}</Label>
            <Input
              value={anyTxtConfig.endpoint}
              onChange={(e) => updateAnyTxt({ endpoint: e.target.value })}
              placeholder="http://127.0.0.1:9920"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtLimit")}</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={anyTxtConfig.limit}
              onChange={(e) => {
                const value = e.target.value.trim()
                updateAnyTxt({ limit: value ? Number(value) : undefined })
              }}
              placeholder="20"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtFilterDir")}</Label>
            <Input
              value={anyTxtFilterDir}
              onChange={(e) => updateAnyTxt({ filterDir: e.target.value })}
              placeholder={t("settings.sections.webSearch.anyTxtFilterDirPlaceholder")}
            />
            {showBroadAnyTxtWarning && (
              <p className="text-xs text-destructive">
                {t("settings.sections.webSearch.anyTxtBroadDirWarning")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtFilterExt")}</Label>
            <Input
              value={anyTxtConfig.filterExt}
              onChange={(e) => updateAnyTxt({ filterExt: e.target.value })}
              placeholder="*"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.webSearch.anyTxtHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.webSearch.webProviders")}</Label>
        {SEARCH_PROVIDERS.map((provider) => {
          const override = resolvedConfig.providerConfigs?.[provider.id]
          const isActive = resolvedConfig.provider === provider.id
          const hasConfig = provider.configKind === "none"
            ? true
            : provider.id === "searxng"
              ? !!override?.searXngUrl
              : !!override?.apiKey
          const isExpanded = !!expanded[provider.id]
          return (
            <div
              key={provider.id}
              className={`rounded-lg border transition-colors ${
                isActive ? "border-primary/60 bg-primary/5" : "border-border"
              }`}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                  title={isExpanded ? t("settings.sections.webSearch.collapse") : t("settings.sections.webSearch.expand")}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.label}</span>
                    {hasConfig && !isActive && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("settings.sections.webSearch.configuredBadge")}
                      </span>
                    )}
                    {isActive && (
                      <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("settings.sections.webSearch.activeBadge")}
                      </span>
                    )}
                    {savedId === provider.id && (
                      <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                        {t("settings.sections.webSearch.savedBadge")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {provider.hint}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => toggleActive(provider.id)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    isActive
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                  }`}
                  aria-label={isActive ? t("settings.sections.webSearch.deactivate") : t("settings.sections.webSearch.activate")}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 dark:ring-white/20 transition-transform ${
                      isActive ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {isExpanded && (
                <div className="space-y-4 border-t bg-background/50 px-4 py-3">
                  {provider.id === "firecrawl" ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{t("settings.apiKey")} ({t("common.optional", "optional")})</Label>
                        <Input
                          type="password"
                          value={override?.apiKey ?? ""}
                          onChange={(e) => updateProvider("firecrawl", { apiKey: e.target.value })}
                          placeholder="fc-..."
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("settings.sections.webSearch.instanceUrl")}</Label>
                        <Input
                          value={override?.baseUrl ?? ""}
                          onChange={(e) => updateProvider("firecrawl", { baseUrl: e.target.value })}
                          placeholder={DEFAULT_FIRECRAWL_URL}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground md:col-span-2">
                        {t("settings.sections.webSearch.firecrawlHint")}
                      </p>
                    </div>
                  ) : provider.configKind === "url" ? (
                    <div className="space-y-2">
                      <Label>{t("settings.sections.webSearch.instanceUrl")}</Label>
                      <Input
                        value={override?.searXngUrl ?? resolvedConfig.searXngUrl ?? ""}
                        onChange={(e) => updateProvider(provider.id, { searXngUrl: e.target.value })}
                        placeholder={provider.urlPlaceholder}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.sections.webSearch.searxngJsonHint")}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>{t("settings.apiKey")}</Label>
                      <Input
                        type="password"
                        value={override?.apiKey ?? ""}
                        onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                        placeholder={provider.keyPlaceholder}
                      />
                      {provider.id === "ollama" && (
                        <p className="text-xs text-muted-foreground">
                          {t("settings.sections.webSearch.ollamaHint")}
                        </p>
                      )}
                    </div>
                  )}

                  {provider.id === "serpapi" && (
                    <SerpApiEnginePicker
                      value={override?.serpApiEngine ?? resolvedConfig.serpApiEngine ?? "google"}
                      onChange={(serpApiEngine) => updateProvider("serpapi", { serpApiEngine })}
                    />
                  )}

                  {provider.id === "searxng" && (
                    <SearXngCategoryPicker
                      value={override?.searXngCategories ?? resolvedConfig.searXngCategories ?? ["general"]}
                      onChange={(searXngCategories) => updateProvider("searxng", { searXngCategories })}
                    />
                  )}

                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => testProvider(provider.id)}
                      disabled={!hasConfig || testStatus[provider.id]?.state === "testing"}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {!hasConfig
                        ? t("settings.sections.webSearch.configureBeforeTesting")
                        : testStatus[provider.id]?.state === "testing"
                        ? t("settings.sections.webSearch.testRunning")
                        : t("settings.sections.webSearch.testProvider")}
                    </button>
                    {testStatus[provider.id] && (
                      <p
                        className={`text-xs ${
                          testStatus[provider.id].state === "ok"
                            ? "text-emerald-600"
                            : testStatus[provider.id].state === "warning"
                              ? "text-amber-600"
                            : testStatus[provider.id].state === "error"
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }`}
                      >
                        {testStatus[provider.id].message}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Map raw webSearch() errors to localized, user-facing guidance for the
// inline Test result. Firecrawl's keyless path has a few distinct
// failure modes (suspicious-IP block, network, invalid JSON) worth
// calling out specifically; everything else falls back to the generic
// "search test failed: <message>" string.
function localizeSearchTestError(err: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/Firecrawl anonymous search is blocked for this IP/i.test(message)) {
    return t("settings.sections.webSearch.firecrawlIpBlocked")
  }
  if (/Network error reaching Firecrawl Search/i.test(message)) {
    return t("settings.sections.webSearch.firecrawlNetworkError")
  }
  if (/Firecrawl search returned an invalid JSON response/i.test(message)) {
    return t("settings.sections.webSearch.firecrawlInvalidJson")
  }
  return t("settings.sections.webSearch.testFailed", { message })
}

// Heuristic (ported from upstream) flagging an AnyTXT search folder that
// is too broad — a whole drive root, home dir, UNC share root, or common
// mount point. A broad scope means Deep Research / the chat-agent could
// surface fragments of unrelated (possibly sensitive) local files, so we
// warn the user. Normalizes backslashes to forward slashes first so the
// Windows path forms (C:\, \\server\share) match the same patterns.
function isBroadAnyTxtFilterDir(value: string): boolean {
  const trimmed = value.trim().replace(/\\/g, "/")
  if (!trimmed) return false
  if (trimmed === "/" || trimmed === "~") return true
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(trimmed)) return true
  if (/^[A-Za-z]:\/?$/.test(trimmed)) return true
  return /^\/(?:Users|home|Volumes|mnt|media)?\/?$/.test(trimmed)
}

function SearXngCategoryPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation()
  const selected = value.length > 0 ? value : ["general"]

  function toggle(category: string) {
    const next = selected.includes(category)
      ? selected.filter((item) => item !== category)
      : [...selected, category]
    onChange(next.length > 0 ? next : ["general"])
  }

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.webSearch.searchCategories")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {SEARXNG_CATEGORY_OPTIONS.map((category) => (
          <button
            key={category.value}
            type="button"
            onClick={() => toggle(category.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              selected.includes(category.value)
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
            title={category.hint}
          >
            {category.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.webSearch.searxngCategoriesHint")}
      </p>
    </div>
  )
}

function SerpApiEnginePicker({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const isCustom = value.length > 0 && !SERPAPI_ENGINE_OPTIONS.some((e) => e.value === value)

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.webSearch.searchEngine")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {SERPAPI_ENGINE_OPTIONS.map((engine) => (
          <button
            key={engine.value}
            type="button"
            onClick={() => onChange(engine.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              value === engine.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
            title={engine.hint}
          >
            {engine.label}
          </button>
        ))}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("settings.sections.webSearch.customSerpApiPlaceholder")}
      />
      {isCustom && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.webSearch.customSerpApiHint")}
        </p>
      )}
    </div>
  )
}
