# Upstream & Fork

本项目（LLMWiKi）是 [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) 的 fork，实现了 Andrej Karpathy 的「持久化 wiki」模式（[原始 gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)）。

| 项 | 值 |
|---|---|
| Upstream | `nashsu/llm_wiki` `main` 分支（remote `upstream`）|
| 我们的仓库 | `chunguangwei/LLMWiKi`（remote `origin`，Public，自动更新源）|
| Fork 时间 | 2026-05-18（shallow clone；2026-05-20 已 `--unshallow` 补全历史）|
| 最近一次 sync | 2026-06-23（Round 3 大同步，merge-base `70d5579`，按子系统逐项移植至上游 v0.4.25，14 个 fork 提交 `890ea29`→`813819e`；cherry-pick 不可行，i18n/wiki-store/ingest 已结构性分叉，故全程手工三方合并）|
| License | **GPL v3** — 我们的分发版本同样保持 GPL v3 |
| Upstream 版本号 | `0.5.1`（Round 3 追平：providers / embeddings+LanceDB / 摄取质量 / 审阅 / 渲染 / 稳定性 / 关系图性能 / MiniMax M3 / Lint 链接修复 / Firecrawl / 界面缩放 / MinerU / 托盘+自启 / MCP 打包 / 聊天独立视图）|
| **本 fork 版本** | `0.5.2`（在 v0.5.1 上修复 app 图标白边[改用矢量图+透明圆角] 与暗色主题关系图标签可读性；macOS 仅 arm64）|

> **Round 3 同步原则（2026-06-23）**：用户指示「冲突处优先采用上游、丢弃我方实现」；独立不冲突的 fork 功能保留。**唯一排除** `d969cd4`（schema 路由，触碰核心 34 类 split/schema 红线）。**需一次测试发版验证**：MCP 资源打包、托盘/开机自启运行时、新的中央预览布局。
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
