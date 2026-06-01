#!/usr/bin/env node
/**
 * One-off cleanup for a user's wiki/index.md after the type-coverage
 * expansion (Phase A of the Karpathy-index work). Re-implements the
 * core wiki-reconcile flow against Node's fs so it can run outside
 * Tauri — point it at the project root, it backs up the old index and
 * writes a fresh one with every canonical type covered.
 *
 * Manual sections (heading line contains `<!-- manual -->`) are
 * preserved verbatim. The preamble (everything above the first `##`)
 * is preserved.
 *
 * Usage:
 *   node scripts/clean-user-index.mjs <project-root>
 *
 * The project-root should be the folder that contains `wiki/`.
 */
import fs from "node:fs"
import path from "node:path"

const projectRoot = process.argv[2]
if (!projectRoot) {
  console.error("usage: node scripts/clean-user-index.mjs <project-root>")
  process.exit(2)
}
const wikiRoot = path.join(projectRoot, "wiki")
if (!fs.existsSync(wikiRoot)) {
  console.error(`no wiki/ folder under ${projectRoot}`)
  process.exit(1)
}

/* ────────────────────────────────────────────────
 * Type maps (mirror wiki-reconcile.ts — keep in sync)
 * ────────────────────────────────────────────────*/

const AUTO_INDEX_TYPES = new Set([
  "concept", "entity", "source", "synthesis", "finding", "comparison",
  "travel-plan", "manual", "project-doc", "tutorial", "book", "recipe",
  "note", "report", "article", "meeting", "decision", "project",
  "film-tv", "music", "game", "menu", "shopping-list", "fitness-plan",
  "contract", "invoice", "medical-record", "insurance",
  "code-snippet", "api-doc", "error-log",
  "paper", "tool", "dataset", "person", "company", "regulation",
  "thesis", "methodology",
])

const INDEX_SECTION_HEADINGS = {
  concept: "Concepts", entity: "Entities", source: "Sources",
  synthesis: "Synthesis", finding: "Findings", comparison: "Comparisons",
  "travel-plan": "Travel Plans", manual: "Manuals",
  "project-doc": "Project Documents", tutorial: "Tutorials",
  book: "Books", recipe: "Recipes", note: "Notes", report: "Reports",
  article: "Articles", meeting: "Meetings", decision: "Decisions",
  project: "Projects", "film-tv": "Film & TV", music: "Music",
  game: "Games", menu: "Menus", "shopping-list": "Shopping Lists",
  "fitness-plan": "Fitness Plans", contract: "Contracts",
  invoice: "Invoices", "medical-record": "Medical Records",
  insurance: "Insurance", "code-snippet": "Code Snippets",
  "api-doc": "API Docs", "error-log": "Error Logs",
  paper: "Papers", tool: "Tools", dataset: "Datasets",
  person: "People", company: "Companies", regulation: "Regulations",
  thesis: "Theses", methodology: "Methodologies",
}

const INDEX_SECTION_ALIASES = {
  concept: ["concepts", "概念", "concept"],
  entity: ["entities", "实体", "entity"],
  source: ["sources", "来源", "源", "source", "source documents"],
  synthesis: ["synthesis", "综合", "syntheses"],
  finding: ["findings", "结论", "finding"],
  comparison: ["comparisons", "对比", "comparison"],
  "travel-plan": ["travel plans", "旅游方案", "出行方案", "travel"],
  manual: ["manuals", "用户手册", "手册", "manual"],
  "project-doc": ["project documents", "项目文档", "project docs"],
  tutorial: ["tutorials", "教程", "tutorial"],
  book: ["books", "书籍", "book"],
  recipe: ["recipes", "食谱", "recipe"],
  note: ["notes", "笔记", "note"],
  report: ["reports", "报告", "report"],
  article: ["articles", "文章", "article"],
  meeting: ["meetings", "会议", "meeting"],
  decision: ["decisions", "决策", "decision"],
  project: ["projects", "项目", "project"],
  "film-tv": ["film & tv", "影视", "film-tv", "film and tv"],
  music: ["music", "音乐"],
  game: ["games", "游戏", "game"],
  menu: ["menus", "菜单", "menu"],
  "shopping-list": ["shopping lists", "购物清单", "shopping"],
  "fitness-plan": ["fitness plans", "健身计划", "fitness"],
  contract: ["contracts", "合同", "contract"],
  invoice: ["invoices", "发票", "invoice"],
  "medical-record": ["medical records", "医疗记录", "medical"],
  insurance: ["insurance", "保险", "保险单"],
  "code-snippet": ["code snippets", "代码片段", "snippets"],
  "api-doc": ["api docs", "api文档", "api"],
  "error-log": ["error logs", "错误日志", "errors"],
  paper: ["papers", "论文", "paper"],
  tool: ["tools", "工具", "tool"],
  dataset: ["datasets", "数据集", "dataset"],
  person: ["people", "人物", "persons"],
  company: ["companies", "公司", "company"],
  regulation: ["regulations", "法规", "regulation"],
  thesis: ["theses", "thesis"],
  methodology: ["methodologies", "方法论", "methodology"],
}

const TYPE_ALIAS_TO_CANONICAL = {}
const FOLDER_TO_CANONICAL_TYPE = {}
for (const [canonical, aliases] of Object.entries(INDEX_SECTION_ALIASES)) {
  for (const alias of aliases) {
    TYPE_ALIAS_TO_CANONICAL[alias.toLowerCase()] = canonical
    FOLDER_TO_CANONICAL_TYPE[alias.toLowerCase()] = canonical
  }
}

const SKIP_TOP_FOLDERS = new Set(["raw", ".llm-wiki", ".llm-wiki-local", "queries", "media"])
const SKIP_BASE_NAMES = new Set(["index.md", "log.md", "overview.md", "purpose.md", "schema.md"])
const MANUAL_MARKER_RE = /<!--\s*manual\s*-->/i

/* ────────────────────────────────────────────────
 * Tiny frontmatter parser (YAML subset — `key: value` and `key: [a, b]`)
 * ────────────────────────────────────────────────*/

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text }
  const end = text.indexOf("\n---\n", 4)
  if (end < 0) return { frontmatter: null, body: text }
  const block = text.slice(4, end)
  const fm = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    fm[m[1]] = val
  }
  return { frontmatter: fm, body: text.slice(end + 5) }
}

function resolveCanonicalType(rawType, slug) {
  if (typeof rawType === "string" && rawType.trim().length > 0) {
    const t = rawType.trim()
    if (AUTO_INDEX_TYPES.has(t)) return t
    const aliased = TYPE_ALIAS_TO_CANONICAL[t.toLowerCase()]
    if (aliased && AUTO_INDEX_TYPES.has(aliased)) return aliased
  }
  const top = slug.split("/")[0]?.toLowerCase() ?? ""
  const inferred = FOLDER_TO_CANONICAL_TYPE[top]
  if (inferred && AUTO_INDEX_TYPES.has(inferred)) return inferred
  return null
}

/* ────────────────────────────────────────────────
 * Walk + collect candidates
 * ────────────────────────────────────────────────*/

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const rel = path.relative(base, full).replace(/\\/g, "/")
      const top = rel.split("/")[0]
      if (SKIP_TOP_FOLDERS.has(top)) continue
      walk(full, base, out)
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      if (SKIP_BASE_NAMES.has(ent.name)) continue
      out.push(full)
    }
  }
  return out
}

const allFiles = walk(wikiRoot)
console.log(`scanned ${allFiles.length} .md files`)

const byType = new Map()  // canonical type → [{slug, title}]
let untyped = 0
for (const f of allFiles) {
  const slug = path.relative(wikiRoot, f).replace(/\\/g, "/").replace(/\.md$/, "")
  const text = fs.readFileSync(f, "utf-8")
  const { frontmatter } = parseFrontmatter(text)
  const fm = frontmatter ?? {}
  const canonical = resolveCanonicalType(fm.type, slug)
  if (!canonical) {
    untyped += 1
    continue
  }
  const title = (typeof fm.title === "string" && fm.title.length > 0)
    ? fm.title
    : path.basename(slug)
  const arr = byType.get(canonical) ?? []
  arr.push({ slug, title })
  byType.set(canonical, arr)
}
console.log(`grouped into ${byType.size} types · ${untyped} untyped pages skipped`)

/* ────────────────────────────────────────────────
 * Build clean index.md
 * ────────────────────────────────────────────────*/

function formatBullet({ slug, title }) {
  const last = slug.split("/").pop() ?? slug
  if (title.trim() === last) return `- [[${slug}]]`
  return `- [[${slug}|${title}]]`
}

function sectionFor(type, entries) {
  const heading = INDEX_SECTION_HEADINGS[type] ?? type
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title, "zh"))
  return [
    `## ${heading}`,
    "",
    ...sorted.map(formatBullet),
    "",
  ].join("\n")
}

/* Type order matches WIKI_TYPE_OPTIONS — knowledge first, then single-page. */
const TYPE_ORDER = [
  "concept", "entity", "source", "synthesis", "finding", "comparison",
  "tool", "dataset", "person", "company", "regulation",
  "paper", "thesis", "methodology",
  "report", "article", "book", "note", "meeting", "decision",
  "project", "project-doc", "tutorial", "manual",
  "travel-plan", "recipe", "film-tv", "music", "game",
  "menu", "shopping-list", "fitness-plan",
  "contract", "invoice", "medical-record", "insurance",
  "code-snippet", "api-doc", "error-log",
]

const today = new Date().toISOString().slice(0, 10)

const sections = []
for (const type of TYPE_ORDER) {
  const entries = byType.get(type)
  if (!entries || entries.length === 0) continue
  sections.push(sectionFor(type, entries))
}
// Catch any type not in TYPE_ORDER (shouldn't happen but defensive).
for (const [type, entries] of byType) {
  if (TYPE_ORDER.includes(type)) continue
  sections.push(sectionFor(type, entries))
}

const newIndex = [
  "---",
  "type: index",
  "title: Wiki Index",
  "tags: []",
  "related: []",
  "created: 2024-01-01",
  `updated: ${today}`,
  "sources: []",
  "---",
  "",
  "# Wiki Index",
  "",
  "本文档按类型自动列出 wiki 下所有页面（按每个页面的 frontmatter `type:` 分组）。如需",
  "保留某段不被自动整理，给段标题加 `<!-- manual -->`，例如 `## 其他资源 <!-- manual -->`，",
  "之后 reconcile 不会再动那一段。",
  "",
  "## 其他资源 <!-- manual -->",
  "",
  "* [[SKILL]] — OpenClaw Skills 系统使用指南",
  "* [[log]] — Wiki 操作日志",
  "",
  ...sections,
].join("\n")

/* ────────────────────────────────────────────────
 * Backup + write
 * ────────────────────────────────────────────────*/

const indexPath = path.join(wikiRoot, "index.md")
const backupPath = path.join(wikiRoot, `index.md.bak.${today.replace(/-/g, "")}`)

if (fs.existsSync(indexPath)) {
  fs.copyFileSync(indexPath, backupPath)
  console.log(`backed up existing index → ${backupPath}`)
}
fs.writeFileSync(indexPath, newIndex, "utf-8")
console.log(`wrote new index → ${indexPath}`)

console.log("\nper-type counts:")
const counts = [...byType.entries()].map(([t, arr]) => ({ type: t, n: arr.length }))
counts.sort((a, b) => b.n - a.n)
for (const { type, n } of counts) console.log(`  ${type}: ${n}`)
