# LLMWiki 新功能详细用法

LLMWiki 在 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 的基础上新增了若干能力。本文档讲它们各自的使用方式、配置项与已知限制。

| § | 功能 |
|---|---|
| 1 | `.llmwiki` 导入/导出包 |
| 2 | 页面级定时联网刷新 |
| 3 | 本地 / 共享状态分离 |
| 4 | **中文 i18n 补全 + 一键切换语言** |
| 5 | **智能拆分 / Splitting Rules（综合 schema + 单页类型）** |
| 6 | **自己 GitHub 自动更新（就地更新）+ 加密配置备份** |

> 想要自定义分类、规则、格式要求？看 [`user-rules.md`](user-rules.md)（schema.md + purpose.md + Settings）。

---

## 1. `.llmwiki` 导入/导出包

### 是什么

把整个项目（源文档 + LLM 写的 wiki + 项目元数据）打成一个 zip 格式的 `.llmwiki` 文件，便于：
- 在 Mac 和 Win 之间迁移项目
- 给团队同事一份完整快照
- 做备份 / 版本归档

### 入口

**设置 → 导入 / 导出**

### 导出步骤

1. 打开您要导出的项目
2. *Export* 段：
   - 可选：填「Your name」（写入 manifest，便于团队溯源）
   - 可选：勾选「Include page history」（包含 `.llm-wiki/page-history/`，体积大但能保留每页历史快照）
3. 点 *Export package* → 选保存位置 → 生成 `.llmwiki` 文件

包结构：
```
my-wiki.llmwiki
├── manifest.json          # schema 版本 / app 版本 / 所有文件的 SHA256
├── raw/                   # 原始源文档（不变）
├── wiki/                  # LLM 生成的 wiki 页面
└── shared/                # .llm-wiki/ 内容（ingest cache / review queue …）
                           # 注意：不含 chats / conversations.json
```

### 导入步骤

1. *Import* 段，选择策略：
   - **Skip existing files**（默认安全）：目标已存在的文件跳过
   - **Overwrite everything**：全部覆盖
2. 点 *Import .llmwiki* → 选 `.llmwiki` 文件 → 选目标目录 → 自动解包并校验 SHA256
3. 导入成功后会显示 `Imported X files (skipped Y, mismatches Z)`

**Inspect package**（导入前预览）：只读出 manifest 元信息（项目名、导出时间、文件数、app 版本），不解包文件。

### 校验

manifest 内每个文件都带 SHA256。导入时会逐文件比对：
- 校验通过：正常写入
- 不一致：`checksum_mismatches` 列出，文件仍会写入（让用户决定如何处理）。包传输如果走过云盘或邮件附件，理论上不会改字节；若出现 mismatch，建议重新导出。

### 什么 *不* 会被打包

- `.llm-wiki-local/`（聊天记录，私密）
- 用户配置（API Key 等，存在 OS 应用数据目录）
- 向量索引数据库（`.lancedb`），导入后重新生成
- `page-history/`（除非勾选）

### 常见用法

**多端同步**：在 Mac 上 export → AirDrop / 邮件 / U 盘 → Win 上 import 到任意目录 → 打开

**团队首次分发**：项目 owner export → 共享盘 / Slack → 同事 import → 各自配自己的 LLM key

**周度归档**：每周末 export 一个带日期的快照存档

---

## 2. 页面级定时联网刷新

### 是什么

为某些「会过时」的 wiki 页面（项目动态、技术进展、人物状态）打上「定时刷新」标记。后台调度器会：
1. 每隔 N 天用配置的搜索 provider 抓最新结果
2. 让 LLM 比对当前页面 vs 新结果，判定是否过时
3. 过时则在 Review 队列里推一条 *Suggestion*，给您一句话总结改了什么
4. 不过时则只更新 `refresh-last-refreshed` 时间戳

### 入口

- **设置 → 定时联网刷新**（全局开关 + 检查频率）
- **编辑器内**：任何页面 frontmatter 里加 `refresh-enabled: true` 后，重新打开页面，frontmatter 上方会出现 *Web refresh* 行 + Refresh 按钮

### 给页面打标记

编辑页面 frontmatter，加这几行（flat key，平铺到 YAML 顶层）：

```yaml
---
type: concept
title: Mixture-of-Experts
refresh-enabled: true              # 必填
refresh-interval-days: 7           # 默认 7，可填 1~365
refresh-queries:                   # 可选；不填则 LLM 自动从标题生成
  - "mixture of experts 2026"
  - "MoE benchmarks recent"
---
```

刷新跑完后自动追加：

```yaml
refresh-last-refreshed: "2026-05-18T03:00:00Z"
refresh-last-result: ok | no-change | pending-review | error
```

### 全局调度器设置

**设置 → 定时联网刷新**：

- **Enable background scheduler**：总开关
- **Check interval (minutes)**：调度器多久扫一次所有页面（默认 30 分钟）。比页面的 `refresh-interval-days` 频率更频繁不会让单页面更快刷新，但扫描密度更高。
- **Refresh due pages**：跳过调度器立即把所有到期页面跑一遍

### 状态字段

- `refresh-last-result: ok` — 已确认有变化并保存（保留以备扩展，目前与 pending-review 等价）
- `refresh-last-result: no-change` — LLM 判断页面仍新鲜
- `refresh-last-result: pending-review` — 检测到陈旧，建议已进 Review 队列
- `refresh-last-result: error` — 失败（如搜索 API 报错、LLM 超时）。调度器下次到期会重试

### 已知限制

- **依赖 Web Search**：必须先在 **设置 → Web Search** 配 provider，否则 *Enable* 开关不可用
- **不自动修改页面正文**：检测到陈旧后，只生成 Review suggestion，不改正文。「自动改写正文」未来可能加，但默认行为更稳妥
- **LLM 成本**：每个到期页面 = 1 次搜索 + 1 次 LLM 调用。10 个页面 7 天刷一次 ≈ 月 ~40 次。注意账单
- **检测启发式**：LLM 用一个 STATUS=fresh/stale 的判定 prompt，并不完美。极少数情况下可能漏判或误判，您可以在 Review 队列里手动 dismiss

### 推荐使用场景

| 适合刷新 | 不适合刷新 |
|---|---|
| 项目状态页（动态更新中的产品/团队） | 历史事件 |
| 技术 / benchmark 页 | 经典定义 |
| 人物 / 公司当前职位 | 数学定理 |
| 工具版本号 / 价格 | 已出版书籍内容 |

---

## 3. 本地 / 共享状态分离

### 是什么

项目目录下原本只有 `.llm-wiki/`，里面既有项目共享的元数据（ingest 缓存、审核队列），也有用户私密的聊天记录。这让云盘共享和团队协作很尴尬。

现在拆成两个隐藏目录：

| 目录 | 内容 | 是否同步 |
|---|---|---|
| `.llm-wiki/` | 项目共享：ingest cache、review queue、page history、project.json | **应该同步** |
| `.llm-wiki-local/` | 个人私密：聊天对话、conversations 列表 | **必须排除** |

API Key 与 LLM provider 配置一直在 OS 应用数据目录（macOS: `~/Library/Application Support/com.llm-wiki.app/`；Windows: `%APPDATA%\com.llm-wiki.app\`），**完全不在项目目录里**。

### 自动迁移

旧版本用户：第一次启动新版时，`.llm-wiki/chats/` 和 `.llm-wiki/conversations.json` 会被自动搬到 `.llm-wiki-local/`，无需手动操作。

### 部署细节

详见 [cloud-sharing.md](cloud-sharing.md)，包含各云盘排除 `.llm-wiki-local/` 的具体命令。

---

---

## 4. 中文 i18n 补全 + 一键切换语言

### 是什么

- **补全**：上游 i18n parity 已绿，但本 fork 新增的三个 UI 段（`importExport`、`scheduledRefresh`、`editor.refresh`）原本只走英文 `defaultValue`，中文用户看到的是英文。现在 `en.json` / `zh.json` 全部对齐，中文用户在新功能区域看到的全是中文。
- **一键切换**：上游切语言需要点完按钮再点底部「保存」。本 fork 在 *设置 → 界面 → UI 语言* 点击「中文」/「English」按钮**立刻 `i18n.changeLanguage()` + 持久化**，所有 `useTranslation()` 的组件即刻重渲染，不必再点保存。

### 入口

**设置 → 界面 → UI 语言**

### 工作原理

`react-i18next` 的 `useTranslation()` hook 订阅 `i18n` 的 language 变更事件。`interface-section.tsx` 在 onClick 里同时做三件事：

```typescript
setDraft("uiLanguage", value)        // 写入草稿（让 Save bar 不会回滚）
await i18n.changeLanguage(value)     // 立刻广播给全应用
await saveLanguage(value)            // 写 Tauri Store 持久化
```

### 加新语言

1. 复制 `app/src/i18n/en.json` 为 `app/src/i18n/<lang>.json`，翻译所有 value
2. 在 `app/src/i18n/index.ts` 的 `resources` 中注册
3. 在 `interface-section.tsx` 的 `UI_LANGUAGES` 数组中加一条
4. 跑 `npm run test:mocks src/i18n/i18n-parity.test.ts` 确认键对齐

i18n parity 测试会强制所有语言文件的键集合完全相同——少一个键 CI 就红。

---

## 5. 智能拆分 / Splitting Rules（综合 schema + 单页类型）

### 解决了什么问题

上游 `nashsu/llm_wiki` 的摄入流程**硬编码**了 3 个目录（`wiki/entities/` + `wiki/concepts/` + `wiki/sources/`），并强制把每个识别出的"实体"和"概念"拆成独立页面。这套设计来自 Karpathy 原始 LLM Wiki 范式，**适合科研论文**，但用户实际导入的资料还包括：

- 旅游方案、攻略、游记
- 用户手册、产品文档
- 项目文档（README、设计文档、规格）
- 教程、课程笔记
- 整本书、整本电子书
- 食谱、菜单、购物清单
- 合同、发票、医疗记录、保险单
- 代码片段、API 文档、错误日志
- ...

这些文档**本质是单一连贯的工作流或叙事**，不应该被强拆成几十个 stub 页面。上游代码不区分场景，全部按"实体 / 概念"硬拆，导致用户的旅游方案散成 20 个景点页、用户手册散成 50 个按钮页。

### 这次怎么改

#### 5.1 新「综合」schema 模板（34 个目录）

`templates.ts` 新增 `comprehensive` 模板，作为新建项目时的**默认推荐**。它把页面类型分成三类：

| 类型 | 行为 | 示例分类 |
|---|---|---|
| **单页模式**（25 个）| 一份源文档 = 一个 wiki 页，**不拆** | 旅游方案、用户手册、项目文档、教程、书籍、食谱、笔记、报告、文章、会议、决策、项目、影视、音乐、游戏、菜单、购物清单、健身计划、合同、发票、医疗记录、保险单、代码片段、API 文档、错误日志 |
| **可拆分**（7 个）| 源摘要 + 概念 / 工具 / 人物子页 | 论文、概念、工具、数据集、人物、公司、法规 |
| **元数据**（2 个）| 项目级单例 | 综合、索引（含 wiki/overview.md / index.md / log.md） |

#### 5.2 双语目录名

- **中文 UI 创建项目** → 目录名直接用中文：`wiki/旅游方案/`、`wiki/用户手册/`、`wiki/合同/` …
- **English UI** → ASCII slug：`wiki/travel-plans/`、`wiki/manuals/`、`wiki/contracts/` …

schema 语言在项目创建时确定，之后改 UI 语言不会影响目录命名（避免孤儿页面）。

#### 5.3 Splitting Rules 写进 LLM 提示词

`buildAnalysisPrompt` 新增 **Document Type 判断**：分析阶段第一行必须输出 `Document Type: <type> — <reason>`，分类标准就是 5.1 的三类清单。

`buildGenerationPrompt` 删掉硬编码的 entities/concepts 目录，替换为：
- 「按 schema 的 Page Types 表走」——schema.md 才是分类真理
- 「Splitting Rules」段：明确告知 LLM 哪些类型整篇保留、哪些拆分
- 「拿不准 → 单页」——bias 倾向不拆，避免过度碎片化

源摘要 fallback（`ingest.ts` 约 line 642）放宽：不再硬要求 `wiki/sources/<basename>.md`，而是接受**任何 wiki 子目录下与源文件同名的页面**作为源摘要。

#### 5.4 存量项目一键升级

设置面板新增 **Schema 升级** section（左侧导航的「Schema 升级」/「Schema Upgrade」）：

1. 检测当前 `schema.md` 是否已是新综合模板
2. 一键操作：
   - 备份当前 schema.md → `schema.md.bak-YYYY-MM-DD`
   - 写入综合模板（按 UI 语言自动选 zh / en 版）
   - 预创建 34 个分类目录
3. **不会**自动移动已有 wiki 页——旧的 `wiki/entities/` `wiki/concepts/` `wiki/sources/` 保留原位，新导入路由到新目录

如果想把旧页面也迁到新目录：删除导入缓存（设置 → 维护）后重新导入源文件。

### 中文目录名的实操注意

- macOS / Linux / Windows 三大文件系统均原生支持 Unicode 文件名，无需特别处理
- Git 默认配置下 Windows 终端会显示转义码（`\346\227\205...`）。一次性设置：
  ```bash
  git config --global core.quotepath false
  ```
- iCloud / OneDrive / 群晖 / 飞牛等云盘 / NAS 都支持中文路径同步

### 自定义类型

新「综合」schema 是默认起点，**不是 fixed**。改 `schema.md` 的 Page Types 表（加新行 / 改目录 / 改用途说明）后，LLM 下次导入就按新规则路由。**建议**：

1. 在「单页模式」段加新分类时，**目录名 + 用途** + 一句说明（如「整篇保留」）
2. 在「可拆分」段加新分类时，要清楚拆出来的子页放进哪个已有目录
3. 改完保存即生效，不必重启

详细 schema 编辑指南见 [`user-rules.md`](user-rules.md)。

---

## 6. 自己 GitHub 自动更新（就地更新）+ 加密配置备份

### 6.1 解决了什么问题

- 上游原版只有「检查 + 通知」：检测到新版本只能打开 GitHub 下载页**手动重装**，且更新源写死在 `nashsu/llm_wiki`。
- 手动重装有副作用：用深度卸载工具（AppCleaner 等）会连带删掉 `~/Library/Application Support/com.llmwiki.app/app-state.json`，**所有配置和 API Key 丢失**。

这次改成：**指向你自己的 GitHub 仓库（`chunguangwei/LLMWiKi`）+ 真正的就地更新 + 加密配置备份**。就地更新不卸载不重装，配置目录从不被动，天然保留。

### 6.2 自动更新（in-place）

- 基于 `tauri-plugin-updater`。app 启动后台检查 → 检测到新版本 → 顶部横幅 / 设置 → 关于 出现「立即更新」。
- 点「立即更新」→ 下载你 GitHub release 里的签名产物 → 验签 → **就地替换** → 「重启以应用」。全程不动配置目录。
- 更新源：`https://github.com/chunguangwei/LLMWiKi/releases/latest/download/latest.json`（`tauri.conf.json` 的 `plugins.updater.endpoints`）。
- 安全：每个 release 产物用 **minisign 私钥**签名，app 内置**公钥**验签，签名不符拒绝安装。私钥只存在你的 GitHub Actions secret 里。
- 「手动下载」按钮始终保留作为兜底（dev 构建无 updater 产物、或就地替换被 Gatekeeper 拦时可用）。

> **仓库必须 Public**：updater 公开抓取 `latest.json`，私有仓库的 release 需要 token，而 token 不能塞进 app。

### 6.3 发版流程（你怎么发布新版本让所有端更新）

1. 本地改完代码，`cd app`，提升版本号：改 `package.json` 的 `version` 和 `src-tauri/tauri.conf.json` 的 `version`（两处保持一致，如 `0.6.4`）。
2. 提交并推送：`git push origin main`。
3. 打 tag 触发 CI：
   ```bash
   git tag v0.6.4
   git push origin v0.6.4
   ```
4. GitHub Actions（`.github/workflows/build.yml`）自动：跨平台构建 → 用签名密钥签 updater 产物 → 生成 `latest.json` → 创建 GitHub Release 并上传 dmg/exe/AppImage + `latest.json` + `.sig`。
5. 各台已安装的 app 在下次启动（或手动「检查更新」）时发现新版，一键就地更新。

**所需 GitHub Secrets**（已配好，列出供参考 / 换机重配）：

| Secret | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/llmwiki_updater.key` 文件内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码（存于 `~/.tauri/llmwiki_updater.password`）|

> ⚠️ **务必备份这两个文件**（`~/.tauri/llmwiki_updater.key` 和 `.password`）。私钥丢了就无法再签新版本，所有端的自动更新会失效（验签不过）。建议复制到密码管理器或离线备份。

### 6.4 加密配置备份（防丢 Key）

两条独立路径，**app 二进制里不含任何密钥**，反编译拿不到明文：

**A. 手动导出 / 导入（跨机器迁移）—— 口令加密**
入口：**设置 → 配置备份**
- 导出：设一个 ≥8 位口令 → 选保存位置 → 生成 `.llmwiki-config` 文件。该文件用 `Argon2id` 从口令派生密钥 + `AES-256-GCM` 加密，含 salt/nonce/密文，**不含密钥**。
- 导入：输入同一口令 → 选文件 → 解密写回 → 提示重启生效。
- 加解密全在 Rust 侧完成，明文配置绝不以未加密形式落盘。安全性 = 你的口令强度。
- 适合：换新电脑、给另一台机器搬配置。

**B. 启动自动备份（同机重装恢复）—— 钥匙串托管**
- 每次启动自动把 `app-state.json` 加密写到 `~/Documents/LLMWiki/config-backup.enc`（在 app-data 之外，深度卸载删不掉）。
- 加密密钥是随机 256-bit，存在 **macOS 钥匙串 / Windows 凭据管理器**里（`keyring`）。钥匙串不随 app 卸载删除。
- 重装后检测到配置为空 → 用钥匙串密钥自动解密恢复，**无需口令、无需操作**。
- 设置 → 配置备份 里能看「上次备份时间」+「立即备份」按钮。

> 分工：**同机重装** 靠 B 自动恢复；**换机器迁移** 靠 A 口令导入（钥匙串是机器本地的，跨不了机）。
>
> ⚠️ 安全提示：导出文件含 API Key（加密）。同时拿到「文件 + 口令」的人才能读取——两者都要妥善保管。

### 6.5 配置目录锁定

- bundle identifier 锁死在 `com.llmwiki.app`（自 0.4.10）。它决定配置目录路径 + 钥匙串服务名。**永不更改**（代码 `lib.rs` 顶部 + 本节都有注释警告），否则会孤立所有用户配置。
- 仍**不建议**用深度卸载工具；即使误删，自动备份（6.4 B）也能在重装后恢复。

详细技术实现见 `app/src-tauri/src/commands/config_crypto.rs`、`config_backup.rs`、`src/lib/updater.ts`。

---

## 7. GitHub 版本化备份与多设备同步

把整个 wiki 项目持续备份到你自己的 GitHub 私有仓库,支持**按版本恢复**和**多设备同步**——是 [cloud-sharing.md](cloud-sharing.md) 里「Git 模式」升级路径的产品化。设置入口:**设置 → GitHub 备份**。

### 7.1 解决了什么问题
- 即时、版本化地把 wiki 存到 GitHub,任何一次提交都能回滚。
- 多台电脑用同一配置时,A 改完上传、B 端定时/启动/聚焦时自动拉取并实时刷新界面。

### 7.2 工作方式
- **技术路线**:走 **GitHub REST(Git Data API)**——blobs/trees/commits/refs,不内置 libgit2、不引入任何 C 依赖,因此对跨平台构建零风险(复用现有 `reqwest`)。代价是项目目录里没有本地 `.git`(也更干净)。
- **认证(对小白友好的引导式)**:用 **Personal Access Token**。设置区是两步引导:① 点「打开 GitHub 创建令牌」会跳到 GitHub 已**预选好 `repo` 权限**的建 token 页,用户只需下滑点绿色 Generate、复制;② 粘贴回来点「连接」即时校验并显示「已连接为 <用户名>」。Token 存 OS 钥匙串(`com.llmwiki.app` / `github-pat`),从不进项目目录或二进制。
- **备份范围**:默认含 `raw/sources` 原始资料(可在设置里关闭)。始终排除 `.llm-wiki-local/`(每台机器私有)、`raw/sources/.cache/`、`.DS_Store`。单文件 > 50MB 会被跳过并提示(GitHub 单文件上限 100MB)。
- **冲突**:多设备改了同一文件时按「最新修改优先」自动合并(本地 mtime vs 远端提交时间)。
- **触发**:按你设的周期自动备份(上传前先拉取合并);启动 + 窗口重新聚焦时拉取;另有「立即备份 / 立即拉取」手动按钮。
- **恢复**:在版本列表里选一个提交点 → 还原,把该快照写回本地并刷新界面。

### 7.3 配置存放
- 每项目、每设备的备份配置(仓库、周期、范围、`lastSyncSha`)存 `.llm-wiki-local/github-backup.json`(本身不被备份)。

详细技术实现见 `app/src-tauri/src/commands/github_backup.rs`、`src/lib/github-backup.ts`、`src/components/settings/sections/github-backup-section.tsx`。

---

## 故障排查

### `.llmwiki` 导入提示 "Package missing manifest.json"
您选的文件不是 LLMWiki 导出的包，或者包损坏。重新导出。

### 「定时联网刷新」始终不触发
- 确认 **设置 → Web Search** 配了 provider 且 API Key 有效
- 确认页面 frontmatter 里 `refresh-enabled: true` 拼写正确（必须严格相同的连字符 key）
- 用 *Refresh due pages* 立刻触发一次，看错误提示
- 打开 DevTools（macOS：右键应用窗口 → Inspect）看 console 错误

### 多人云盘协作产生 `.json (Conflict)` 文件
LLMWiki 没有内置写锁。约定单人写，或使用 Git 协作模式（详见 cloud-sharing.md）。

### Mac 提示「LLM Wiki 已损坏」
未签名 dmg 的常见 Gatekeeper 拦截。在 Terminal 跑：
```bash
xattr -dr com.apple.quarantine "/Applications/LLM Wiki.app"
```

### 「立即更新」失败 / 不就地更新
- dev 模式（`npm run tauri dev`）没有 updater 产物，必然失败——用「手动下载」按钮。
- 检查你的 GitHub release 里有没有 `latest.json` 和 `.sig` 文件；没有 = CI 没配签名 secret（见 §6.3）。
- macOS 未签名 app 就地替换后可能被 Gatekeeper 拦，跑一次上面的 `xattr` 命令。
- 验签失败 = app 内置公钥与签名私钥不匹配（换过密钥但没重新构建 app）。

### 自动更新检测不到新版本
- updater 比对的是 release 的版本号。确认你 push tag 时 `package.json` + `tauri.conf.json` 的 `version` 已提升。
- 仓库必须是 Public，否则 `latest.json` 无法公开抓取。

### 重装后配置 / Key 没了
- 正常情况自动备份（§6.4 B）会在重装后自动恢复。若没恢复：确认 `~/Documents/LLMWiki/config-backup.enc` 还在，且系统钥匙串里的密钥还在（换了机器就跨不过来——用 §6.4 A 的口令导入）。
- 换新机器：在旧机用「设置 → 配置备份 → 导出」，新机「导入」+ 输口令。
