# 入门指南

适用于：第一次拿到 LLMWiki，想跑起来并理解工作流的用户。

---

## 1. 安装

### 方式 A：直接用预编译 dmg（macOS Apple Silicon）

本仓库已生成好一份 dmg：

```
app/src-tauri/target/release/bundle/dmg/LLM Wiki_0.4.13_aarch64.dmg
```

1. 双击 dmg，把 `LLM Wiki.app` 拖入 Applications
2. 首次启动时 macOS Gatekeeper 会拦截（应用未签名）—— 右键 → 「打开」，或在 *系统设置 → 隐私与安全性* 底部点击 **仍要打开**
3. 之后正常使用

> **为什么未签名**：Apple Developer ID 每年 $99，本项目目前没有付费签名。GPL v3 OSS 项目这是常态，对功能无影响。

### 方式 B：从源码构建

前置：
- Node.js 20+
- Rust 1.70+（`brew install rust` 或 `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）

```bash
cd app
npm install
npm run tauri build        # 出 dmg/app
# 或:
npm run tauri dev          # 开发模式，热重载
```

详细的所有命令、产物路径、各平台差异见下面的 [§1.5 目录结构 + 打包矩阵](#15-目录结构--打包矩阵)。

### 方式 C：直接下预编译包（Windows / Linux，已正式发布）

CI 已为每个 release 生成 Windows 与 Linux 安装包，统一从这里下载最新版：

👉 https://github.com/chunguangwei/LLMWiKi/releases/latest

**Windows（仅 x64，无 ARM64）**：

| 文件 | 说明 |
|---|---|
| `LLM.Wiki_<版本>_x64-setup.exe` | NSIS 安装程序，**普通用户推荐** |
| `LLM.Wiki_<版本>_x64_en-US.msi` | MSI 安装程序，适合企业批量部署 / 组策略 |

1. 下载 `-setup.exe`，双击运行
2. 首次运行弹 **「Windows 已保护你的电脑」**（SmartScreen，因安装包未用商业证书签名）—— 点 **更多信息（More info）→ 仍要运行（Run anyway）**
3. 按引导装好即可

> **为什么会被 SmartScreen 拦**：和 macOS 未签名同理，本项目没买 Windows 商业代码签名证书（EV 证书费用高）。这不影响功能或安全，自动更新另有 minisign 签名校验。

**Linux**：`_amd64.deb` / `_arm64.deb`（Debian/Ubuntu）、`_amd64.AppImage` / `_aarch64.AppImage`（通用）、`-1.x86_64.rpm` / `-1.aarch64.rpm`（Fedora/RHEL）。

> 各平台完整下载表与安装注意事项见 [release-and-update.md §1](release-and-update.md#1-下载最新版终端用户视角)。打 tag 触发 CI 自动发版的流程见 §1.5.4 + [features.md §6](features.md#6-自己-github-自动更新就地更新--加密配置备份)。

---

## 1.5 目录结构 + 打包矩阵

> 本节是从源码构建 / 开发 / 自分发的速查表。只想用预编译应用的读者可以跳到 [§2](#2-首次启动后)。

### 1.5.1 仓库顶层（LLMWiKi/）

```
LLMWiKi/
├── README.md                    # 项目入口
├── UPSTREAM.md                  # fork 元信息、与 upstream 的 sync 工作流
├── .gitignore                   # 外层仓库忽略规则（含 app/, .claude/, .llm-wiki-local/）
├── .git/                        # 外层仓库（只追踪本目录的文档与配置）
├── app/                         # 应用源码（自带独立 .git，见 §1.5.2）
└── docs/                        # 用户文档
    ├── getting-started.md       # 本文件
    ├── features.md              # 三个新功能的详细用法
    └── cloud-sharing.md         # 云盘 + 团队部署
```

**注意双 git 布局**：外层 git 不进入 `app/`，所有应用源码改动必须 `cd app` 后再 commit。

### 1.5.2 应用源码（LLMWiKi/app/）

```
app/
├── package.json                 # 前端依赖、脚本入口（dev / build / typecheck / test / tauri）
├── vite.config.ts               # Vite 配置
├── tsconfig*.json               # TypeScript 编译配置
├── index.html                   # Vite 入口 HTML
├── components.json              # shadcn/ui 配置
├── .gitignore                   # 应用层忽略规则（含 .llm-wiki-local/）
├── .git/                        # nashsu/llm_wiki 克隆，应用代码 git 历史在此
├── .github/workflows/           # GitHub Actions CI（出 mac / win / linux 产物）
├── assets/                      # README 用的截图
├── extension/                   # Chrome Web Clipper 扩展源码
├── src/                         # 前端 React + TypeScript 源码
│   ├── App.tsx, main.tsx        # 应用入口
│   ├── commands/                # 调用 Tauri 后端命令的 TS 封装
│   ├── components/              # React 组件（按业务域分子目录）
│   │   ├── chat/, editor/, graph/, lint/, project/, review/,
│   │   ├── search/, sources/, settings/, layout/, ui/, error-boundary
│   │   └── settings/sections/   # ★ 新功能 UI 都在这里：import-export-section.tsx,
│   │                            #   scheduled-refresh-section.tsx
│   ├── stores/                  # Zustand 全局状态
│   ├── lib/                     # 业务逻辑（ingest / search / graph / refresh-runner / …）
│   ├── types/                   # 共享 TS 类型（含 RefreshConfig）
│   ├── i18n/                    # 多语言 JSON（en / zh）
│   ├── test-helpers/            # 测试用 fs 适配器
│   └── stores/, lib/*.test.ts   # vitest 单元测试就近放
├── src-tauri/                   # Rust 后端（Tauri）
│   ├── Cargo.toml               # Rust 依赖（zip / sha2 / walkdir / pdfium / lancedb …）
│   ├── tauri.conf.json          # 应用 ID / 窗口 / bundle 配置
│   ├── icons/                   # 应用图标多分辨率
│   └── src/
│       ├── main.rs, lib.rs      # 后端入口，注册所有 Tauri 命令
│       ├── commands/            # 每个命令模块（fs / project / vectorstore / package / …）
│       │   └── package.rs       # ★ 新增：.llmwiki 导入/导出
│       ├── types/               # Rust 端共享类型
│       ├── proxy.rs, panic_guard.rs, clip_server.rs
│       └── target/              # ★ Cargo 编译产物（gitignore；下面 §1.5.4 说打包位置）
├── plans/                       # 上游项目规划文档
├── llm-wiki.md                  # Karpathy 原始 gist 的本地副本
└── README.md, README_CN.md, README_JA.md
```

### 1.5.3 项目数据目录（用户实际用 wiki 时的目录）

应用「创建项目」会在用户选定的位置生成：

```
my-wiki-project/                 # 用户自取名，可放云盘
├── purpose.md                   # 项目目的、核心问题、研究范围（人工填写）
├── schema.md                    # 页面类型、命名约定（可调）
├── raw/
│   ├── sources/                 # ★ 用户往这里丢源文档（PDF / DOCX / MD / 网页剪藏 …）
│   └── assets/                  # 图片附件
├── wiki/                        # ★ LLM 生成的 wiki 页面（按 schema.md 分目录）
│   ├── index.md                 # 内容目录（LLM 维护）
│   ├── log.md                   # 时序操作日志
│   ├── overview.md              # 全局概览
│   │                            # 综合模板（默认）的中文 UI 目录：
│   ├── 旅游方案/                 #   单页类型 — 整篇保留
│   ├── 用户手册/
│   ├── 项目文档/
│   ├── 教程/  ├── 书籍/  ├── 食谱/  ├── 笔记/
│   ├── 报告/  ├── 文章/  ├── 会议/  ├── 决策/  ├── 项目/
│   ├── 影视/  ├── 音乐/  ├── 游戏/  ├── 菜单/
│   ├── 购物清单/  ├── 健身计划/
│   ├── 合同/  ├── 发票/  ├── 医疗记录/  ├── 保险单/
│   ├── 代码片段/  ├── API文档/  ├── 错误日志/
│   ├── 论文/                    #   可拆分类型 — 源摘要 + 子页
│   ├── 概念/  ├── 工具/  ├── 数据集/
│   ├── 人物/  ├── 公司/  ├── 法规/
│   └── 综合/                    #   跨主题分析
│                                # 英文 UI 创建时是 ASCII slug（travel-plans/、books/ …）
├── .obsidian/                   # 自动生成，可直接当 Obsidian vault 打开
├── .llm-wiki/                   # ★ 项目共享元数据（云盘同步友好）
│   ├── project.json             # 项目 UUID
│   ├── ingest-cache.json        # SHA256 去重缓存
│   ├── ingest-queue.json        # 待处理队列
│   ├── dedup-not-duplicates.json
│   ├── image-caption-cache.json
│   ├── review.json              # 审核队列
│   ├── scheduled-import-db.json
│   └── page-history/            # 页面版本快照
└── .llm-wiki-local/             # ★ 个人私密（必须排除云盘同步）
    ├── conversations.json       # 聊天会话列表
    └── chats/<convId>.json      # 单个会话消息历史
```

**API Key 不在这里** —— 它存在 OS 应用数据目录（identifier 锁定为 `com.llmwiki.app`，**勿改**）：
- macOS: `~/Library/Application Support/com.llmwiki.app/app-state.json`
- Windows: `%APPDATA%\com.llmwiki.app\app-state.json`
- Linux: `~/.config/com.llmwiki.app/app-state.json`

> 这个文件含全部配置 + API Key（加密备份见 [features.md §6.4](features.md#64-加密配置备份防丢-key)）。别用深度卸载工具（AppCleaner 等）删它。

### 1.5.4 打包命令与产物位置

所有命令都在 `app/` 目录下执行。`<arch>` 在 Apple Silicon 上是 `aarch64`，Intel 上是 `x86_64`。

| 命令 | 用途 | 产物位置 |
|---|---|---|
| `npm install` | 安装 805 个 npm 依赖 | `app/node_modules/`（~1 GB） |
| `npm run dev` | 仅前端 Vite 开发服 (5173) | 无产物 |
| `npm run tauri dev` | 开发模式（前端 + Rust 后端，热重载） | 临时窗口；Rust 增量编译产物在 `app/src-tauri/target/debug/` |
| `npm run typecheck` | TypeScript 全量类型检查 | 无产物（缓存在 `app/*.tsbuildinfo`） |
| `npm run test:mocks` | 单元测试（不调真实 LLM） | 无产物 |
| `npm run test:llm` | 单元测试（调真实 LLM，需 key） | 无产物 |
| `npm run tauri build` | 生产构建 + 打包 | 见下表 |

**`npm run tauri build` 产物明细**（首次约 8–15 分钟）：

| 平台 | 可执行文件 | 安装包 |
|---|---|---|
| **macOS** | `app/src-tauri/target/release/llm-wiki`（裸二进制）<br>`app/src-tauri/target/release/bundle/macos/LLM Wiki.app`（.app 包） | `app/src-tauri/target/release/bundle/dmg/LLM Wiki_<version>_<arch>.dmg` |
| **Windows** | `app/src-tauri/target/release/llm-wiki.exe` | `app/src-tauri/target/release/bundle/msi/LLM Wiki_<version>_<arch>_en-US.msi`<br>`app/src-tauri/target/release/bundle/nsis/LLM Wiki_<version>_<arch>-setup.exe` |
| **Linux** | `app/src-tauri/target/release/llm-wiki` | `app/src-tauri/target/release/bundle/deb/llm-wiki_<version>_<arch>.deb`<br>`app/src-tauri/target/release/bundle/appimage/llm-wiki_<version>_<arch>.AppImage`<br>`app/src-tauri/target/release/bundle/rpm/llm-wiki-<version>-1.<arch>.rpm` |

**本机已构建的产物**（如已 `npm run tauri build`）：

```
app/src-tauri/target/release/bundle/dmg/LLM Wiki_0.4.13_aarch64.dmg     # 26 MB
app/src-tauri/target/release/bundle/macos/LLM Wiki.app
```

**只构建不打包**：

```bash
cd app/src-tauri && cargo build --release   # 只出裸二进制 target/release/llm-wiki
```

**清理产物**：

```bash
cd app
rm -rf src-tauri/target          # Rust 编译缓存（可能 5–10 GB）
rm -rf node_modules dist         # 前端依赖与产物
```

**跨平台一次性出三平台产物 + 自动更新发布**：

`app/.github/workflows/build.yml` 已配好。流程：

```bash
cd app
# 1. 提升版本号（两处保持一致）
#    package.json: "version": "0.4.13"
#    src-tauri/tauri.conf.json: "version": "0.4.13"
git commit -am "release v0.4.13"
git push origin main
# 2. 打 tag 触发 CI
git tag v0.4.13
git push origin v0.4.13
```

CI 自动：跨平台构建 → 用 updater 私钥签名 → 生成 `latest.json` → 创建 GitHub Release，附 dmg / msi / exe / deb / AppImage + `latest.json` + `.sig`。各台已安装的 app 下次启动即可一键就地更新（详见 [features.md §6](features.md#6-自己-github-自动更新就地更新--加密配置备份)）。

**自动更新所需的两个 GitHub Secrets**（仓库 → Settings → Secrets and variables → Actions）：

| Secret | 来源 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/llmwiki_updater.key` 文件内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码（`~/.tauri/llmwiki_updater.password`）|

> 这两个 secret 已配置在 `chunguangwei/LLMWiKi` 上。换电脑或重建密钥时需重新设置。**务必离线备份这两个文件**——私钥丢失则无法再签新版本，所有端自动更新失效。
>
> 仓库必须 **Public**，否则 app 抓不到 `latest.json`（私有 release 需 token，token 不能进 app）。

本机交叉编译复杂，**强烈不推荐**——CI 是最省事的路。

---

## 2. 首次启动后

### 2.1 配 LLM Provider

打开 **设置 → LLM Models**：

- **OpenAI / Anthropic / Google / OpenRouter** — 直接填 API Key 和模型名
- **Ollama**（本地）— 填本地 URL（默认 `http://localhost:11434`）
- **Custom Endpoint** — 任何 OpenAI 兼容 API（DeepSeek、Volcengine Ark、SiliconFlow、阿里通义、月之暗面等）

### 2.2 可选：配 Embedding（向量检索）

**设置 → Embeddings** 打开开关后，wiki 在 100+ 页规模下检索质量会显著提升。OpenAI text-embedding-3-small、智谱 embedding-2、bge-m3 都好用。可以暂时跳过。

### 2.3 可选：配 Web Search（用于「定时联网刷新」与「深度研究」）

**设置 → Web Search** 选一个：

| Provider | 推荐场景 | 说明 |
|---|---|---|
| Tavily | 个人首选 | 免费额度足够个人使用，对 LLM 友好 |
| SerpApi | 商用 | 多搜索引擎（Google / Bing / DuckDuckGo / Scholar / Patents …） |
| SearXNG | 隐私敏感 | 完全私有，需要您自己跑 SearXNG 实例 |

---

## 3. 创建第一个项目

1. 主界面 → **新建项目** → 选模板（推荐 *General Research*）
2. 给项目命名 → 选择目录（建议放在云盘里，方便多端同步）
3. 项目创建完成后会自动生成：
   - `raw/sources/` — 您往里丢源文档
   - `wiki/` — LLM 写的 wiki 页面
   - `schema.md` — 项目结构约定（可改）
   - `purpose.md` — 项目目的与关键问题（建议先填好）

---

## 4. 摄入第一份资料

最简单方式：

1. 把任意支持的文件拖到 `raw/sources/` 里
2. 应用左侧 *Sources* 面板会自动检测
3. 点 **Ingest**（或 *Sources* 顶部「全部摄入」）
4. 应用在右侧 Chat 面板里打字解释它做了什么，并在 `wiki/` 里生成多个页面

支持的摄入类型：

| 类别 | 扩展名 |
|---|---|
| 文档 | `.md` `.mdx` `.txt` `.pdf` `.docx` `.odt` `.rtf` |
| 演示 | `.pptx` `.odp` |
| 表格 | `.xls` `.xlsx` `.ods` `.csv` |
| 网页 | `.html` `.htm`（也可用 Chrome 扩展剪藏） |
| 数据 | `.json` `.yaml` `.yml` `.xml` |
| 图像 | 自动 OCR / 视觉描述（需开多模态） |

「两步思维链摄入」会先分析、再生成 wiki 页面，原始文档保留可追溯。

---

## 5. 提问 / 检索

切换到 **Chat** 面板，直接用自然语言问：

- 「Mixture-of-Experts 在 2025 年有哪些 benchmark 提升？」
- 「比较一下 GPT-4 和 Claude 4 在推理任务上的差异」
- 「我之前看过哪些关于 RAG 的论文？」

LLM 会用 wiki 而非原始文档作为知识源，回答带引用。**好答案可以「保存为新页面」**，让探索结果累积进 wiki。

---

## 6. 新功能立即可用

### `.llmwiki` 跨设备迁移

**设置 → 导入/导出** → *Export package* → 生成 `.llmwiki` 文件 → 拷到新机器 → *Import .llmwiki*。详见 [features.md](features.md#1-llmwiki-导入导出包)。

### 定时联网刷新

给一个 wiki 页 frontmatter 加：
```yaml
refresh-enabled: true
refresh-interval-days: 7
```
然后 **设置 → 定时联网刷新** 打开开关。详见 [features.md](features.md#2-页面级定时联网刷新)。

### 云盘 / 团队部署

详见 [cloud-sharing.md](cloud-sharing.md)。

---

## 7. 常见疑问

**Q：API Key 会被泄露吗？**
A：不会。API Key 通过 OS 应用数据目录的 Tauri Store 保存（macOS: `~/Library/Application Support/`），完全不在项目目录里，云盘同步项目也不会带它。

**Q：聊天记录会和团队共享吗？**
A：不会。聊天落在 `.llm-wiki-local/`，本仓库的 `.gitignore` 已排除，部署文档里也说明如何在 iCloud/OneDrive/Dropbox 里排除。详见 [cloud-sharing.md](cloud-sharing.md)。

**Q：摄入失败 / 卡住？**
A：右下角有进度，检查 LLM provider 是否能联通（**设置 → LLM Models** 有「Test」按钮）。所有失败任务可在 *Review* 面板重试。

**Q：能换语言吗？**
A：**设置 → 界面 → UI 语言** 点中文 / English。本 fork 已升级为「点击立即生效并自动保存」，不必再点底部 Save。

**Q：怎么定义自己的分类和写作规则？**
A：编辑项目根的 `schema.md` —— LLM 在每次摄入和回答前都会读这个文件，遵循里面定义的页面类型、命名约定、frontmatter 字段。详见 [user-rules.md](user-rules.md)（含 10+ 分类示例模板）。
