# 用户规则：分类、格式、AI 行为的全部自定义入口

LLMWiki 不是「定死的应用」—— 几乎所有 AI 行为都受您能自己编辑的文件 / 设置控制。本文是一份地图：**想改什么 → 改哪里**。

---

## 0. 一图概览

```
┌─────────────────────────── 全局（影响所有项目） ────────────────────────────┐
│ 设置 → LLM 模型         provider / 模型 / 温度 / reasoning 选项              │
│ 设置 → 输出偏好         AI 输出语言（强制 zh / en / auto）、对话历史长度      │
│ 设置 → 嵌入向量         检索增强 provider                                    │
│ 设置 → 网页搜索         deep research / 联网刷新走哪个 provider               │
│ 设置 → 多模态           图片描述用什么 vision 模型                            │
│ 设置 → 界面             UI 语言（中 / English），主题等                       │
└──────────────────────────────────────────────────────────────────────────┘

┌────────────────────── 项目级（每个 wiki 项目独立） ──────────────────────┐
│ ★ schema.md             页面分类、命名约定、frontmatter 字段、工作流规则    │
│ ★ purpose.md            项目目标、核心问题、研究范围 (LLM 写每页时都参考)   │
│   wiki/index.md         内容目录（LLM 自动维护，您也可手动加章节）          │
│   wiki/log.md           操作日志（LLM append-only）                       │
└─────────────────────────────────────────────────────────────────────────┘

┌────────────────────── 页面级（每个 wiki 页面独立） ──────────────────────┐
│   YAML frontmatter      type / tags / related / 自定义字段 / 刷新策略     │
└─────────────────────────────────────────────────────────────────────────┘
```

**最最关键的两个文件：`schema.md` 和 `purpose.md`**。LLM 在摄入文档、回答问题、写新页面前，都会读这两个文件。您改它们 → LLM 立刻按新规则做事。

---

## 1. schema.md：分类、命名、frontmatter、规则

### 1.1 默认内容

新建项目时，LLMWiki 在项目根自动生成一份 `schema.md`。**默认使用「综合」模板，定义 34 种页面类型**，覆盖日常生活、工作、研究三类场景：

- **25 个「单页模式」分类**——整篇资料保留为一页：旅游方案、用户手册、项目文档、教程、书籍、食谱、笔记、报告、文章、会议、决策、项目、影视、音乐、游戏、菜单、购物清单、健身计划、合同、发票、医疗记录、保险单、代码片段、API 文档、错误日志
- **7 个「可拆分」分类**——源摘要 + 概念 / 工具 / 人物子页：论文、概念、工具、数据集、人物、公司、法规
- **2 个元数据分类**：综合（跨主题分析）、索引（wiki/index.md 等单例）

中文 UI 创建项目时目录名直接是中文（`wiki/旅游方案/`、`wiki/书籍/`）；英文 UI 时是 ASCII slug（`wiki/travel-plans/`、`wiki/books/`）。完整模板见 [§2.0](#20-综合34-类推荐默认-)。

> **上游 / 旧版项目**仍是 6 类（entity / concept / source / query / comparison / synthesis）。如果你的项目是从老版本来的，可在**设置 → Schema 升级**一键切到新模板。详见 [`features.md §5`](features.md#5-智能拆分--splitting-rules综合-schema--单页类型)。

模板还包含命名约定、frontmatter 字段、log/index 格式、矛盾处理流程、**拆分规则**（哪些类型整篇保留、哪些可拆）。

### 1.2 怎么改

在 LLMWiki 应用里打开 `schema.md`（左侧 *项目文件* 面板顶部就能看到），或用任意编辑器打开。**改完保存即生效**——下次 LLM 操作时会读取新版本。

### 1.3 推荐做法

- **增加分类**就在表格里加一行 + 在 `wiki/` 下手动 `mkdir wiki/<新目录>/` 即可。注意标清楚是「单页模式」还是「可拆分」，LLM 会按标记决定要不要拆
- **删除某分类**直接从 schema.md 表格删掉就好，LLM 不会再往那里写。旧文件**不会自动消失**，自行清理
- **改命名约定**只要写清楚就行，LLM 会遵循
- **加 frontmatter 字段**（如 `priority`、`status`、`assignee`）写在 frontmatter 模板里
- **写「禁止做」规则**（如「不要给 entity 加 outline」、「source 摘要不超过 200 字」）直接以 bullet 列出，LLM 会照做

---

## 2. schema.md 模板示例（按场景）

下面是 5 个场景的完整 schema.md 替换模板。**新建项目默认使用 2.0「综合」模板**。直接复制粘贴即可。

### 2.0 综合（34 类，推荐默认）★

中文优先目录名。覆盖日常生活 + 工作 + 学习三大场景。**新项目自动用这份**；存量项目可在 **设置 → Schema 升级** 一键替换。

> 完整模板见 `app/src/lib/templates.ts` 里 `comprehensiveTemplate` 常量。或在应用里新建一个项目就能看到 schema.md 的实际内容。

**单页模式（25 类）—— 整篇保留，不拆分**：
旅游方案、用户手册、项目文档、教程、书籍、食谱、笔记、报告、文章、会议、决策、项目、影视、音乐、游戏、菜单、购物清单、健身计划、合同、发票、医疗记录、保险单、代码片段、API 文档、错误日志

**可拆分（7 类）—— 源摘要 + 子页**：
论文、概念、工具、数据集、人物、公司、法规

**元数据（2 类）**：综合、索引

完整路径示例（zh）：
- `wiki/旅游方案/东京三日游.md`
- `wiki/合同/2026-供应商A.md`
- `wiki/食谱/番茄牛腩.md`
- `wiki/代码片段/防抖-react.md`
- `wiki/论文/vaswani-2017-attention.md` + `wiki/概念/transformer.md`（多页）

英文 UI 用 ASCII：`wiki/travel-plans/`、`wiki/contracts/` …

### 2.1 学术研究（10 类）

```markdown
# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|---|---|---|
| paper | wiki/papers/ | 论文摘要（一篇一页） |
| author | wiki/authors/ | 作者主页（学术经历、代表作） |
| venue | wiki/venues/ | 会议 / 期刊（NeurIPS、ICML、Nature 等） |
| concept | wiki/concepts/ | 理论、方法、术语 |
| dataset | wiki/datasets/ | 基准数据集 |
| benchmark | wiki/benchmarks/ | 评测基准与排行榜 |
| experiment | wiki/experiments/ | 实验设计与结果 |
| critique | wiki/critiques/ | 对某篇论文 / 方法的批判性评论 |
| synthesis | wiki/synthesis/ | 跨论文综合（综述、状态调研） |
| open-question | wiki/open-questions/ | 文献中暴露但未解的问题 |

## Naming
- 论文：`firstAuthor-year-slug.md`（如 `vaswani-2017-attention.md`）
- 作者：`lastname-firstname.md`
- 概念：`英文 kebab-case`（数学符号写全名）

## Frontmatter (all pages)
```yaml
---
type: paper | author | venue | concept | dataset | benchmark | experiment | critique | synthesis | open-question
title: 标题
tags: [domain1, domain2]
related: [[link1]]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

## Paper-specific
```yaml
authors: [vaswani, shazeer, parmar]
year: 2017
venue: nips
arxiv: 1706.03762
citations: 100000
key_contribution: "Multi-head self-attention; positional encoding without RNN"
weakness: "O(n²) memory in sequence length"
```

## Rules
- 每篇 paper 摘要 ≤ 300 字
- 论文中提到的新概念必须有对应 concept 页（自动建）
- 实验数字必须可追溯到 paper 页面（用 `[[paper-slug]]` 引用）
- critique 必须 link 至少一篇 paper
```

### 2.2 个人 / 团队工作笔记（12 类）

```markdown
# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|---|---|---|
| project | wiki/projects/ | 项目主页（目标、状态、负责人） |
| person | wiki/people/ | 同事 / 合作伙伴 |
| meeting | wiki/meetings/ | 会议纪要 |
| decision | wiki/decisions/ | 决策记录（ADR 风格） |
| task | wiki/tasks/ | 待办（带 status） |
| process | wiki/processes/ | 流程 SOP |
| tool | wiki/tools/ | 内部工具 / 三方服务 |
| incident | wiki/incidents/ | 故障复盘 |
| lesson | wiki/lessons/ | 从经验中提炼的经验教训 |
| reference | wiki/references/ | 外部资料链接 + 摘要 |
| glossary | wiki/glossary/ | 团队内部术语词典 |
| retrospective | wiki/retrospectives/ | 项目/周期回顾 |

## Naming
- 项目：`proj-<short-name>.md`
- 会议：`YYYY-MM-DD-meeting-topic.md`
- 决策：`YYYY-MM-DD-decision-slug.md`

## Frontmatter
```yaml
---
type: project | person | meeting | decision | task | process | tool | incident | lesson | reference | glossary | retrospective
title: 标题
status: active | done | blocked | abandoned
owner: "@username"
participants: ["@a","@b"]
created: YYYY-MM-DD
updated: YYYY-MM-DD
related: [[link1]]
tags: []
---
```

## Rules
- meeting 必须有 participants
- decision 必须包含「替代方案 / 选择理由 / 影响」三段
- task 标 status: done 时必须 link 到产出物
- 不要在 wiki 里写敏感信息（薪资、客户数据、密码）—— LLM 已被警告，但人工抽查
```

### 2.3 读书笔记（10 类）

```markdown
# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|---|---|---|
| book | wiki/books/ | 书籍主页（一本一页） |
| chapter | wiki/chapters/ | 章节摘要 |
| character | wiki/characters/ | 人物（小说） |
| theme | wiki/themes/ | 主题 / 母题 |
| quote | wiki/quotes/ | 摘抄的金句 |
| concept | wiki/concepts/ | 书中的术语或思想 |
| author | wiki/authors/ | 作者信息 |
| review | wiki/reviews/ | 个人读后感 |
| comparison | wiki/comparisons/ | 跨书对比 |
| reading-log | wiki/reading-log/ | 阅读进度日志（一书一页） |

## Naming
- 书籍：`author-year-title-slug.md`
- 章节：`bookSlug-ch<N>-title.md`

## Frontmatter (books)
```yaml
---
type: book
title: 中文标题
title_original: 原文标题
authors: []
year: YYYY
genre: fiction | non-fiction | textbook | reference
status: reading | finished | abandoned | wishlist
rating: 1-5
started: YYYY-MM-DD
finished: YYYY-MM-DD
recommended_by: ""
---
```

## Rules
- quote 必须带页码或章节位置
- character 页只用「事实」+ 「象征意义」两段
- review 写在读完之后；中途想法用 reading-log
```

### 2.4 产品 / 竞品分析（12 类）

```markdown
# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|---|---|---|
| product | wiki/products/ | 我们或竞品的产品页 |
| company | wiki/companies/ | 公司 |
| feature | wiki/features/ | 功能模块 |
| market | wiki/markets/ | 细分市场 / 行业 |
| user-segment | wiki/user-segments/ | 用户画像 |
| pricing | wiki/pricing/ | 定价方案 |
| metric | wiki/metrics/ | KPI / 北极星指标 |
| campaign | wiki/campaigns/ | 营销活动 |
| feedback | wiki/feedback/ | 用户反馈合集 |
| roadmap | wiki/roadmap/ | 计划 |
| swot | wiki/swot/ | SWOT 分析 |
| postmortem | wiki/postmortems/ | 失败/成功复盘 |

## Frontmatter (products)
```yaml
---
type: product
title: 产品名
company: [[company-slug]]
launched: YYYY-MM-DD
status: live | beta | sunset
url: "https://..."
pricing_model: free | freemium | subscription | enterprise
target_segment: [[segment-slug]]
competitors: [[a]], [[b]]
key_strengths:
  - "..."
key_weaknesses:
  - "..."
last_reviewed: YYYY-MM-DD
---
```

## Rules
- 竞品 product 页每季度刷新一次（可结合「定时联网刷新」自动检测）
- pricing 页 frontmatter 加 `refresh-enabled: true` 自动月度抓取
- feedback 严禁包含用户 PII（电话、邮箱必须脱敏）
```

---

## 3. purpose.md：项目的「为什么」

LLM 在写每一页时会读这个文件作为「项目语境」。写得清楚 → LLM 输出风格、详略、视角都会贴近您的需求。

### 3.1 模板（直接复制）

```markdown
# Project Purpose

## Goal

用 1-3 句话说清楚这个项目存在的理由。例：「跟踪 2025 年 LLM 推理能力的演进，
为下一代 Agent 产品选型提供决策依据。」

## Audience

写给谁看？决定了 LLM 的语气。
- 我自己（私人笔记，可大量使用术语和缩写）
- 我们团队（5-10 人技术团队，假设读者懂行）
- 公司管理层（避免技术黑话，加上业务影响）
- 公开发布（写完整，避免内部代号）

## Key Questions

LLM 在写综述 / 概念页时会优先回答这些问题。

1. ?
2. ?
3. ?
4. ?
5. ?

## Scope

**在范围内：**
- ...

**不在范围内（即使资料里出现，也不要单独建页）：**
- ...

## Style Preferences

- 语言：中文 / 英文 / 中英混排
- 引用方式：[[wikilinks]] / 数字脚注 / 都不用
- 行长：≤ 120 字符 / 不限
- 数学公式：用 `$...$` LaTeX / 用文字描述
- 章节最长：500 字（强制拆页） / 不限

## Thesis

您当前对这个领域的核心观点（随研究进展不断更新）。LLM 会在写 synthesis
页时与此对照。

> TBD
```

### 3.2 写好 purpose.md 的 3 个技巧

1. **Audience 部分要具体**：「写给我自己」和「写给团队」会让 LLM 选完全不同的语言深度
2. **Scope 的「不在范围内」比「在范围内」更重要**：明确写出来 → LLM 不会因为资料里碰巧出现就贸然建页
3. **Style Preferences 要可执行**：「友好但专业」太虚，改成「避免感叹号、不用 emoji、不写'让我们'这种引导句」

---

## 4. Settings UI：全局开关速查表

按从最常用到最少用排序：

### 4.1 设置 → LLM 模型
- **provider / 模型**：换 model = 换全部输出质量。Claude / GPT-4 / DeepSeek / Ollama 本地都行
- **maxContextSize**：默认 200K。模型支持就调大，能让 LLM 一次看更多 wiki 上下文
- **reasoning**（仅部分模型）：开启 chain-of-thought 后输出更慢但更准

### 4.2 设置 → 输出偏好
- **AI 输出语言**：选「Auto」让 LLM 跟随源文档；选「中文」/「English」强制
- **对话历史长度**：默认 20。问后续问题时 LLM 看到的对话上下文条数

### 4.3 设置 → 网页搜索
- **provider**：Tavily / SerpApi / SearXNG。决定「深度研究」和「定时联网刷新」用哪个搜索引擎
- 每个 provider 有自己的子选项（搜索类型、域名过滤等）

### 4.4 设置 → 嵌入向量
- **开启后** wiki 检索质量在 100+ 页规模显著提升
- model 选 `text-embedding-3-small`（OpenAI）或 `bge-m3`（中文友好）

### 4.5 设置 → 多模态（图片描述）
- 默认用主 LLM。开「专用 provider」可换便宜的 vision-only 模型（如 GPT-4o-mini）省钱

### 4.6 设置 → 界面
- **UI 语言**：中 / English。**点击即时生效**（本 fork 升级），不必再点保存
- 主题、字体大小、面板布局等

### 4.7 设置 → 资料文件夹监控 / 定时导入 / 定时联网刷新
- 见 [features.md](features.md)

---

## 5. 页面级 frontmatter 字段

每个 wiki 页面顶部的 YAML 块。LLM 会按字段做事：

### 5.1 必备字段（schema.md 强制）
```yaml
---
type: <您 schema.md 里定义的类型>
title: 人读的标题
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---
```

### 5.2 关联字段
```yaml
related: [[other-page-1]], [[other-page-2]]    # 双链
sources: [raw/sources/file1.pdf]                # 来自哪些原始资料
```

### 5.3 工作流字段（您可自定义）
```yaml
status: draft | review | published | archived
priority: high | medium | low
owner: "@alice"
review_after: YYYY-MM-DD
```

### 5.4 fork 新增的刷新字段
```yaml
refresh-enabled: true
refresh-interval-days: 7
refresh-queries:
  - "..."
```
详见 [features.md §2](features.md#2-页面级定时联网刷新)。

### 5.5 任意自定义字段

YAML 是自由格式。您写什么 frontmatter 字段，LLM 在更新该页时都会保留（除非您明确要求删除）。

---

## 6. 常见配方

### 「我想 LLM 写得更短」
- `purpose.md` 加：「每页正文 ≤ 500 字，不要复述源文档」
- `schema.md` 在每类规则下加字数上限

### 「我想 LLM 写中文但保留专业术语英文原文」
- `purpose.md` Style：「中文主体；专业术语首次出现给 `中文（English）` 形式，后续用英文」
- 设置 → 输出偏好 → AI 输出语言 = 中文

### 「我希望 LLM 不要瞎建页面，只更新已有页」
- `schema.md` 加规则：「不主动创建新页面，除非源文档明确引入了 schema 已定义类型且现有 wiki 没有对应页」

### 「我要 LLM 引用资料时带页码」
- `schema.md` 加规则：「所有引用必须形如 `[[source-slug]] p.42` 或 `[[source-slug]] §3.2`，禁止无定位引用」

### 「我要建一个全新的页面类型，路径在 wiki/observations/」
1. `schema.md` 表格加一行 `| observation | wiki/observations/ | 实地观察记录 |`
2. （可选）frontmatter 段加 observation 专属字段示例
3. 保存。下次摄入相关资料时 LLM 会自动用 observation 类型

### 「我想让 LLM 拒绝处理含敏感词的源文档」
- `schema.md` 加规则：「源文档若含 [敏感词列表]，跳过摄入并在 review 队列报告，不写入 wiki」

---

## 7. 常见误区

- ❌ **不要在设置里找「分类」配置面板** —— 没有。分类一律在 `schema.md`
- ❌ **不要直接编辑 `wiki/log.md`** —— LLM 管理。您加的内容下次 lint 会被压缩 / 移走
- ❌ **不要把 API Key 写在 `purpose.md`** —— 它在 git / 云盘里跟着同步。Key 在系统应用数据目录
- ✅ **修改 schema.md 后做一次「全量重摄入」** 让旧页面也升级到新 schema（LLM 会按需迁移）

---

## 8. 进阶：为不同子项目用不同 schema

LLMWiki 一个项目 = 一份 schema。如果您要管理多个独立领域（如「读书笔记」+ 「工作笔记」），**建议建两个独立 LLMWiki 项目**，各自一份 schema.md。导入/导出可以独立 `.llmwiki` 包来回搬。

---

文档完。后续问题：
- [`user-manual.md`](user-manual.md) — 日常使用流程
- [`features.md`](features.md) — fork 新功能详细技术文档
- [`getting-started.md`](getting-started.md) — 安装与首启
- [`cloud-sharing.md`](cloud-sharing.md) — 团队部署
