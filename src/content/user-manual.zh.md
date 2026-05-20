# LLMWiki 用户使用手册

适用版本：0.4.13（LLMWiKi fork）

本手册面向**正在使用 LLMWiki 的人**。需要安装步骤的从源码构建说明请看 [`getting-started.md`](getting-started.md)。

---

## 1. 这个应用是什么

LLMWiki 帮你把零散文档（PDF / DOCX / 网页 / OneNote / ...）变成一个**结构化、相互关联、能持续更新**的知识库。

工作流是这样的：

```
你 → 丢资料进 raw/sources/   ↓
                              LLM 阅读、整理
                              生成 wiki 页面、维护交叉引用、追加日志
                              ↓
你 → 对着 wiki 提问           ↓
                              LLM 用 wiki 回答，有引用
                              ↓
你 → 把好答案保存为新页       ↓
                              下次同主题问题不重新推理
```

跟 ChatGPT 上传文件不一样的地方：**知识只编译一次**。你不必每次问问题都重新让 LLM 翻遍原文档。

---

> **想自定义分类、写作规则、frontmatter 字段？** 直接跳 §6 + [`user-rules.md`](user-rules.md)。

## 2. 启动与配置（10 分钟）

### 2.1 启动

- macOS：双击 `LLM Wiki.app`（首次右键 → 打开绕过 Gatekeeper）
- Windows：双击安装的 `LLM Wiki.exe`

### 2.2 切语言（一键，可随时切）

**设置 → 界面 → UI 语言** → 点 **中文** 或 **English**

> 改进点：从 LLMWiKi fork 开始，**点击即刻生效并自动保存**，不需要再点下方的「保存」按钮。

### 2.3 配 LLM Provider

**设置 → LLM 模型** → 选 provider → 填 API Key + 模型名

| 选择 | 注意 |
|---|---|
| OpenAI / Anthropic / Google | 直接填官方 Key |
| OpenRouter | 一个 Key 通吃多模型，性价比高 |
| DeepSeek / Volcengine / 通义 / Kimi | 选 **Custom Endpoint**，填 OpenAI 兼容地址 |
| Ollama（本地） | 默认 `http://localhost:11434`，免费 |

每项填好后按右侧 **Test**，绿色 ✓ 即可。

### 2.4 可选：开向量检索 / 网页搜索

- **设置 → 嵌入向量** → 开启后 100+ 页的 wiki 检索质量明显提升
- **设置 → 网页搜索** → 选 Tavily（个人）/ SerpApi（商用）/ SearXNG（隐私），填 Key 或地址

这两项不开也能用，但开了体验跳一档。

---

## 3. 第一个项目（5 分钟）

1. 主界面 → **新建项目**
2. 选模板：**默认为「综合（推荐）」** —— 含 34 个目录，覆盖日常资料（旅游、手册、书籍、食谱、合同、代码…）+ 研究 / 工作类型
   - 中文 UI 创建项目时目录名直接是中文（`wiki/旅游方案/`、`wiki/书籍/`）
   - 英文 UI 创建时是 ASCII（`wiki/travel-plans/`、`wiki/books/`）
   - 也可选窄场景模板：研究 / 阅读 / 个人成长 / 商务 / 通用（最小化）
3. 命名 + 选目录（**建议放 iCloud / OneDrive / Dropbox**，方便多端同步）
4. 创建完成 → 项目根自动生成：
   ```
   my-wiki/
   ├── purpose.md       # 项目目的（建议先填几句）
   ├── schema.md        # 页面类型与命名约定（综合模板含 34 类）
   ├── raw/sources/     # ← 资料丢这里
   ├── wiki/            # ← LLM 写的页面，按 schema 分目录
   │   ├── 旅游方案/     #   单页类型：整篇保留
   │   ├── 用户手册/
   │   ├── 项目文档/
   │   ├── 书籍/
   │   ├── 食谱/
   │   ├── 论文/         #   可拆分类型：源摘要 + 概念子页
   │   ├── 概念/
   │   └── ...
   ├── .llm-wiki/       # 项目共享元数据（云盘可同步）
   └── .llm-wiki-local/ # 个人聊天记录（必须排除云盘同步）
   ```

> 综合模板的拆分规则、完整分类清单见 [`features.md §5`](features.md#5-智能拆分--splitting-rules综合-schema--单页类型) 和 [`user-rules.md §2.0`](user-rules.md#20-综合34-类推荐默认-)。

---

## 4. 日常使用

### 4.1 摄入新资料

把文件直接拖进 `raw/sources/` 或左侧「资料」面板的 **导入** 按钮：

| 类型 | 扩展名 |
|---|---|
| 文本 | `.md` `.mdx` `.txt` `.rtf` |
| 文档 | `.pdf` `.docx` `.odt` |
| 演示 | `.pptx` `.odp` |
| 表格 | `.xlsx` `.ods` `.csv` `.xls` |
| 网页 | `.html` `.htm`（也可用 Chrome 扩展剪藏） |
| 数据 | `.json` `.yaml` `.yml` `.xml` |
| 图片 | 自动 OCR / 视觉描述（需开多模态） |

LLM 会自动：
1. 读懂内容
2. 写一个 source 摘要页
3. 提取实体 / 概念，更新已有页面或新建
4. 追加 `wiki/log.md` 日志

整个过程在右侧 Chat 面板里逐步显示，你可以看 LLM 在想什么。

### 4.2 提问

切换到 **聊天** 面板，直接用自然语言问：

- 「我所有关于 RAG 的笔记里，最有争议的观点是什么？」
- 「对比一下我整理过的 GPT-4 和 Claude 4」
- 「这个月加入的资料涉及哪些新概念？」

**好的回答可以「保存为新页面」**，让探索结果累积进 wiki，下次不必重问。

### 4.3 看图谱

切换到 **图谱** 面板：
- 节点 = wiki 页面，边 = 引用关系
- 自动 Louvain 社区检测，按颜色分簇
- **图谱洞察** 自动发现「惊奇连接」和「知识空白」，一键触发 Deep Research 自动补齐

### 4.4 审核

LLM 摄入时遇到模糊判断会标记到 **审核** 面板：
- 矛盾（contradiction）
- 重复（duplicate）
- 缺失页面（missing-page）
- 建议（suggestion，**也包括定时联网刷新生成的更新建议**）

你点确认 / 拒绝即可，不必中断 LLM 的工作流。

---

## 5. 五个新功能（LLMWiKi fork 独有）

### 5.1 `.llmwiki` 一键导入 / 导出

**入口：设置 → 导入 / 导出**

打包整个项目（含原文档 + wiki + 共享元数据）成单个 `.llmwiki` 文件。**不含**聊天记录、API Key、向量索引。

**导出**：
1. 打开要分发的项目
2. 设置 → 导入 / 导出 → 可选填「你的名字」（写入 manifest）
3. 「导出包」→ 选保存位置 → 生成 `项目名-日期.llmwiki`

**导入**：
1. 选「跳过已存在文件」或「全部覆盖」
2. 「导入 .llmwiki」→ 选文件 → 选目标目录 → 自动校验 SHA256 后解包

**适合场景**：
- Mac → Win 跨设备搬家
- 团队首次分发同一份 wiki
- 周度归档备份

详细字段说明见 [`features.md §1`](features.md#1-llmwiki-导入导出包)。

### 5.2 页面级定时联网刷新

**入口：设置 → 定时联网刷新** + 编辑器内 frontmatter

给容易过时的 wiki 页面（项目动态、技术进展、价格、人物状态）加上：

```yaml
---
type: concept
title: Mixture-of-Experts
refresh-enabled: true
refresh-interval-days: 7
refresh-queries:                  # 可选；不填 LLM 自动生成
  - "MoE benchmarks 2026"
---
```

然后 **设置 → 定时联网刷新** 打开「启用后台调度器」。

后台会：
1. 每 N 天用配置的搜索 provider 抓最新结果
2. 让 LLM 比对当前页面 vs 新结果
3. 检测到过时 → 在审核队列产生一条 **suggestion**，附摘要
4. 写回 `refresh-last-refreshed` 时间戳

**单页面立即刷新**：编辑器打开页面，frontmatter 上方有 *联网刷新* 行 + 旋转按钮。

**已知限制**：
- 必须先配 Web Search provider
- LLM 调用要钱，默认间隔建议 ≥ 7 天
- 仅生成建议，**不**自动改写正文（你审核后再决定）

详见 [`features.md §2`](features.md#2-页面级定时联网刷新)。

### 5.3 本地 / 共享配置分离（云盘友好）

原本 `.llm-wiki/` 既存项目共享元数据又存私密聊天，云盘共享易冲突 / 泄露。

现在拆为：

| 目录 | 内容 | 云盘 |
|---|---|---|
| `.llm-wiki/` | ingest 缓存、审核队列、页面历史 | **同步** |
| `.llm-wiki-local/` | 聊天对话、conversations | **必须排除** |

API Key 一直在系统应用数据目录，**不在项目目录里**，所以同步项目从不会泄露 Key。

旧用户首次启动自动迁移老的 chat 文件，无需操作。

各云盘排除 `.llm-wiki-local/` 的具体命令见 [`cloud-sharing.md`](cloud-sharing.md)。

### 5.4 智能拆分 + 综合 schema（34 类，中文目录）

**入口：新建项目自动用综合模板 / 存量项目用 设置 → Schema 升级**

**解决了什么问题**：上游原版把每份资料都按"实体 / 概念"硬拆——导入一份旅游方案会散成 20 个景点页，导入一本书会散成 50 个人物页。这次 fork 把分类从代码硬编码改为**完全由 `schema.md` 决定**，并新增「综合」模板（34 类、中文优先目录）覆盖日常文档场景。

**两种行为模式**（LLM 摄入时自动判断）：

| 模式 | 行为 | 适用类型 |
|---|---|---|
| **单页模式** | 一份源文档 → 一份 wiki 页，不拆 | 旅游方案、用户手册、项目文档、教程、书籍、食谱、笔记、报告、文章、会议、决策、项目、影视、音乐、游戏、菜单、购物清单、健身计划、合同、发票、医疗记录、保险单、代码片段、API 文档、错误日志 |
| **可拆分模式** | 源摘要 + 概念 / 工具 / 人物子页 | 论文、概念、工具、数据集、人物、公司、法规 |

**新建项目** → 综合模板自动作为默认（也可在 §3 步骤 2 切到其他模板）。

**存量项目**（已经在用 6 类旧 schema）：
1. **设置 → Schema 升级**（左侧导航的 ✨ 图标）
2. 一键操作：
   - 备份当前 `schema.md` → `schema.md.bak-YYYY-MM-DD`
   - 写入综合 schema（按 UI 语言选 zh / en）
   - 预创建 34 个分类目录
3. **不会**自动移动旧的 `wiki/entities/` `wiki/concepts/` `wiki/sources/` 下的页面 —— 它们保留原位，**新导入**才用新目录。如想迁旧页：删除导入缓存后重新导入源文件。

**自定义分类**：综合 schema 只是默认起点，不固定。直接改 `schema.md` 的 Page Types 表（加新行 / 改目录 / 改用途说明），LLM 下次导入按新规则。详见 [`user-rules.md`](user-rules.md)。

**中文目录的 Git 配置**（一次性）：
```bash
git config --global core.quotepath false  # 让 Windows git status 正常显示中文
```

详见 [`features.md §5`](features.md#5-智能拆分--splitting-rules综合-schema--单页类型)。

### 5.5 自动更新（就地）+ 加密配置备份

**入口：顶部横幅 / 设置 → 关于（更新）；设置 → 配置备份（备份）**

更新源已指向你自己的 GitHub（`chunguangwei/LLMWiKi`），并升级为**真正的就地更新**——不再卸载重装，配置和 Key 天然保留。

**怎么更新**：
- app 启动后台检查；有新版时顶部出现横幅，或在 设置 → 关于 看到「立即更新」。
- 点「立即更新」→ 自动下载 + 验签 + 就地替换 → 点「重启以应用」。**配置、API Key 全程不动。**
- 「手动下载」按钮作兜底。

**怎么发布新版本**（你自己改完代码后，让所有设备能更新）：
1. 改 `app/package.json` 和 `app/src-tauri/tauri.conf.json` 的 `version`（两处一致）。
2. `git push origin main`，然后打 tag：`git tag v0.4.13 && git push origin v0.4.13`。
3. GitHub Actions 自动构建 + 签名 + 出 release。各设备下次启动即可更新。
> 详细发版步骤 + 必备 GitHub Secret 见 [`features.md §6.3`](features.md#63-发版流程你怎么发布新版本让所有端更新)。
> ⚠️ 务必备份 `~/.tauri/llmwiki_updater.key` 和 `.password`——私钥丢了就再也签不了新版本。

**配置备份（防丢 Key）**：设置 → 配置备份
- **导出 / 导入**（换机器用）：设一个口令 → 导出成加密文件 `.llmwiki-config`；新机器输同一口令导入。用 Argon2id + AES-256-GCM 加密，**口令是唯一解钥**。
- **自动备份**（同机重装用）：每次启动自动加密备份到 `~/Documents/LLMWiki/`，密钥存系统钥匙串；重装后自动恢复，无需操作。

详见 [`features.md §6`](features.md#6-自己-github-自动更新就地更新--加密配置备份)。

---

## 6. 自定义分类 / 规则 / 格式（用户规则）

LLMWiki 默认带 **34 种**页面类型（综合模板，覆盖日常生活 + 工作 + 研究）。如果您要做特定领域（学术研究、技术文档、读书笔记、产品分析等），可以**完全自定义**页面分类、命名约定、frontmatter 字段、AI 输出风格。

**所有自定义入口** ——

| 在哪里 | 改什么 | 影响范围 |
|---|---|---|
| `schema.md`（项目根） | 页面类型、命名、frontmatter 字段、工作流 | LLM 每次操作前必读，最关键 |
| `purpose.md`（项目根） | 项目目标、核心问题、研究边界 | 给 LLM 提供「为什么做这个 wiki」的语境 |
| 设置 → LLM 模型 | provider / 模型 / 温度 / reasoning | 全局 |
| 设置 → 输出偏好 → AI 输出语言 | 强制 AI 用某种语言回答 / 写页面 | 全局 |
| 设置 → 网页搜索 | provider + 可选定向限定 | 全局 |
| 每页 frontmatter | 该页的 type、tags、刷新策略 | 单页 |

详细做法 + 10+ 分类示例模板 → [`user-rules.md`](user-rules.md)

---

## 7. 团队 / 多端协作

简版：把项目目录放云盘共享，排除 `.llm-wiki-local/`，约定单人轮流写入。详见 [`cloud-sharing.md`](cloud-sharing.md)。

不愿一直挂云盘的话用 `.llmwiki` 包：导出 → 传给同事 → 同事导入。

---

## 8. 高级技巧

### 8.1 Obsidian 兼容

`wiki/` 目录直接就是合法的 Obsidian vault：项目创建时已自动生成 `.obsidian/` 配置。打开 Obsidian → Open vault → 选项目根 → 用 Obsidian 浏览图谱 / 编辑页面，LLMWiki 会自动检测到外部修改并同步。

### 8.2 Chrome 网页剪藏

`app/extension/` 是一个 Chrome 扩展：
1. 打开 `chrome://extensions`
2. 启用开发者模式
3. 加载已解压扩展 → 选 `app/extension/`
4. 之后任何网页点工具栏图标，一键剪藏到当前 LLMWiki 项目的 `raw/sources/`

### 8.3 命令行批量处理

应用启动时会在后台开一个本地 HTTP 服务（Clip Server）。可以脚本化提交 URL 让 LLMWiki 自动摄入，详见上游 README 的 Clip Server 段。

### 8.4 手动调 wiki 页面

`wiki/*.md` 都是普通 markdown 文件，你可以直接编辑（在 LLMWiki 里、Obsidian 里、或任何编辑器里）。下次 LLM 工作时会基于你的修改继续。

---

## 9. 故障排查速查

| 现象 | 处理 |
|---|---|
| Mac 启动提示「已损坏」 | `xattr -dr com.apple.quarantine "/Applications/LLM Wiki.app"` |
| 摄入卡住 | 设置 → LLM 模型 点 Test；右下角进度查 review 面板 |
| 中文翻译有遗漏 | 你正在用的版本可能滞后；新版 fork 已补全所有新 section 翻译 |
| 导入的资料被拆成几十个小页 | 你的项目还在用旧 schema（6 类硬拆）；走 **设置 → Schema 升级** 切到综合 schema |
| Windows `git status` 显示 `\346\227\205...` 等转义 | 中文目录名被 git 转义，跑 `git config --global core.quotepath false` 一次即可 |
| 定时刷新不触发 | 先在 设置 → 网页搜索 配 provider；检查 frontmatter `refresh-enabled: true` 拼写 |
| 云盘出现 .json (Conflict) 文件 | 多人同时写了项目；约定单写主，或换 Git 模式 |
| API Key 找不到 | 它存在 OS 应用数据目录，不在项目里：macOS `~/Library/Application Support/com.llmwiki.app/app-state.json` |
| 想清空所有 LLM 缓存 | 删除项目根的 `.llm-wiki/` 子目录，应用会自动重建 |
| 重装后配置 / Key 没了 | 正常会自动从加密备份恢复；若没恢复，确认 `~/Documents/LLMWiki/config-backup.enc` 在、系统钥匙串密钥在。换机器要用 设置 → 配置备份 的口令导出/导入 |
| 「立即更新」失败 | dev 模式无更新产物（用手动下载）；或 release 缺 `latest.json`/签名；macOS 未签名被 Gatekeeper 拦时跑 `xattr -dr com.apple.quarantine` |
| 别用深度卸载工具 | AppCleaner 等会删 `~/Library/Application Support/com.llmwiki.app/` 导致配置丢失。就地更新不需要卸载；真要卸载先在 设置 → 配置备份 导出一份 |

---

## 10. 文档地图

| 文档 | 内容 |
|---|---|
| [`README.md`](../README.md) | 顶层入口、30 秒上手 |
| [`docs/user-manual.md`](user-manual.md) | **当前文件**（用户日常使用） |
| [`docs/getting-started.md`](getting-started.md) | 详细安装、目录结构、打包矩阵 |
| [`docs/features.md`](features.md) | 新功能的详细技术文档 |
| [`docs/user-rules.md`](user-rules.md) | **自定义分类 / 规则 / 格式（schema.md + Settings 全攻略）** |
| [`docs/cloud-sharing.md`](cloud-sharing.md) | 团队 / 多端云盘部署 |
| [`UPSTREAM.md`](../UPSTREAM.md) | fork 元信息、与 upstream sync 工作流 |
| [`app/README_CN.md`](../app/README_CN.md) | upstream 完整功能列表（含我们追加的 §19/20/21） |
