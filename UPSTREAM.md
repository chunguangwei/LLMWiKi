# Upstream & Fork

本项目（LLMWiKi）是 [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) 的 fork，实现了 Andrej Karpathy 的「持久化 wiki」模式（[原始 gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)）。

| 项 | 值 |
|---|---|
| Upstream | `nashsu/llm_wiki` `main` 分支（remote `upstream`）|
| 我们的仓库 | `chunguangwei/LLMWiKi`（remote `origin`，Public，自动更新源）|
| Fork 时间 | 2026-05-18（shallow clone；2026-05-20 已 `--unshallow` 补全历史）|
| 最近一次 sync | 2026-07-27（Round 8，上游 v0.6.5 → v0.6.6，`git merge upstream/main`，冲突处优先采用上游、丢弃我方冲突实现，独立不冲突 fork 功能保留）|
| License | **GPL v3** — 我们的分发版本同样保持 GPL v3 |
| Upstream 版本号 | `0.6.6`（Round 8 追平：博查网页搜索 Provider / Ingest 截断定向恢复 / PDF 跨平台预览 / Windows 路径与 Clip Server 稳定性）|
| **本 fork 版本** | `0.6.12`（Round 8 上游同步 v0.6.5→v0.6.6）|

> **Round 3 同步原则（2026-06-23）**：用户指示「冲突处优先采用上游、丢弃我方实现」；独立不冲突的 fork 功能保留。**唯一排除** `d969cd4`（schema 路由，触碰核心 34 类 split/schema 红线）。**需一次测试发版验证**：MCP 资源打包、托盘/开机自启运行时、新的中央预览布局。

> **Round 4 同步（2026-06-29，v0.5.1 → v0.5.3）**：移植 24 个上游提交。
> - **核心**：schema 感知分析（`f714076`+`6085149`）——把项目 schema 注入 stage-1 分析与长文分块分析，让内容能被推荐/路由到正确的 34 类页面类型（手工并入 forked `buildAnalysisPrompt`/`buildChunkAnalysisSystemPrompt`，附 3 个新测试）。
> - **功能**：Brave 搜索 provider（`f6a9413`/`87310cc`/`4756bfe`，hand-merge 因上游仍带我们已移除的 anytxt/deepResearch）；摄取队列 暂停/恢复 + 防启动自动恢复（`c3f66b9`/`2a3747f`/`0e97e22`，`ingest-queue.ts` wholesale + `activity-panel` hand-merge）；Review API（PATCH/批量 resolve）+ 刷新按钮 + 内容稳定 review id（`68800ee`/`d691e41`/`dbf0e72`/`23f21f4`，`api_server.rs`/`review-store.ts` wholesale）；frontmatter 原文 markdown 编辑（`0251863`，保留我方类型选择器+RefreshControls）；CORS 加固（`9a17552`，新增 `cors.rs`）。
> - **稳定性**：取消后停止写入（`006327d`）、PDF 整页扫描图跳过（`00d670b`）、dotfolders 可见（`a126829`/`c70da6a`，但**摄取**仍走 fork 的 `copy_directory` 故仍跳过 dotfiles——保守、与上游 ingest 行为有别）、preset 关闭时清空 llmConfig（`4371975`/`61ece9e`）、自然排序、Firecrawl 对象响应、关系图悬停对比 pill（`e14bbcb`，适配我方 `useIsDarkTheme`）。
> - **范围回退**：上游 wholesale 把 v0.5.3 的 **本地 CLI 隔离特性**（`localCliIsolation`/`codexCliTimeoutMinutes` + `claude_cli_spawn` 新签名）一并带入，但该特性不在本次请求范围、且会破坏未同步的 `claude-cli-transport.ts` 调用契约——故将 `claude_cli.rs`/`preset-resolver.ts`/`llm-provider-section.tsx` 回退到 HEAD，仅重新应用 `4371975`+`61ece9e`（与隔离无关）。连带丢弃纠缠其中的 `8e3d465`（其 MCP 隔离配置 bug 在我方旧版不存在）。
> - **验证**：typecheck ✅ / test:mocks 2126 ✅ / i18n parity ✅ / cargo check ✅ / cargo test --lib 159 ✅。

> **Round 5 同步（2026-06-30，v0.5.3 → v0.6.0）**：`git merge upstream/main`（HEAD `6a5fad0`）。上游本轮对多个核心模块做了**整体重写**（store 层、ingest 管线、theme、lint），按用户既定原则「冲突处优先采用上游、丢弃我方实现」处理，独立不冲突的 fork 功能保留/重新移植。
> - **整体采用上游（wholesale）**：`stores/wiki-store.ts`、`lib/project-store.ts`、`lib/ingest.ts`、`lib/lint.ts`、`lib/theme.ts`、`components/layout/activity-panel.tsx`、`components/chat/chat-panel.tsx`、`llm-providers.ts` 等冲突文件全部采用上游版本。上游新增 **per-project skills 选择**（`ChatPreferences.selectedSkills`/`disabledSkills`）、`activeView` 增加 `"skills"`、lint 链接修复建议、Firecrawl provider。
> - **重新移植的独立 fork 功能**：搜索聚焦导航（`previousView`/`searchFocusRequest`/`requestSearchFocus`）——上游从未触碰、属独立 UX，已重新并入采用上游后的 `wiki-store.ts`（`openPathInPreview`/`openFileInPreview`/`setActiveView` 用 `set((state)=>…)` 追踪 previousView）。
> - **丢弃的 fork 功能（其后端被上游重写导致悬空，按原则丢弃）**：
>   - **Labs 实验特性**（agentIngest / aiLintFix / rawSaveToWiki / indexAnnotations / ingestPreview）——依赖被上游重写的 ingest 管线；删除 `settings/sections/labs-section.tsx`、`components/ingest-preview-dialog.tsx`、`stores/ingest-preview-store.ts`、`lib/raw-from-chat.ts`（`writeBinaryFile` 已从上游 `fs.ts` 移除），并移除 `settings-view.tsx` 的 `labs` 分类与 `App.tsx` 的实验旗标加载块。
>   - **fork lint 增强**（broken-link 去重合并 `affectedPages`、`sources/` 路径排除的 `LintConfig`、`frontmatter-type` 规则、overview 结构页跳过 orphan）——上游 `lint.ts` 重写后丢弃，连带把 `test-helpers/scenarios/lint-scenarios.ts` 回退到上游版本以匹配。
>   - **fork 专属测试**（`ingest-selfheal.test.ts` / `theme.test.ts`（旧 `resolveTheme`/`subscribeToSystemThemeChanges`）/ `activity-panel.format.test.ts`（`formatEta`）/ `raw-from-chat.test.ts`）——测试对象已随上游重写移除，删除。
> - **合并副产物修复**：`graph-view.tsx` 布局辅助函数重复定义（保留 3 参 `graphDataKey`）、`App.tsx` 重复 `applyDocumentZoom`、`settings-view.tsx` 重复 `newMineruConfig`、`settings-types.ts` 重复 `autostart`/`closeBehavior`、`persist.integration.test.ts` 交错重复测试块（统一到 fork 的 `.llm-wiki-local/` 路径 + 上游 skills 字段）、`knowledge-tree.tsx` 未用变量、`file-preview.tsx` 失效的 `"office"` FileCategory、`Cargo.toml` 残留 `<<<<<<< HEAD` 标记、`lib.rs` `start_clip_server(app)` 新签名、`fs.rs` 重复测试函数（采用上游更全面版本）。
> - **保留的惰性 fork 库代码**：`lib/agent-ingest/`、`lib/agent-lint-fix/` 编译通过但已无调用方（Labs UI 已删），暂作 dead code 保留，未扩大删除范围。
> - **验证**：typecheck ✅ 0 错误 / test:mocks 2232 ✅（157 文件）/ i18n parity ✅（1026 ↔ 1026 全键对齐）/ cargo check ✅ / cargo test 327 ✅。版本号 `0.6.1` > 上游 `0.6.0`，自动更新降级判定保持有效。
>
> **Round 6 同步（2026-07-14，v0.6.0 → v0.6.3）**：`git merge upstream/main`（HEAD `9b71ade`）。上游本轮 19 个提交，聚焦 agent 检索增强、页内编辑、文件历史与 ingest 修复。
> - **整体采用上游**：新增 `file_history` 模块（`list_file_history`/`restore_file_history`）、`apply_text_selection_edit`/`create_missing_wiki_page` fs 命令、`previewReturnView` + `closePreview` 导航模式、`ChatRetrievalMode` 类型、smart retrieval mode、in-page selection assistant、page links panel、agent file activity、document/media preview expansion。
> - **冲突解决**：15 个冲突文件。
>   - `lib.rs`：合并 fork 的 single-instance guard + 上游的 `apply_linux_webkit_compat_env`；invoke_handler 保留 fork 的 `write_binary_file` + 上游新增 4 个命令。
>   - `fs.rs`：保留 fork 的 `write_binary_file` + 采用上游的 `apply_text_selection_edit`/`create_missing_wiki_page`。
>   - `wiki-store.ts`：合并 fork 的 `previousView`/`searchFocusRequest` + 上游的 `previewReturnView`/`closePreview`。
>   - `persist.ts`：合并 fork 的 `ActivityItem` 导入 + 上游的 `ChatRetrievalMode`。
>   - `changelog.ts`：保留 fork 全部历史，顶部新增 0.6.4 条目（包含上游 v0.6.1 的 highlights）。
>   - `i18n/en.json`/`zh.json`：合并重复的 `editor.refresh` 块到主 `editor` 对象内。
>   - `file-preview.tsx`：合并 fork 的 `useTranslation`/`defaultValue` + 上游的 `useState`；删除重复导入。
>   - `embedding-section.tsx`：移除 fork 的 `setReindex` 调用（上游已内置到 `embedAllPages`）。
>   - README/README_CN/README_JA：采用上游版本。
>   - package-lock.json/Cargo.lock：采用上游版本后重新生成。
>   - `persist.integration.test.ts`：修正路径 `.llm-wiki/chats` → `.llm-wiki-local/chats`。
> - **验证**：typecheck ✅ 0 错误 / test:mocks 2274 ✅（160 文件）/ cargo check ✅。版本号 `0.6.4` > 上游 `0.6.3`，自动更新降级判定保持有效。
>
> **Round 7 同步（2026-07-27，v0.6.3 → v0.6.5）**：`git merge upstream/main`（HEAD `4cb17cb`）。上游本轮 68 个提交、125 文件（+7690/−1146），主线是模型配置体系（项目级模型、Chat/Ingest 分路由、多自定义 provider、自定义请求头、流式开关）+ 资料格式扩展（EPUB/MOBI 经新 `ebook.rs`、Org mode、批量 URL 导入）+ 只读原文回答模式 + MCP 会话绑定项目 + embedding 索引加速。
> - **13 个冲突文件，全部 keep-both 或弃我方取上游**：
>   - `Cargo.toml`：版本保留我方线；依赖取上游 `epub 2.1.5`+`mobi`+`html2text`（移入 `[dependencies]` 主表，避免落在 target 段之后），保留我方 single-instance/libc target 段；删除我方旧 `epub = "2"` 注释块。
>   - `fs.rs`：**弃我方自研 epub 提取**（`extract_epub_text`/`xhtml_to_plain_text`/`decode_html_entities` 及 5 个 CJK 回归测试）——上游 `ebook.rs` 用 `html2text` 正确处理 UTF-8，我方实现冗余；采用上游 `EBOOK_EXTS`/`LEGACY_DOC_EXTS`（doc/xls 已上移 OFFICE）与 org 提取；保留上游 org 测试。
>   - `llm-providers.ts`：**保留我方 Azure 双端点修复**（`azureV1`/`azureClassic`/`azureAuthStyle`，v0.6.8–0.6.10 的 404/model/max_completion_tokens 系列），套进上游重构（`mergeLlmRequestHeaders` 自定义请求头 + `buildOpenAiCompatibleBody(..., streaming)` 流式参数）。
>   - `App.tsx`：keep-both——我方 activity 持久化导入 + 上游 `loadCustomLlmPresets`/`loadTaskModelRouting`/`loadProjectLlmOverride`。
>   - `knowledge-tree.tsx`：保留我方 34 类 `TYPE_CONFIG`（labelKey 模式 + dark: 配色），不取上游 `sidebar.typeLabels.*`；删除合并产生的重复 `useTranslation` 导入。
>   - `search-view.tsx`：保留我方 Esc 返回/关闭按钮（搜索聚焦导航），placeholder 改用上游 `search.placeholderWithShortcut`。
>   - `i18n/{en,zh}.json`：keep-both（我方 `editor.refresh`/ingest resume 键 + 上游 `editor.frontmatter`/fileSync 键）；另补上游漏发的 `lint.reconcile*` 5 键（parity 测试抓到）。
>   - `changelog.ts`：弃上游 0.6.4/0.6.1 条目（与我方同号冲突），内容并入我方新 0.6.11 条目。
>   - `package.json`/`tauri.conf.json`/`Cargo.toml`：版本号统一升 `0.6.11` > 上游 `0.6.5`，自动更新降级判定保持有效；`Cargo.lock` 取上游后由 cargo 重新生成。
> - **验证**：typecheck ✅ 0 错误 / test:mocks 2368 ✅（165 文件）/ i18n parity ✅ 6/6 / cargo check ✅ / cargo test ✅。

> **Round 8 同步（2026-07-27，v0.6.5 → v0.6.6）**：`git merge upstream/main`（HEAD `98786f6`）。上游本轮仅 1 个发布提交、16 文件（+293/−24）：博查（Bocha）网页搜索 Provider（Agent / Deep Research / API / MCP 均可用）、Ingest 截断定向恢复（自动重新生成缺失 Wiki 文件）、PDF 跨平台预览完善、Windows 计划导入/嵌套路径/盘符与 UNC 路径处理、Clip Server 重试上限 off-by-one 修复。
> - **6 个冲突文件，全部为版本号类**：`package.json`/`package-lock.json`/`Cargo.toml`/`Cargo.lock`/`tauri.conf.json` 保留我方版本线并统一升 `0.6.12` > 上游 `0.6.6`（上游本轮仅 bump 版本号，无依赖变更）；`changelog.ts` 按惯例将上游 0.6.6 条目内容并入我方新 0.6.12 条目，不保留上游同号条目。
> - **自动合并文件语义核查**：`tools.rs`/`ingest.ts`/`web-search.ts`/`clip_server.rs` 合并后与上游完全一致（fork 在这些文件无分歧改动）；fork 的 Azure 修复在 `provider.rs`、搜索聚焦导航在 `wiki-store.ts`，均未受本轮影响、完整保留。
> - **验证**：typecheck ✅ 0 错误 / test:mocks 2370 ✅（165 文件）/ cargo check ✅ / cargo test ✅。
| 工作目录 | `app/`（即原 upstream 的项目根） |

## 仓库布局

两个 git 仓库并存：

- `LLMWiKi/.git/` — **外层仓库**，追踪 `UPSTREAM.md`、`docs/`、`.gitignore`、顶层 `README.md`
- `LLMWiKi/app/.git/` — `nashsu/llm_wiki` 的克隆，**所有应用源码改动在这里提交**

外层 git 不会递归进入 `app/`（git 视嵌套 `.git` 为不透明）。要追踪应用层改动，请进入 `app/` 目录后再 commit。

> 升级到 submodule 布局（推荐当您 fork 了 nashsu 仓库后）：
> ```bash
> rm -rf app
> git submodule add -b main https://github.com/YOUR-USER/llm_wiki.git app
> ```
> 之后我们的改动落在您的 fork，可向 upstream 发 PR。

## 我们在 upstream 之上新增的功能

| 功能 | 新增 / 修改文件 | 文档 |
|---|---|---|
| `.llmwiki` 导入/导出包 | `app/src-tauri/src/commands/package.rs`<br>`app/src/lib/package.ts`、`package-manifest.ts`<br>`app/src/components/settings/sections/import-export-section.tsx` | [docs/features.md §1](docs/features.md#1-llmwiki-导入导出包) |
| 页面级定时联网刷新 | `app/src/lib/scheduled-refresh.ts`<br>`app/src/lib/refresh-runner.ts`<br>`app/src/lib/refresh-runner.test.ts` (13 cases)<br>`app/src/components/settings/sections/scheduled-refresh-section.tsx`<br>`app/src/components/editor/refresh-controls.tsx` | [docs/features.md §2](docs/features.md#2-页面级定时联网刷新) |
| 本地 vs 共享配置分离（`.llm-wiki-local/`） | `app/src/lib/persist.ts`（修改 + legacy 迁移）<br>`app/src/components/chat/chat-panel.tsx`（小改） | [docs/features.md §3](docs/features.md#3-本地--共享状态分离)<br>[docs/cloud-sharing.md](docs/cloud-sharing.md) |
| **中文 i18n 全模块补全** | `app/src/i18n/{en,zh}.json`（`importExport.*` / `scheduledRefresh.*` / `editor.refresh.*` 全部翻译） | [docs/user-manual.md §2.2](docs/user-manual.md#22-切语言一键可随时切) |
| **一键切语言（无需点 Save）** | `app/src/components/settings/sections/interface-section.tsx`（点击立即 `i18n.changeLanguage` + `saveLanguage`） | [docs/user-manual.md §2.2](docs/user-manual.md#22-切语言一键可随时切) |
| **应用内嵌「用户手册」** | `app/src/components/settings/sections/user-manual-section.tsx`<br>`app/src/content/user-manual.{zh,en}.md`（bundle 源） | [docs/user-manual.md](docs/user-manual.md) |
| **「存储位置」检测（含 NAS）** | `app/src-tauri/src/commands/storage.rs`（statfs/网络挂载识别）<br>`app/src/components/settings/sections/storage-location-section.tsx`（厂商提示卡 + 排除命令复制） | [docs/cloud-sharing.md §6](docs/cloud-sharing.md#六nas-部署群晖--飞牛--qnap--terramaster) |
| **智能拆分 + 综合 schema（34 类，中文优先）** | `app/src/lib/templates.ts`（双语模板 + `getTemplate(id, lang)`）<br>`app/src/lib/ingest.ts`（`buildAnalysisPrompt` + `buildGenerationPrompt` 重写、source summary fallback 放宽）<br>`app/src/components/settings/sections/schema-upgrade-section.tsx`（一键升级按钮）<br>`app/src/components/project/create-project-dialog.tsx`（按 UI 语言选 zh/en） | [docs/features.md §5](docs/features.md#5-智能拆分--splitting-rules综合-schema--单页类型) |
| **自己 GitHub 自动更新（就地）+ 加密配置备份** | `app/src/lib/app-repo.ts`（更新源指向 `chunguangwei/LLMWiKi`）<br>`app/src/lib/updater.ts`（in-place 更新 helper）<br>`app/src/components/layout/update-banner.tsx` + `settings/sections/about-section.tsx`（「立即更新」UI）<br>`app/src-tauri/src/commands/config_crypto.rs`（Argon2id+AES-256-GCM 口令导出/导入）<br>`app/src-tauri/src/commands/config_backup.rs`（keyring 托管自动备份/恢复）<br>`app/src/components/settings/sections/config-backup-section.tsx`<br>`tauri.conf.json`（updater 插件 + pubkey）、`.github/workflows/build.yml`（签名 env）、`Cargo.toml`（updater/process/argon2/aes-gcm/keyring/zeroize/rand 依赖） | [docs/features.md §6](docs/features.md#6-自己-github-自动更新就地更新--加密配置备份) |

辅助修改：
- `app/src/components/settings/settings-view.tsx` — 注册六个新 `CategoryId`（`scheduled-refresh`、`import-export`、`storage-location`、`user-manual`、`schema-upgrade`、`config-backup`）
- `app/src-tauri/src/commands/mod.rs`、`app/src-tauri/src/lib.rs` — 注册 package + storage Tauri 命令
- `app/src-tauri/Cargo.toml` — 新增 `libc`（target-conditional，仅 macOS/Linux，存储检测用）
- `app/src/types/wiki.ts` — 加 `RefreshConfig` 类型
- `app/src/i18n/{en,zh}.json` — 新分类标签 + `scheduledRefresh` / `importExport` / `storageLocation` / `userManual` 子树
- `app/src/test-helpers/fs-temp.ts` — mock 补 `fileExists`
- `app/.gitignore` — 加 `.llm-wiki-local/`

## 命名约定（便于将来与 upstream merge）

新文件使用专属前缀，最大化降低合并冲突：
- `package-*`、`refresh-*`、`scheduled-refresh*`、`import-export-*`、`storage-*`、`user-manual-*`

修改 upstream 文件时尽量只追加，不改原有逻辑。

## Sync with upstream

```bash
cd app
git fetch origin main
git merge origin/main
# 经常出现冲突的文件（实战已验证 keep-both 策略可行）：
#   src/components/settings/settings-view.tsx     ← CategoryId + CATEGORIES + switch
#   src/i18n/{en,zh}.json                          ← settings.categories + settings.sections
#   src-tauri/src/commands/mod.rs                  ← 模块注册
#   src-tauri/src/lib.rs                           ← invoke_handler 注册
```

## 2026-05-19 sync 记录（0.4.10 → 0.4.12）

上游新增了 6 个 commit，全部 keep-both 合并进来：
- **Add graph search** (`19867a8`) — 新增 `src/lib/graph-search.ts` + test
- **API Server 设置面板** — 新文件 `api-server-section.tsx`（464 行）+ Rust 端 `api_server.rs`
- **search 引擎重构** — `src/lib/search.ts` 从 ~600 行拆为多模块，retrieval 测试套迁移到 RRF
- **fix: SearXNG 不强制要求 API Key**
- Release v0.4.11、v0.4.12

合并过程见 commit `3a74605` 的描述。我们 fork 这次也升级了 `storage-location` 的侧栏图标（`Server` → `HardDrive`）以避免与上游新 `api-server` 分类同 icon。

## 2026-05-25 sync 记录（0.4.12 → 0.4.13）

上游新增 37 个 commit，全部合并进来（branch `sync/upstream-0.4.13`）。上游主要优化点：

- **资料处理加固（与中文路径强相关）** — 新增 `source-identity.ts`、`raw-source-resolver.ts` 重构，修复嵌套资料文件夹、非英文（中文）路径、Windows 兼容；摄入失败可「重试全部」、手动重试重置计数；文件同步启动去重加固；Codex CLI 在 Windows 下的流式完成修复。
- **新 provider / 功能** — Azure OpenAI provider（`azure-openai.ts`）、Ollama 免 API Key 网页搜索、设置里的连接测试（`connection-tests.ts`）、研究型页面类型 finding/thesis/methodology、DeepSeek 预设更新。
- 本地 API 与搜索可靠性、SearXNG 配置等修复。

8 处冲突的解决策略：

| 文件 | 解决方式 |
|---|---|
| `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` | **保留我方版本线**，统一升到 `0.4.16`（绝不能被上游 `0.4.13` 覆盖，否则自动更新判定降级失效）|
| `src/lib/changelog.ts` | 保留我方 0.4.13/0.4.14/0.4.15 条目，丢弃上游与我方同号的 0.4.13 条目，新增 0.4.16 条目记录本次 sync |
| `src/components/graph/graph-view.tsx` | 保留我方按 `NODE_TYPE_COLORS` 动态生成图例的写法（已覆盖全部综合 schema 类型，自然含上游新增的 3 个研究类型）|
| `src/components/layout/knowledge-tree.tsx` | 保留我方综合 `TYPE_CONFIG`（labelKey 模式），**追加** 上游新增的 finding/thesis/methodology 三类（import `TrendingUp`/`Target` 图标 + i18n key）|
| `src/lib/ingest.ts` | 保留我方综合 schema 的生成 prompt 与放宽的 `hasSourceSummary` 检测，但改用上游重构后的 `sourceSummarySlug`/`sourceSummaryPath` 变量（避免重复声明）|

附带处理：
- `src/test-helpers/fs-temp.ts` — 双方都加了 `fileExists` mock，去重保留一份。
- `src/i18n/{en,zh}.json` — 在 `knowledgeTree.types` 子树补 finding/thesis/methodology（我方用 labelKey，上游只加在 `graph.nodeTypeLabels`）。
- `src/lib/ingest-source-path-collision.test.ts`（上游新测试）— 其 mock 用上游 prompt 措辞抓取摘要路径；放宽正则使其也能识别我方 prompt 的 fallback 行（`fall back to: \`wiki/sources/…\``），断言不变。

## 当前验证状态

| 检查 | 命令 | 结果（2026-05-25，0.4.16） |
|---|---|---|
| 前端类型检查 | `cd app && npm run typecheck` | ✅ 零错误 |
| 前端单元测试 | `cd app && npm run test:mocks` | ✅ 1156 / 1156 通过 |
| i18n 一致性 | `cd app && npx vitest run src/i18n/i18n-parity.test.ts` | ✅ 5 / 5 通过（en ↔ zh 全键对齐）|
| Rust 编译检查 | `cd app/src-tauri && cargo check` | ✅ 新代码零警告（8 处遗留 upstream warning 不变） |
| Rust 单元测试 | `cd app/src-tauri && cargo test --lib` | ✅ 103 / 103 通过（含 config_crypto 4 例）|

Windows / Linux 构建未在本机验证；可通过 upstream 的 `.github/workflows/release.yml` 在 GitHub Actions 跑。

## 致谢

- [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) — 实现了完整的 Tauri 桌面应用骨架
- [Andrej Karpathy](https://github.com/karpathy) — 提出 LLM Wiki 范式
