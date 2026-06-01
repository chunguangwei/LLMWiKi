import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"
import type { Theme } from "@/lib/theme"

/**
 * Wire protocol used when `provider === "custom"`. Other providers have a
 * fixed protocol (openai → OpenAI chat; anthropic → Anthropic messages;
 * etc.), so this field is ignored for them. `undefined` defaults to
 * `chat_completions` for backward compatibility with pre-0.3.7 configs.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"
export type AzureModelFamily = "auto" | "gpt5"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize: number // max context window in characters
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
}

export type SearchProvider = "tavily" | "serpapi" | "searxng" | "ollama" | "none"
export type SerpApiEngine =
  | "google"
  | "google_news"
  | "google_scholar"
  | "google_patents"
  | "bing"
  | "duckduckgo"
  | "google_images"
  | "google_videos"
  | "youtube"
  | string
export type SearXngCategory =
  | "general"
  | "news"
  | "science"
  | "it"
  | "images"
  | "videos"
  | "files"
  | "map"
  | "music"
  | "social media"
  | string

export interface SearchProviderOverride {
  apiKey?: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  ollamaUrl?: string
}

export type SearchProviderConfigs = Partial<Record<Exclude<SearchProvider, "none">, SearchProviderOverride>>

interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  ollamaUrl?: string
  providerConfigs?: SearchProviderConfigs
}

interface EmbeddingConfig {
  enabled: boolean
  endpoint: string // e.g. "http://127.0.0.1:1234/v1/embeddings"
  apiKey: string
  model: string // e.g. "text-embedding-qwen3-embedding-0.6b"
  /** Optional Gemini native `output_dimensionality` value. Ignored by OpenAI-compatible endpoints. */
  outputDimensionality?: number
  /**
   * Chunking knobs (Phase 1 RAG). Undefined values fall back to the
   * chunker's built-in defaults in `src/lib/text-chunker.ts`:
   *   targetChars   1000
   *   maxChars      1500
   *   minChars      200
   *   overlapChars  200
   *
   * Users on small-context endpoints (e.g. llama.cpp with n_ctx=512,
   * Ollama `mxbai-embed-large`) should lower `maxChunkChars` to avoid
   * per-request rejections; fetchEmbedding also auto-halves on
   * "too long" server errors as a second line of defence.
   */
  maxChunkChars?: number
  overlapChunkChars?: number
  /**
   * Extra HTTP headers to send with every embedding request, e.g.
   *   { "X-Model-Provider-Id": "siliconflow" }
   * for gateways like mify that route by header. Reserved names
   * (Authorization, Content-Type, Host, Content-Length, x-goog-api-key)
   * are ignored — they're managed by the embedding client itself.
   */
  extraHeaders?: Record<string, string>
}

/**
 * Image-captioning settings (Phase 4 of the multimodal-images plan).
 *
 * Decoupled from `llmConfig` because vision-capable endpoints are
 * usually NOT the same model the user picks for analysis/generation:
 * - the analysis stage often goes to a strong text-only model (Claude
 *   Sonnet, DeepSeek, etc.) that doesn't speak vision at all;
 * - captioning is happy with a small local VL model (Qwen2.5-VL-7B,
 *   LLaVA-1.6) that costs near-zero per call.
 *
 * `enabled` is the master gate. When false the caption pipeline is
 * skipped entirely — `read_file`'s extracted images still appear
 * inline (with empty alt text) and the safety-net `## Embedded
 * Images` section still gets written, but we never touch the LLM.
 *
 * `useMainLlm`: when true (the default for first-time users we
 * onboard), captioning calls go through the same `llmConfig`
 * everything else uses. When false, the dedicated fields below are
 * sent through the same provider machinery — same `streamChat`,
 * same `getProviderConfig`, no duplicate code.
 *
 * `concurrency` bounds parallel caption requests during ingest.
 * 30-image PDFs with sequential captioning at ~10s/image (a Qwen3
 * thinking model on consumer GPU) take 5 minutes. At concurrency=4
 * that drops to ~75s. Going wider than 8 typically just queues
 * behind a single-GPU server's batch slot, so we cap the slider
 * UI at a tasteful max in the settings view.
 */
/**
 * Global outbound HTTP proxy. When `enabled` and `url` is a valid
 * http(s) URL, the Rust setup hook reads this on app launch and
 * sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars before the
 * reqwest client used by tauri-plugin-http is constructed. Changes
 * apply on app restart only.
 */
interface ProxyConfig {
  enabled: boolean
  url: string
  bypassLocal: boolean
}

interface ScheduledImportConfig {
  enabled: boolean
  path: string // 监控目录的相对路径（相对于项目根目录），空字符串表示使用默认的 "raw"
  interval: number // 扫描间隔（分钟）
  lastScan: number | null // 上次扫描时间戳
}

/**
 * Local HTTP API server config. Read by the Rust `api_server` module on
 * every request via `load_app_state` (5s cache). The Rust side is the
 * source of truth at request time; this struct is the persisted form
 * the UI edits.
 *
 *   - `enabled` gates all non-/health endpoints. Default `true` so an
 *     env-token-only setup keeps working after the toggle is added.
 *   - `allowUnauthenticated` lets local agents call the API without a
 *     token. It is explicit and default-off.
 *   - `token` is the bearer secret. Empty + auth required =
 *     every non-/health request returns 401. The env var
 *     `LLM_WIKI_API_TOKEN` overrides this field at the backend.
 */
interface ApiConfig {
  enabled: boolean
  allowUnauthenticated: boolean
  token: string
}

interface SourceWatchConfig {
  enabled: boolean
  autoIngest: boolean
  includeExtensions: string[]
  excludeExtensions: string[]
  excludeDirs: string[]
  excludeGlobs: string[]
  maxFileSizeMb: number
}

interface MultimodalConfig {
  enabled: boolean
  /** Reuse `llmConfig` for caption calls. When true, the fields
   *  below are ignored. */
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  /** Max parallel caption requests during ingest. >=1. */
  concurrency: number
}

/**
 * Output language for LLM-generated content (wiki pages, chat responses, research).
 * "auto" = detect from user input / source document language.
 * Otherwise = force all LLM output to use the specified language.
 */
type OutputLanguage =
  | "auto"
  | "English"
  | "Chinese"
  | "Traditional Chinese"
  | "Japanese"
  | "Korean"
  | "Vietnamese"
  | "French"
  | "German"
  | "Spanish"
  | "Portuguese"
  | "Italian"
  | "Russian"
  | "Arabic"
  | "Persian"
  | "Hindi"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Swedish"
  | "Indonesian"
  | "Thai"
  | "Ukrainian"

/**
 * Per-preset saved fields. Each entry survives turning the preset off
 * and coming back — users don't have to re-enter an API key when they
 * briefly switch to a different provider.
 */
export interface ProviderOverride {
  apiKey?: string
  model?: string
  baseUrl?: string           // customEndpoint for custom presets, ollamaUrl for ollama
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  maxContextSize?: number
  reasoning?: ReasoningConfig
}

export type ProviderConfigs = Record<string, ProviderOverride>

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: string
  /**
   * One-shot scroll target for the markdown preview. When the user
   * clicks an image in search results and chooses "jump to source",
   * we set this to the image URL alongside `selectedFile`. The
   * markdown preview consumes it on its next render — finds the
   * `<img data-mdsrc="..."/>` whose attribute matches and scrolls
   * it into view, then clears this back to null so a stale target
   * doesn't fire on the NEXT page open.
   *
   * Match by raw URL (the literal `src` from the markdown) rather
   * than the resolved `convertFileSrc` URL — same image referenced
   * across two pages with different URL conventions (one absolute,
   * one wiki-relative) still works.
   */
  pendingScrollImageSrc: string | null
  chatExpanded: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "settings"
  llmConfig: LlmConfig
  /** Per-provider-preset stored overrides (API key, model, endpoint, …). */
  providerConfigs: ProviderConfigs
  /** Which preset is currently active. `null` = no LLM configured. */
  activePresetId: string | null
  searchApiConfig: SearchApiConfig
  embeddingConfig: EmbeddingConfig
  multimodalConfig: MultimodalConfig
  outputLanguage: OutputLanguage
  /**
   * Light / dark theme preference. `"system"` follows the OS via the
   * `prefers-color-scheme` media query; `"light"` / `"dark"` are
   * explicit overrides. Applied to `<html>` via the `.dark` class —
   * see `src/lib/theme.ts` for the apply / subscribe seam.
   */
  theme: Theme
  proxyConfig: ProxyConfig
  scheduledImportConfig: ScheduledImportConfig
  sourceWatchConfig: SourceWatchConfig
  apiConfig: ApiConfig
  /**
   * **Labs / experimental** — turn on the 🤖 agent-ingest button on
   * source files. Off by default in v0.4.23 because the pipeline is
   * not yet validated on real long sources; users who opt in are
   * implicitly volunteering for Phase F. See
   * `docs/agent-ingest-design.md` for the architecture.
   *
   * Persisted via `saveExperimentalConfig` (project-store.ts).
   */
  experimentalAgentIngest: boolean
  /**
   * **Labs / experimental** — replace the lint Fix button's hardcoded
   * actions (orphan → append to index.md, broken-link → push to Review,
   * etc.) with an agent-driven mini-loop that decides per-item how to
   * repair the wiki. Off by default; users opting in get smarter fixes
   * but also LLM-cost overhead per click. See
   * `src/lib/agent-lint-fix/` for the implementation.
   *
   * Persisted via `saveExperimentalConfig` (project-store.ts).
   */
  experimentalAiLintFix: boolean
  /**
   * **Labs / experimental** — upgrade chat from a single-turn stream
   * to a tool-calling agent loop. When the LLM decides it needs
   * external information (wiki page lookup, web fetch, local file
   * search), it emits tool_use blocks and the runner drives the loop
   * until the model has enough context to answer. Costs more tokens
   * per turn AND drops the streaming UX in agent mode (the first
   * response arrives as a complete block, not token-by-token). Off
   * by default. See `src/lib/chat-agent/` for the implementation.
   *
   * Persisted via `saveExperimentalChatAgent` (project-store.ts).
   */
  experimentalChatAgent: boolean
  /**
   * **Labs / experimental — REQUIRES `experimentalChatAgent`**.
   *
   * When set, the chat-agent tool catalogue includes write_wiki_page
   * and update_wiki_page in addition to the read-only set. This lets
   * the agent directly write to the wiki on the user's behalf
   * ("create a page about X", "update concepts/foo with this"). The
   * system prompt instructs the agent to use these tools ONLY when
   * the user explicitly asks for a wiki mutation — pure-answer
   * questions still get plain text replies.
   *
   * Deliberately omits delete_wiki_page and link_pages — those are
   * higher-blast-radius and should stay in agent-ingest / agent-lint-fix
   * mode for now. Off by default.
   */
  experimentalChatAgentCanWrite: boolean
  /**
   * **Labs / experimental** — when ON, SaveToWiki SKIPS the wikify LLM
   * rewrite pass and persists the chat content verbatim. Default OFF
   * (wikify runs, stripping chat tone). Useful when you want the
   * agent's exact reply preserved — e.g. for record-keeping, when the
   * reply is already encyclopedic, or when wikify keeps over-editing
   * specific kinds of content (poetry, code-heavy answers, …).
   *
   * Independent of `hasUsableLlm` — the toggle only matters when an
   * LLM IS configured. With no LLM, wikify is skipped regardless.
   *
   * Persisted via `saveExperimentalRawSaveToWiki` (project-store.ts).
   */
  experimentalRawSaveToWiki: boolean
  /**
   * **Labs / experimental** — when ON, every reconcile pass also runs
   * the LLM annotator (`wiki-index-annotate`). For each index.md
   * bullet that lacks a `— description`, the annotator reads the page,
   * batch-calls the LLM with up to ~25 entries per call, and writes
   * back one-line descriptions. Cached by body hash so unchanged
   * pages don't re-spend tokens.
   *
   * Cost: ~one LLM round-trip per ~25 newly-written pages. Skipped
   * entirely when no bullets need annotation (idempotent). Default
   * OFF because it spends tokens.
   *
   * Persisted via `saveExperimentalIndexAnnotations` (project-store.ts).
   */
  experimentalIndexAnnotations: boolean
  dataVersion: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setPendingScrollImageSrc: (src: string | null) => void
  setChatExpanded: (expanded: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
  setProviderConfigs: (configs: ProviderConfigs) => void
  setActivePresetId: (id: string | null) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setEmbeddingConfig: (config: EmbeddingConfig) => void
  setMultimodalConfig: (config: MultimodalConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  setTheme: (theme: Theme) => void
  setProxyConfig: (config: ProxyConfig) => void
  setScheduledImportConfig: (config: ScheduledImportConfig) => void
  setSourceWatchConfig: (config: SourceWatchConfig) => void
  setApiConfig: (config: ApiConfig) => void
  setExperimentalAgentIngest: (enabled: boolean) => void
  setExperimentalAiLintFix: (enabled: boolean) => void
  setExperimentalChatAgent: (enabled: boolean) => void
  setExperimentalChatAgentCanWrite: (enabled: boolean) => void
  setExperimentalRawSaveToWiki: (enabled: boolean) => void
  setExperimentalIndexAnnotations: (enabled: boolean) => void
  bumpDataVersion: () => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  selectedFile: null,
  fileContent: "",
  pendingScrollImageSrc: null,
  chatExpanded: false,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    reasoning: { mode: "auto" },
  },
  providerConfigs: {},
  activePresetId: null,

  dataVersion: 0,

  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setActiveView: (activeView) => set({ activeView }),
  searchApiConfig: {
    provider: "none",
    apiKey: "",
    serpApiEngine: "google",
    searXngUrl: "",
    searXngCategories: ["general"],
    providerConfigs: {},
  },

  embeddingConfig: {
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  },

  multimodalConfig: {
    // Off by default — captioning is a non-trivial token spend
    // (one VLM call per extracted image), and silently turning it
    // on for every user the first time they import a PDF would be
    // a budget surprise. Users who want it flip the toggle in
    // Settings → Image captioning.
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    apiMode: "chat_completions",
    concurrency: 4,
  },

  outputLanguage: "auto",
  theme: "system",

  proxyConfig: {
    enabled: false,
    url: "",
    bypassLocal: true,
  },

  scheduledImportConfig: {
    enabled: false,
    path: "",
    interval: 60,
    lastScan: null,
  },

  sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG,

  // Default `enabled: true` preserves the pre-toggle behavior: anyone
  // who already had `LLM_WIKI_API_TOKEN` set or `apiConfig.token`
  // hand-edited keeps their working API. New users land in
  // "enabled + no token = 401 on every endpoint" — fail-closed by
  // virtue of the token being empty.
  apiConfig: {
    enabled: true,
    allowUnauthenticated: false,
    token: "",
  },

  experimentalAgentIngest: false,
  experimentalAiLintFix: false,
  experimentalChatAgent: false,
  experimentalChatAgentCanWrite: false,
  experimentalRawSaveToWiki: false,
  experimentalIndexAnnotations: false,

  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setProviderConfigs: (providerConfigs) => set({ providerConfigs }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
  setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  setTheme: (theme) => set({ theme }),
  setProxyConfig: (proxyConfig) => set({ proxyConfig }),
  setScheduledImportConfig: (scheduledImportConfig) => set({ scheduledImportConfig }),
  setSourceWatchConfig: (sourceWatchConfig) => set({ sourceWatchConfig }),
  setApiConfig: (apiConfig) => set({ apiConfig }),
  setExperimentalAgentIngest: (experimentalAgentIngest) =>
    set({ experimentalAgentIngest }),
  setExperimentalAiLintFix: (experimentalAiLintFix) =>
    set({ experimentalAiLintFix }),
  setExperimentalChatAgent: (experimentalChatAgent) =>
    set({ experimentalChatAgent }),
  setExperimentalChatAgentCanWrite: (experimentalChatAgentCanWrite) =>
    set({ experimentalChatAgentCanWrite }),
  setExperimentalRawSaveToWiki: (experimentalRawSaveToWiki) =>
    set({ experimentalRawSaveToWiki }),
  setExperimentalIndexAnnotations: (experimentalIndexAnnotations) =>
    set({ experimentalIndexAnnotations }),
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}))

export type { WikiState, LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig, ScheduledImportConfig, SourceWatchConfig, ApiConfig, Theme }
