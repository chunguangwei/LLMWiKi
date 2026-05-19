/**
 * Project templates — bilingual.
 *
 * Each template provides Chinese ("zh") and English ("en") variants of its
 * `schema.md`, `purpose.md`, and `extraDirs` list. Pick the variant based on
 * the UI language at project-creation time:
 *
 *     getTemplate("comprehensive", "zh") → 中文目录名 + 中文 schema 文案
 *     getTemplate("comprehensive", "en") → ASCII slug 目录 + English schema
 *
 * Existing English-only templates (research / reading / personal / business /
 * general) keep their original wording for the `en` variant and gain a `zh`
 * variant translated for Chinese-language projects.
 *
 * The new `comprehensive` template covers ~34 categories (travel, manuals,
 * project docs, books, recipes, contracts, etc.) and is the recommended
 * default — placed first in the templates array.
 */

export type SchemaLang = "zh" | "en"

export interface WikiTemplate {
  id: string
  name: string
  description: string
  icon: string
  /** Schema text, one variant per UI language. */
  schema: Record<SchemaLang, string>
  /** Purpose seed, one variant per UI language. */
  purpose: Record<SchemaLang, string>
  /** Extra wiki/ subdirectories to pre-create, one list per language. */
  extraDirs: Record<SchemaLang, string[]>
}

// ────────────────────────────────────────────────────────────────────────────
// Shared snippets — English (kept verbatim from the original templates so
// existing English-language projects render identically).
// ────────────────────────────────────────────────────────────────────────────

const BASE_SCHEMA_TYPES_EN = `| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena, frameworks |
| source | wiki/sources/ | Papers, articles, talks, books, blog posts |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |`

const BASE_NAMING_EN = `- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`openai.md\`, \`gpt-4.md\`)
- Concepts: descriptive noun phrases (e.g., \`chain-of-thought.md\`)
- Sources: \`author-year-slug.md\` (e.g., \`wei-2022-cot.md\`)
- Queries: question as slug (e.g., \`does-scale-improve-reasoning.md\`)`

const BASE_FRONTMATTER_EN = `All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Source pages also include:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\``

const BASE_INDEX_FORMAT_EN = `\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\``

const BASE_LOG_FORMAT_EN = `\`wiki/log.md\` records activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\``

const BASE_CROSSREF_EN = `- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity and concept should appear in \`wiki/index.md\`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via \`related:\``

const BASE_CONTRADICTION_EN = `When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists`

// ────────────────────────────────────────────────────────────────────────────
// Shared snippets — Chinese.
// ────────────────────────────────────────────────────────────────────────────

const BASE_SCHEMA_TYPES_ZH = `| entity | wiki/entities/ | 命名实体（人物、工具、组织、数据集等） |
| concept | wiki/concepts/ | 想法、技术、现象、框架 |
| source | wiki/sources/ | 论文、文章、演讲、书籍、博客 |
| query | wiki/queries/ | 当前研究的开放问题 |
| comparison | wiki/comparisons/ | 多个实体的对比分析 |
| synthesis | wiki/synthesis/ | 跨主题综合性结论 |
| overview | wiki/ | 项目高层概览（每个项目一份） |`

const BASE_NAMING_ZH = `- 文件名：英文用 \`kebab-case.md\`，中文可直接用中文（如 \`东京三日游.md\`）
- 实体：尽量用官方名称（如 \`openai.md\`、\`gpt-4.md\`）
- 概念：描述性短语（如 \`chain-of-thought.md\`）
- 资料：\`作者-年份-标题.md\`（如 \`wei-2022-cot.md\`）
- 问题：问句简化为 slug（如 \`规模化是否提升推理能力.md\`）`

const BASE_FRONTMATTER_ZH = `所有页面必须包含 YAML frontmatter：

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: 人读的标题
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

source 页额外字段：
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\``

const BASE_INDEX_FORMAT_ZH = `\`wiki/index.md\` 按类型分组列出所有页面，每条格式：
\`\`\`
- [[页面 slug]] — 一行说明
\`\`\``

const BASE_LOG_FORMAT_ZH = `\`wiki/log.md\` 按时间倒序记录操作：
\`\`\`
## YYYY-MM-DD

- 操作 / 发现
\`\`\``

const BASE_CROSSREF_ZH = `- 用 \`[[页面 slug]]\` 在页面之间互链
- 每个实体、概念都应出现在 \`wiki/index.md\`
- query 页链到它依据的 source 和 concept
- synthesis 页通过 \`related:\` 引用所有相关 source`

const BASE_CONTRADICTION_ZH = `当资料之间出现矛盾时：
1. 在相关 concept / entity 页里标注矛盾
2. 新建或更新一个 query 页，追踪这个开放问题
3. 把两份 source 都链到 query 页
4. 证据充分后，在 synthesis 页给出结论`

// ────────────────────────────────────────────────────────────────────────────
// Research template
// ────────────────────────────────────────────────────────────────────────────

const researchTemplate: WikiTemplate = {
  id: "research",
  name: "Research",
  description: "Deep-dive research with hypothesis tracking and methodology notes",
  icon: "🔬",
  extraDirs: {
    en: ["wiki/methodology", "wiki/findings", "wiki/thesis"],
    zh: ["wiki/方法论", "wiki/发现", "wiki/假设"],
  },
  schema: {
    en: `# Wiki Schema — Research Deep-Dive

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES_EN}
| thesis | wiki/thesis/ | Working hypothesis and its evolution over time |
| methodology | wiki/methodology/ | Research methods, protocols, and study designs |
| finding | wiki/findings/ | Individual empirical results or observations |

## Naming Conventions

${BASE_NAMING_EN}
- Theses: hypothesis as slug (e.g., \`scaling-improves-reasoning.md\`)
- Methodologies: method name (e.g., \`systematic-review.md\`, \`ablation-study.md\`)
- Findings: descriptive slug (e.g., \`larger-models-better-few-shot.md\`)

## Frontmatter

${BASE_FRONTMATTER_EN}

Thesis pages also include:
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

Finding pages also include:
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}
- Findings link back to their source via the \`source:\` frontmatter field
- Thesis pages reference supporting and refuting findings via \`related:\`
- Methodology pages are cited by the findings that used them

## Contradiction Handling

${BASE_CONTRADICTION_EN}

## Research-Specific Conventions

- Keep the thesis pages updated as evidence accumulates — they are living documents
- Every finding should assess replication status when known
- Methodology pages explain the *why* (rationale) not just the *how*
- Distinguish between direct evidence and inference in finding pages
`,
    zh: `# Wiki Schema — 深度研究

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
${BASE_SCHEMA_TYPES_ZH}
| thesis | wiki/假设/ | 当前工作假设及演化 |
| methodology | wiki/方法论/ | 研究方法、流程、实验设计 |
| finding | wiki/发现/ | 单个实证结果或观察 |

## 命名约定

${BASE_NAMING_ZH}
- 假设：hypothesis 简化为 slug（如 \`规模化提升推理能力.md\`）
- 方法论：方法名（如 \`系统综述.md\`、\`消融实验.md\`）
- 发现：描述性 slug（如 \`大模型 few-shot 更强.md\`）

## Frontmatter

${BASE_FRONTMATTER_ZH}

thesis 页额外字段：
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

finding 页额外字段：
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}
- finding 通过 frontmatter 的 \`source:\` 链回它的资料来源
- thesis 通过 \`related:\` 引用支持 / 反驳它的 finding
- methodology 被使用它的 finding 引用

## 矛盾处理

${BASE_CONTRADICTION_ZH}

## 研究专属约定

- thesis 是活文档，证据积累后随时更新
- 每条 finding 在可知时标注重现状态
- methodology 解释方法的「为什么」，不只是「怎么做」
- finding 页区分直接证据和推断
`,
  },
  purpose: {
    en: `# Project Purpose — Research Deep-Dive

## Research Question

<!-- State the central question this research aims to answer. Be specific and falsifiable. -->

>

## Hypothesis / Working Thesis

<!-- Your current best guess. This will evolve — update it as evidence accumulates. -->

>

## Background

<!-- What prior work or context motivates this research? What gap does it fill? -->

## Sub-questions

<!-- Break down the main question into tractable sub-questions. -->

1.
2.
3.
4.

## Scope

**In scope:**
-

**Out of scope:**
-

## Methodology

<!-- How will you investigate this? What types of sources or experiments are relevant? -->

-

## Success Criteria

<!-- How will you know when you have a satisfying answer? -->

-

## Current Status

> Not started — update this section as research progresses.
`,
    zh: `# 项目目标 — 深度研究

## 研究问题

<!-- 这份研究要回答的核心问题。要具体、可证伪。 -->

>

## 假设 / 工作论点

<!-- 当前最好的猜测。随证据积累而演化。 -->

>

## 背景

<!-- 哪些已有工作或语境驱动了这次研究？要填的是什么空白？ -->

## 子问题

<!-- 把主问题拆为可操作的子问题。 -->

1.
2.
3.
4.

## 范围

**在范围内：**
-

**不在范围内：**
-

## 方法

<!-- 计划怎么研究？需要哪些类型的资料或实验？ -->

-

## 完成标志

<!-- 什么样的回答才算「够好」？ -->

-

## 当前状态

> 尚未开始 — 随研究进展更新本节。
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Reading template
// ────────────────────────────────────────────────────────────────────────────

const readingTemplate: WikiTemplate = {
  id: "reading",
  name: "Reading",
  description: "Track a book's characters, themes, plot threads, and chapter notes",
  icon: "📚",
  extraDirs: {
    en: ["wiki/characters", "wiki/themes", "wiki/plot-threads", "wiki/chapters"],
    zh: ["wiki/人物", "wiki/主题", "wiki/情节线", "wiki/章节"],
  },
  schema: {
    en: `# Wiki Schema — Reading a Book

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES_EN}
| character | wiki/characters/ | People and figures in the book |
| theme | wiki/themes/ | Recurring ideas, motifs, and symbolic threads |
| plot-thread | wiki/plot-threads/ | Storylines or narrative arcs being tracked |
| chapter | wiki/chapters/ | Per-chapter notes and summaries |

## Naming Conventions

${BASE_NAMING_EN}
- Characters: character name in kebab-case (e.g., \`elizabeth-bennet.md\`)
- Themes: thematic noun phrase (e.g., \`social-class-mobility.md\`)
- Plot threads: arc description (e.g., \`darcys-redemption-arc.md\`)
- Chapters: \`ch-NN-slug.md\` (e.g., \`ch-01-opening-scene.md\`)

## Frontmatter

${BASE_FRONTMATTER_EN}

Character pages also include:
\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

Chapter pages also include:
\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\`

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}
- Chapter notes reference characters appearing in that chapter via \`related:\`
- Theme pages link to the chapters where the theme is most prominent
- Plot thread pages list chapters that advance the arc

## Contradiction Handling

${BASE_CONTRADICTION_EN}

## Reading-Specific Conventions

- Chapter pages are written during or immediately after reading — capture fresh reactions
- Distinguish between plot summary and personal interpretation in chapter notes
- Theme pages should track *development* across the book, not just state that a theme exists
- Flag unresolved plot threads with status: \`open\` until resolved
- Note page numbers for important quotes to enable re-finding later
`,
    zh: `# Wiki Schema — 读书笔记

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
${BASE_SCHEMA_TYPES_ZH}
| character | wiki/人物/ | 书中出场的人物 |
| theme | wiki/主题/ | 反复出现的理念、母题、象征线 |
| plot-thread | wiki/情节线/ | 跟踪中的故事线 |
| chapter | wiki/章节/ | 章节笔记与摘要 |

## 命名约定

${BASE_NAMING_ZH}
- 人物：人物名（如 \`伊丽莎白-班纳特.md\`）
- 主题：主题短语（如 \`阶层流动.md\`）
- 情节线：弧线描述（如 \`达西的成长弧.md\`）
- 章节：\`ch-NN-标题.md\`（如 \`ch-01-开场.md\`）

## Frontmatter

${BASE_FRONTMATTER_ZH}

character 页额外字段：
\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

chapter 页额外字段：
\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\`

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}
- 章节笔记通过 \`related:\` 引用出场的人物
- 主题页链到该主题最突出的章节
- 情节线列出推进它的章节

## 矛盾处理

${BASE_CONTRADICTION_ZH}

## 读书专属约定

- 章节页边读边写 / 读完立刻写——捕捉鲜活反应
- 章节笔记区分情节摘要和个人解读
- 主题页要追踪「发展」，不只是「存在」
- 未解决的情节线标 status: \`open\`
- 重要引文记页码或章节位置，方便回查
`,
  },
  purpose: {
    en: `# Project Purpose — Reading

## Book Details

**Title:**
**Author:**
**Year:**
**Genre:**

## Why I'm Reading This

<!-- What drew you to this book? What do you hope to get from it? -->

## Key Themes to Track

<!-- What thematic threads do you expect or want to follow? -->

1.
2.
3.

## Questions Going In

<!-- What do you want answered or explored by the end? -->

1.
2.

## Reading Pace

**Started:**
**Target finish:**
**Current chapter:**

## First Impressions

<!-- Update after first chapter or first sitting. -->

>

## Final Takeaways

<!-- Fill in when finished. What did this book teach you? -->

>
`,
    zh: `# 项目目标 — 读书笔记

## 书籍信息

**标题：**
**作者：**
**出版年份：**
**类型：**

## 为什么读这本书

<!-- 是什么吸引了你？希望从中得到什么？ -->

## 想跟踪的主题

<!-- 期待或想追的主题线 -->

1.
2.
3.

## 阅读前的问题

<!-- 你希望读完后能回答的问题 -->

1.
2.

## 阅读节奏

**开始日期：**
**目标完成日期：**
**当前章节：**

## 初步印象

<!-- 读完第一章或第一次坐下后更新 -->

>

## 最终收获

<!-- 读完后填写。这本书教会你什么？ -->

>
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Personal growth template
// ────────────────────────────────────────────────────────────────────────────

const personalTemplate: WikiTemplate = {
  id: "personal",
  name: "Personal Growth",
  description: "Track goals, habits, reflections, and journal entries for self-improvement",
  icon: "🌱",
  extraDirs: {
    en: ["wiki/goals", "wiki/habits", "wiki/reflections", "wiki/journal"],
    zh: ["wiki/目标", "wiki/习惯", "wiki/反思", "wiki/日志"],
  },
  schema: {
    en: `# Wiki Schema — Personal Growth

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES_EN}
| goal | wiki/goals/ | Specific outcomes you are working toward |
| habit | wiki/habits/ | Recurring behaviours and their tracking |
| reflection | wiki/reflections/ | Periodic reviews and lessons learned |
| journal | wiki/journal/ | Freeform daily or session entries |

## Naming Conventions

${BASE_NAMING_EN}
- Goals: outcome as slug (e.g., \`run-a-marathon.md\`, \`learn-spanish.md\`)
- Habits: behaviour name (e.g., \`daily-meditation.md\`)
- Reflections: type + date (e.g., \`weekly-2024-03.md\`)
- Journal: date slug (e.g., \`2024-03-15.md\`)

## Frontmatter

${BASE_FRONTMATTER_EN}

Goal pages also include:
\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

Habit pages also include:
\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

Reflection pages also include:
\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\`

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}
- Reflection pages reference the goals and habits reviewed during that period
- Goals link to the habits that support them via \`related:\`
- Journal entries can reference goals and reflections inline with \`[[slug]]\`

## Contradiction Handling

${BASE_CONTRADICTION_EN}

## Personal Growth Conventions

- Be honest in journal and reflection entries — this wiki is for you, not an audience
- Update goal progress fields regularly; stale data is worse than no data
- Distinguish between outcome goals (what you want) and process goals (what you will do)
- Reflect on *why* habits succeed or fail, not just whether they did
- Use the synthesis directory for cross-cutting insights that span multiple goals or periods
`,
    zh: `# Wiki Schema — 个人成长

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
${BASE_SCHEMA_TYPES_ZH}
| goal | wiki/目标/ | 你在追求的具体结果 |
| habit | wiki/习惯/ | 周期性行为与跟踪 |
| reflection | wiki/反思/ | 定期回顾与经验提炼 |
| journal | wiki/日志/ | 自由格式的每日 / 单次记录 |

## 命名约定

${BASE_NAMING_ZH}
- 目标：结果短语（如 \`跑完马拉松.md\`、\`学西班牙语.md\`）
- 习惯：行为名（如 \`每日冥想.md\`）
- 反思：类型 + 日期（如 \`周报-2024-03.md\`）
- 日志：日期（如 \`2024-03-15.md\`）

## Frontmatter

${BASE_FRONTMATTER_ZH}

goal 页额外字段：
\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

habit 页额外字段：
\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

reflection 页额外字段：
\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\`

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}
- reflection 引用本期回顾到的 goal / habit
- goal 通过 \`related:\` 链到支持它的 habit
- journal 条目可在正文用 \`[[slug]]\` 引用 goal / reflection

## 矛盾处理

${BASE_CONTRADICTION_ZH}

## 个人成长约定

- journal / reflection 写真心话——是给你自己看的
- goal progress 字段定期更新；陈旧数据比没数据更糟
- 区分结果目标（想要什么）和过程目标（要做什么）
- 反思习惯成败的「为什么」，不只是「是否」
- 跨多个目标 / 周期的洞见放进 synthesis 目录
`,
  },
  purpose: {
    en: `# Project Purpose — Personal Growth

## Focus Areas

<!-- What areas of your life or self are you actively working on? -->

1.
2.
3.

## Motivation

<!-- Why now? What prompted you to start this wiki? -->

## Current Goals (Summary)

<!-- High-level list — create detailed goal pages in wiki/goals/ -->

- [ ]
- [ ]
- [ ]

## Active Habits

<!-- High-level list — create detailed habit pages in wiki/habits/ -->

-
-

## Review Cadence

**Daily journal:** Yes / No
**Weekly reflection:**
**Monthly reflection:**
**Quarterly reflection:**

## Guiding Principles

<!-- What values or principles guide your growth work? -->

1.
2.
3.

## This Year's Theme

<!-- One phrase or sentence that captures your intention for the year. -->

>
`,
    zh: `# 项目目标 — 个人成长

## 关注领域

<!-- 当前在主动经营的生活 / 自我面向 -->

1.
2.
3.

## 动机

<!-- 为什么是现在？什么促使你开始这份 wiki？ -->

## 当前目标（概览）

<!-- 高层列表 — 详细目标页放在 wiki/目标/ -->

- [ ]
- [ ]
- [ ]

## 维持中的习惯

<!-- 高层列表 — 详细习惯页放在 wiki/习惯/ -->

-
-

## 回顾节奏

**每日日志：** 是 / 否
**周反思：**
**月反思：**
**季度反思：**

## 指导原则

<!-- 指引成长工作的价值观或原则 -->

1.
2.
3.

## 本年主题

<!-- 一句话概括本年意图 -->

>
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Business template
// ────────────────────────────────────────────────────────────────────────────

const businessTemplate: WikiTemplate = {
  id: "business",
  name: "Business",
  description: "Manage meetings, decisions, projects, and stakeholder context for a team",
  icon: "💼",
  extraDirs: {
    en: ["wiki/meetings", "wiki/decisions", "wiki/projects", "wiki/stakeholders"],
    zh: ["wiki/会议", "wiki/决策", "wiki/项目", "wiki/干系人"],
  },
  schema: {
    en: `# Wiki Schema — Business / Team

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES_EN}
| meeting | wiki/meetings/ | Meeting notes, agendas, and action items |
| decision | wiki/decisions/ | Architectural or strategic decisions (ADR-style) |
| project | wiki/projects/ | Project briefs, status, and retrospectives |
| stakeholder | wiki/stakeholders/ | People, teams, and organisations involved |

## Naming Conventions

${BASE_NAMING_EN}
- Meetings: \`YYYY-MM-DD-slug.md\` (e.g., \`2024-03-15-sprint-planning.md\`)
- Decisions: \`NNN-slug.md\` (e.g., \`001-adopt-typescript.md\`)
- Projects: descriptive slug (e.g., \`payments-redesign.md\`)
- Stakeholders: name or team (e.g., \`alice-chen.md\`, \`platform-team.md\`)

## Frontmatter

${BASE_FRONTMATTER_EN}

Meeting pages also include:
\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\`

Decision pages also include:
\`\`\`yaml
status: proposed | accepted | deprecated | superseded
deciders: []
date: YYYY-MM-DD
supersedes: ""
\`\`\`

Project pages also include:
\`\`\`yaml
status: planned | active | on-hold | complete | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}
- Meeting notes reference attendees via \`attendees:\` frontmatter and \`[[stakeholder-slug]]\` links
- Decision pages link to the meetings where the decision was discussed
- Project pages link to their key decisions via \`related:\`
- Stakeholder pages list projects and decisions they are involved in

## Contradiction Handling

${BASE_CONTRADICTION_EN}

## Business-Specific Conventions

- Write meeting notes during or within 24 hours — memory fades fast
- Action items must have a named owner and due date to be actionable
- Decision pages capture *context and consequences*, not just the decision itself
- Deprecated decisions should link to the decision that superseded them
- Projects should have a retrospective section added on completion
`,
    zh: `# Wiki Schema — 团队 / 业务

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
${BASE_SCHEMA_TYPES_ZH}
| meeting | wiki/会议/ | 会议纪要、议程、行动项 |
| decision | wiki/决策/ | 架构或战略决策（ADR 风格） |
| project | wiki/项目/ | 项目简介、状态、复盘 |
| stakeholder | wiki/干系人/ | 涉及的人员、团队、组织 |

## 命名约定

${BASE_NAMING_ZH}
- 会议：\`YYYY-MM-DD-标题.md\`（如 \`2024-03-15-冲刺计划.md\`）
- 决策：\`NNN-标题.md\`（如 \`001-采用-typescript.md\`）
- 项目：描述性 slug（如 \`支付重构.md\`）
- 干系人：人名或团队名（如 \`陈艾丽.md\`、\`平台组.md\`）

## Frontmatter

${BASE_FRONTMATTER_ZH}

meeting 页额外字段：
\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\`

decision 页额外字段：
\`\`\`yaml
status: proposed | accepted | deprecated | superseded
deciders: []
date: YYYY-MM-DD
supersedes: ""
\`\`\`

project 页额外字段：
\`\`\`yaml
status: planned | active | on-hold | complete | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}
- 会议纪要通过 \`attendees:\` 和 \`[[干系人 slug]]\` 引用参会人
- 决策页链到讨论该决策的会议
- 项目页通过 \`related:\` 链到关键决策
- 干系人页列出他们参与的项目和决策

## 矛盾处理

${BASE_CONTRADICTION_ZH}

## 团队专属约定

- 会议纪要会议中 / 24 小时内写完 —— 记忆衰减快
- action item 必须有指定 owner 和截止日期
- 决策页捕获「上下文 + 后果」，不只是结论
- 已废弃的决策链到取代它的新决策
- 项目结束时加入复盘段落
`,
  },
  purpose: {
    en: `# Project Purpose — Business / Team

## Business Context

**Organisation / Team:**
**Domain:**
**Time period covered:**

## Objectives

<!-- What are the top-level business objectives this wiki supports? -->

1.
2.
3.

## Key Projects

<!-- High-level list — create detailed pages in wiki/projects/ -->

-
-

## Key Stakeholders

<!-- Who are the primary people or teams involved? -->

-
-

## Open Decisions

<!-- Decisions currently in flight — create ADR pages in wiki/decisions/ -->

-
-

## Metrics / Success Criteria

<!-- How does the team measure progress toward its objectives? -->

-

## Constraints and Risks

<!-- Known constraints (budget, time, org) and risks to track -->

-

## Review Cadence

**Weekly sync notes:**
**Monthly status update:**
**Quarterly retrospective:**
`,
    zh: `# 项目目标 — 团队 / 业务

## 业务背景

**组织 / 团队：**
**领域：**
**时间范围：**

## 目标

<!-- 这份 wiki 支撑哪些顶层业务目标？ -->

1.
2.
3.

## 关键项目

<!-- 高层列表 — 详细页放在 wiki/项目/ -->

-
-

## 关键干系人

<!-- 主要涉及的人员 / 团队 -->

-
-

## 待决议事项

<!-- 当前在讨论的决策 — ADR 页放在 wiki/决策/ -->

-
-

## 指标 / 成功标准

<!-- 团队如何衡量目标进展？ -->

-

## 约束与风险

<!-- 已知约束（预算、时间、组织）和需要跟踪的风险 -->

-

## 回顾节奏

**周同步：**
**月报：**
**季度复盘：**
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// General template
// ────────────────────────────────────────────────────────────────────────────

const generalTemplate: WikiTemplate = {
  id: "general",
  name: "General",
  description: "Minimal setup — a blank slate for any purpose",
  icon: "📄",
  extraDirs: {
    en: [],
    zh: [],
  },
  schema: {
    en: `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES_EN}

## Naming Conventions

${BASE_NAMING_EN}

## Frontmatter

${BASE_FRONTMATTER_EN}

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}

## Contradiction Handling

${BASE_CONTRADICTION_EN}
`,
    zh: `# Wiki Schema

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
${BASE_SCHEMA_TYPES_ZH}

## 命名约定

${BASE_NAMING_ZH}

## Frontmatter

${BASE_FRONTMATTER_ZH}

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}

## 矛盾处理

${BASE_CONTRADICTION_ZH}
`,
  },
  purpose: {
    en: `# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this project -->

1.
2.
3.

## Scope

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as the project progresses) -->

> TBD
`,
    zh: `# 项目目标

## 目标

<!-- 你想理解或构建什么？ -->

## 关键问题

<!-- 列出驱动这个项目的主要问题 -->

1.
2.
3.

## 范围

**在范围内：**
-

**不在范围内：**
-

## 当前论点

<!-- 当前工作假设或结论（随项目进展更新） -->

> 待定
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Comprehensive template — the new default. ~34 categories covering travel
// plans, manuals, project docs, books, recipes, contracts, code snippets,
// regulations, etc. Chinese directory names for `zh`, ASCII slugs for `en`.
//
// The schema marks each type as either "整篇保留 (single-page mode)" or
// "可拆分 (multi-page mode)" so the LLM follows the right strategy at ingest
// time. This pairs with the Splitting Rules block in buildGenerationPrompt.
// ────────────────────────────────────────────────────────────────────────────

const COMPREHENSIVE_DIRS_ZH = [
  "wiki/旅游方案", "wiki/用户手册", "wiki/项目文档", "wiki/教程", "wiki/书籍",
  "wiki/食谱", "wiki/笔记", "wiki/报告", "wiki/文章", "wiki/会议",
  "wiki/决策", "wiki/项目", "wiki/影视", "wiki/音乐", "wiki/游戏",
  "wiki/菜单", "wiki/购物清单", "wiki/健身计划", "wiki/合同", "wiki/发票",
  "wiki/医疗记录", "wiki/保险单", "wiki/代码片段", "wiki/API文档", "wiki/错误日志",
  "wiki/论文", "wiki/概念", "wiki/工具", "wiki/数据集", "wiki/人物",
  "wiki/公司", "wiki/法规", "wiki/综合",
]

const COMPREHENSIVE_DIRS_EN = [
  "wiki/travel-plans", "wiki/manuals", "wiki/project-docs", "wiki/tutorials", "wiki/books",
  "wiki/recipes", "wiki/notes", "wiki/reports", "wiki/articles", "wiki/meetings",
  "wiki/decisions", "wiki/projects", "wiki/film-tv", "wiki/music", "wiki/games",
  "wiki/menus", "wiki/shopping-lists", "wiki/fitness-plans", "wiki/contracts", "wiki/invoices",
  "wiki/medical-records", "wiki/insurance", "wiki/code-snippets", "wiki/api-docs", "wiki/error-logs",
  "wiki/papers", "wiki/concepts", "wiki/tools", "wiki/datasets", "wiki/people",
  "wiki/companies", "wiki/regulations", "wiki/synthesis",
]

const comprehensiveTemplate: WikiTemplate = {
  id: "comprehensive",
  name: "Comprehensive",
  description: "Recommended. Rich taxonomy covering everyday docs (travel, manuals, books, recipes, contracts, code) plus research/work types — Chinese-first directories.",
  icon: "🗂️",
  extraDirs: {
    zh: COMPREHENSIVE_DIRS_ZH,
    en: COMPREHENSIVE_DIRS_EN,
  },
  schema: {
    zh: `# Wiki Schema — 综合（推荐默认）

> 这个 schema 覆盖了日常常用的所有文档类型。「整篇保留」类型导入时**一份源文档 = 一个 wiki 页**，绝不拆碎；「可拆分」类型才会按概念 / 人物 / 工具拆分子页。

## 页面类型

### 整篇保留（single-page mode）— 导入时不拆分

| 类型 | 目录 | 用途 |
|------|------|------|
| travel-plan | wiki/旅游方案/ | 行程规划、攻略、游记（一份方案 = 一页） |
| manual | wiki/用户手册/ | 产品手册、操作指南、说明书 |
| project-doc | wiki/项目文档/ | README、设计文档、规格说明、技术方案 |
| tutorial | wiki/教程/ | 教学材料、课程笔记、课件 |
| book | wiki/书籍/ | 整本书摘要（一本一页） |
| recipe | wiki/食谱/ | 菜谱、配方 |
| note | wiki/笔记/ | 日常笔记、备忘、灵感 |
| report | wiki/报告/ | 调研报告、白皮书、技术报告 |
| article | wiki/文章/ | 博客、新闻文章、专栏 |
| meeting | wiki/会议/ | 会议纪要 |
| decision | wiki/决策/ | 决策记录（ADR） |
| project | wiki/项目/ | 项目主页（项目维度的元信息） |
| film-tv | wiki/影视/ | 电影、剧集、纪录片 |
| music | wiki/音乐/ | 专辑、歌曲、播放清单 |
| game | wiki/游戏/ | 游戏攻略、玩后感 |
| menu | wiki/菜单/ | 餐饮菜单 |
| shopping-list | wiki/购物清单/ | 待买清单 |
| fitness-plan | wiki/健身计划/ | 训练计划、跑步计划 |
| contract | wiki/合同/ | 合同、协议 |
| invoice | wiki/发票/ | 发票、账单、收据 |
| medical-record | wiki/医疗记录/ | 检查报告、就诊记录、处方 |
| insurance | wiki/保险单/ | 保险单、理赔记录 |
| code-snippet | wiki/代码片段/ | 可复用的代码片段 |
| api-doc | wiki/API文档/ | API 接口文档 |
| error-log | wiki/错误日志/ | 故障日志、报错记录 |

### 可拆分（multi-page mode）— 导入时按需拆出子页

| 类型 | 目录 | 用途 |
|------|------|------|
| paper | wiki/论文/ | 学术论文（拆出 concept / tool / dataset 子页） |
| concept | wiki/概念/ | 概念、术语、想法、技术 |
| tool | wiki/工具/ | 工具、软件、库、服务 |
| dataset | wiki/数据集/ | 数据集 |
| person | wiki/人物/ | 人物档案（学者、作者、CEO） |
| company | wiki/公司/ | 公司、组织、机构 |
| regulation | wiki/法规/ | 法律法规、合规要求、政策 |

### 元数据

| 类型 | 目录 | 用途 |
|------|------|------|
| synthesis | wiki/综合/ | 跨主题综合分析、综述 |
| overview | wiki/ | wiki/overview.md（项目唯一） |
| index | wiki/ | wiki/index.md（项目唯一） |
| log | wiki/ | wiki/log.md（项目唯一） |

## 命名约定

- 文件名：英文用 \`kebab-case.md\`，中文可直接用中文（如 \`东京三日游.md\`、\`合同-2024-供应商A.md\`）
- 来源文件已有清晰标题时，直接用标题作为 slug，不要瞎改
- 日期类（会议 / 日志 / 发票）建议用 \`YYYY-MM-DD-标题.md\`

## Frontmatter

每个页面顶部 YAML 块（参考字段，按 type 选用）：

\`\`\`yaml
---
type: travel-plan | manual | project-doc | tutorial | book | recipe | note | report | article | meeting | decision | project | film-tv | music | game | menu | shopping-list | fitness-plan | contract | invoice | medical-record | insurance | code-snippet | api-doc | error-log | paper | concept | tool | dataset | person | company | regulation | synthesis | overview
title: 人读的标题
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [原始文件名]
---
\`\`\`

不同 type 可加专属字段（旅游：destination / dates；合同：parties / value / 签约日；菜谱：servings / prep_time；等等）。LLM 在生成时会按 type 自适应——你只要在这份 schema 里**追加示例**即可。

## 索引格式

${BASE_INDEX_FORMAT_ZH}

## 日志格式

${BASE_LOG_FORMAT_ZH}

## 互链规则

${BASE_CROSSREF_ZH}
- 「整篇保留」类型的页之间也鼓励互链（例如旅游方案可以链到相关餐厅菜单、菜谱、购物清单）
- 「可拆分」类型自动被 paper / report 拆分逻辑引用

## 矛盾处理

${BASE_CONTRADICTION_ZH}

## 拆分规则（重要）

LLM 在导入资料时，**必须先判断资料属于「整篇保留」还是「可拆分」**：

- **整篇保留**：旅游方案、手册、项目文档、教程、书籍、食谱、笔记、报告、文章、会议、决策、项目、影视、音乐、游戏、菜单、购物清单、健身计划、合同、发票、医疗记录、保险单、代码片段、API 文档、错误日志 → **只产出一份 wiki 页面，不要拆成 entities/concepts**
- **可拆分**：论文、百科条目、综合性长文 → 可以同时产出一份 source 摘要 + 若干 concept / tool / dataset 子页

判断标准：**文档的本质**（叙事是否连贯、是否有单一工作流），而非长度。一份 200 页的行程仍是整篇保留；一份 2 页的论文仍要拆分。**拿不准时一律走整篇保留。**
`,
    en: `# Wiki Schema — Comprehensive (Recommended Default)

> This schema covers every everyday document type. "Single-page mode" types stay as ONE wiki page per source — they are NEVER fragmented. "Multi-page mode" types may decompose into concept / person / tool sub-pages.

## Page Types

### Single-page mode — keep as ONE page on ingest

| Type | Directory | Purpose |
|------|-----------|---------|
| travel-plan | wiki/travel-plans/ | Itineraries, trip plans, trip reports (one trip = one page) |
| manual | wiki/manuals/ | Product manuals, user guides, instructions |
| project-doc | wiki/project-docs/ | READMEs, design docs, specs, technical plans |
| tutorial | wiki/tutorials/ | Teaching materials, course notes, slides |
| book | wiki/books/ | Whole-book summaries (one book = one page) |
| recipe | wiki/recipes/ | Recipes, formulas, cooking instructions |
| note | wiki/notes/ | Daily notes, memos, scratchpad |
| report | wiki/reports/ | Research reports, whitepapers, technical reports |
| article | wiki/articles/ | Blogs, news articles, columns |
| meeting | wiki/meetings/ | Meeting notes |
| decision | wiki/decisions/ | Decision records (ADR-style) |
| project | wiki/projects/ | Project home pages (project metadata) |
| film-tv | wiki/film-tv/ | Films, TV series, documentaries |
| music | wiki/music/ | Albums, songs, playlists |
| game | wiki/games/ | Game walkthroughs, post-play reflections |
| menu | wiki/menus/ | Restaurant menus |
| shopping-list | wiki/shopping-lists/ | Shopping lists |
| fitness-plan | wiki/fitness-plans/ | Training plans, running plans |
| contract | wiki/contracts/ | Contracts, agreements |
| invoice | wiki/invoices/ | Invoices, bills, receipts |
| medical-record | wiki/medical-records/ | Test reports, visit notes, prescriptions |
| insurance | wiki/insurance/ | Insurance policies, claim records |
| code-snippet | wiki/code-snippets/ | Reusable code snippets |
| api-doc | wiki/api-docs/ | API documentation |
| error-log | wiki/error-logs/ | Incident logs, error records |

### Multi-page mode — may decompose into sub-pages

| Type | Directory | Purpose |
|------|-----------|---------|
| paper | wiki/papers/ | Academic papers (decompose into concept/tool/dataset) |
| concept | wiki/concepts/ | Concepts, terms, ideas, techniques |
| tool | wiki/tools/ | Tools, software, libraries, services |
| dataset | wiki/datasets/ | Datasets |
| person | wiki/people/ | Person profiles (researchers, authors, CEOs) |
| company | wiki/companies/ | Companies, organisations, institutions |
| regulation | wiki/regulations/ | Laws, regulations, compliance requirements |

### Meta

| Type | Directory | Purpose |
|------|-----------|---------|
| synthesis | wiki/synthesis/ | Cross-topic synthesis, reviews |
| overview | wiki/ | wiki/overview.md (one per project) |
| index | wiki/ | wiki/index.md (one per project) |
| log | wiki/ | wiki/log.md (one per project) |

## Naming Conventions

- Files: \`kebab-case.md\`
- When the source has a clear title, use it directly as the slug
- Date-bearing types (meetings / journals / invoices) use \`YYYY-MM-DD-slug.md\`

## Frontmatter

\`\`\`yaml
---
type: travel-plan | manual | project-doc | tutorial | book | recipe | note | report | article | meeting | decision | project | film-tv | music | game | menu | shopping-list | fitness-plan | contract | invoice | medical-record | insurance | code-snippet | api-doc | error-log | paper | concept | tool | dataset | person | company | regulation | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [original-filename]
---
\`\`\`

Different types may add specialised fields (travel: destination / dates; contract: parties / value / signed_on; recipe: servings / prep_time; etc.). The LLM adapts at generation time — you only need to **append examples** to this schema as conventions emerge.

## Index Format

${BASE_INDEX_FORMAT_EN}

## Log Format

${BASE_LOG_FORMAT_EN}

## Cross-referencing Rules

${BASE_CROSSREF_EN}
- Single-page-mode pages may also cross-link (e.g., a travel plan links to relevant menus, recipes, shopping lists)
- Multi-page-mode types are referenced by paper / report decomposition logic

## Contradiction Handling

${BASE_CONTRADICTION_EN}

## Splitting Rules (Critical)

When ingesting a source, the LLM **must first decide single-page-mode vs multi-page-mode**:

- **Single-page mode**: travel plans, manuals, project docs, tutorials, books, recipes, notes, reports, articles, meetings, decisions, projects, film/TV, music, games, menus, shopping lists, fitness plans, contracts, invoices, medical records, insurance, code snippets, API docs, error logs → **produce ONE wiki page; do NOT fragment into entities/concepts**.
- **Multi-page mode**: papers, encyclopedia entries, long-form syntheses → produce a source summary plus optional concept / tool / dataset sub-pages.

Decision criterion: **the document's nature** (coherent narrative? single workflow?), not its length. A 200-page itinerary is still single-page mode. A 2-page paper still decomposes. **When in doubt, single-page.**
`,
  },
  purpose: {
    zh: `# 项目目标

## 这个 wiki 装什么

<!-- 一句话写清楚这份 wiki 想沉淀什么内容。例：「我的生活资料库——旅游、菜谱、合同、医疗记录、工作笔记都放这里。」 -->

>

## 谁会读

<!-- 决定 LLM 的语气和详略 -->

- [ ] 只有我自己（私人，可使用术语和缩写）
- [ ] 我和家人 / 伴侣
- [ ] 我和团队
- [ ] 准备公开发布

## 主要使用场景

<!-- 列出你最常往里塞什么、最常查什么 -->

1.
2.
3.

## 不希望进入 wiki 的内容

<!-- 哪些资料即使被导入也不该建页（敏感信息、临时草稿等） -->

-

## 风格偏好

- 输出语言：中文 / 英文 / 中英混排
- 行长上限：
- 引用方式：[[wikilink]] / 数字脚注 / 不用
- 特定字段约定：

## 当前重点

<!-- 这个季度 / 这个月最想沉淀的方向 -->

>
`,
    en: `# Project Purpose

## What this wiki holds

<!-- One sentence on what knowledge you want to accumulate here. E.g., "My life knowledge base — travel, recipes, contracts, medical records, work notes all live here." -->

>

## Audience

<!-- Determines the LLM's tone and detail level -->

- [ ] Just me (private — jargon and abbreviations OK)
- [ ] Me and family / partner
- [ ] Me and team
- [ ] Will be published

## Primary use cases

<!-- Things you'll most often add to or look up in this wiki -->

1.
2.
3.

## Out-of-scope content

<!-- Things that should NOT get pages even if ingested (sensitive, temporary drafts, etc.) -->

-

## Style preferences

- Output language: zh / en / mixed
- Line length:
- Citation style: [[wikilink]] / numeric footnote / none
- Convention notes:

## Current focus

<!-- What you most want to capture this quarter / month -->

>
`,
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/** All templates, in display order. `comprehensive` is first (default). */
export const templates: WikiTemplate[] = [
  comprehensiveTemplate,
  researchTemplate,
  readingTemplate,
  personalTemplate,
  businessTemplate,
  generalTemplate,
]

/** A flat shape that callers use after picking a language. */
export interface ResolvedTemplate {
  id: string
  name: string
  description: string
  icon: string
  schema: string
  purpose: string
  extraDirs: string[]
}

/**
 * Look up a template by id and resolve its localised content.
 *
 * `lang` defaults to "en" so callers that haven't been updated yet keep
 * working — they'll get the English variant, matching the pre-change
 * behavior bit-for-bit (the en strings were copied verbatim from the
 * original templates).
 */
export function getTemplate(id: string, lang: SchemaLang = "en"): ResolvedTemplate {
  const found = templates.find((t) => t.id === id)
  if (!found) {
    throw new Error(`Unknown template id: "${id}"`)
  }
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    icon: found.icon,
    schema: found.schema[lang],
    purpose: found.purpose[lang],
    extraDirs: found.extraDirs[lang],
  }
}
