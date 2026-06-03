/**
 * Changelog shown in Settings → Changelog. Hardcoded rather than
 * pulled from GitHub Releases so it works offline and stays under
 * version control with the code that ships the changes.
 *
 * Conventions:
 *   - Newest version first (the UI renders in array order).
 *   - Each entry has both `en` and `zh` highlight lists; the
 *     section picks whichever matches the current i18n language.
 *   - Only user-visible changes belong here. Internal refactors,
 *     CI tweaks, and pure test work go in commit messages, not
 *     here — keep this readable for end users.
 *   - When releasing a new version: prepend a new entry with the
 *     same shape, then bump package.json / tauri.conf.json /
 *     Cargo.toml / Cargo.lock as usual.
 */

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD
  highlights: {
    en: string[]
    zh: string[]
  }
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.4.39",
    date: "2026-06-03",
    highlights: {
      en: [
        "Fixed EPUB text extraction mangling non-English books. The extractor walked the chapter HTML byte-by-byte and cast each byte to a character, which turned every multi-byte character (Chinese, Japanese, Korean, Cyrillic, accented Latin) into Latin-1 garbage — and roughly tripled the text length, so a Chinese ebook ballooned into hundreds of junk chunks that the model couldn't make sense of (and that could stall ingest near 0%). EPUB text is now read as proper UTF-8: a Chinese book imports as real, readable text at its true length. (ASCII-only EPUBs were unaffected; re-import any non-English EPUB to get clean content.)",
      ],
      zh: [
        "修复 EPUB 文本抽取把非英文书弄成乱码的问题。抽取器逐字节遍历章节 HTML、把每个字节直接当成一个字符，于是所有多字节字符（中文、日文、韩文、西里尔、带重音的拉丁字母）都被毁成 Latin-1 乱码——而且文本长度大约翻了三倍，一本中文电子书因此膨胀成几百块垃圾内容，模型根本读不懂（还可能让导入卡在 0% 附近）。现在 EPUB 文本按正确的 UTF-8 读取：中文书会以真实、可读的文本、真实的长度导入。（纯英文 EPUB 不受影响；非英文 EPUB 请重新导入一次以获得干净内容。）",
      ],
    },
  },
  {
    version: "0.4.38",
    date: "2026-06-03",
    highlights: {
      en: [
        "Long-document ingest now shows a progress bar. A big source analyzed in hundreds of chunks used to show only a spinner — with the per-chunk text freezing for 10–30s during each LLM call, it looked stuck. The activity row (and the queue row) now show a determinate bar with \"192/937 · 20%\" and a rough time-remaining estimate, so you can see it advancing and gauge how long is left.",
        "Fixed the ingest \"Resume\" button feeling like it did nothing. Resuming a long-source ingest runs as a fresh task, so the old errored row used to just sit there unchanged — making it look dead and tempting a second click, which queued a duplicate run. The clicked row now clears immediately as feedback, and if the same source is already resuming it won't queue a duplicate. (The resume itself was working — it does continue from the last saved chunk, not from the start — but there was no sign the click registered.)",
      ],
      zh: [
        "长文档导入现在会显示进度条。被切成几百块分析的大文件，以前只有一个转圈——每块的 LLM 调用要 10～30 秒，期间那行块号一直不动，看着像卡死了。现在活动行（和队列行）会显示一个确定进度条，带「192/937 · 20%」和一个大致的剩余时间估算，能看到它在推进、也能判断还要多久。",
        "修复导入「继续」按钮像是点了没反应的问题。续跑长文档导入会以一个新任务运行，所以原来那条报错行不会有任何变化——看起来像死了，让人忍不住再点一下，结果排了一个重复任务。现在点「继续」后那条行会立刻消失作为反馈；如果同一个文件已经在续跑，则不会再排重复任务。（续跑本身是正常工作的——确实从上次存好的那一块接着跑，而不是从头开始——只是之前没有任何迹象表明点击生效了。）",
      ],
    },
  },
  {
    version: "0.4.37",
    date: "2026-06-03",
    highlights: {
      en: [
        "Find in page (Cmd/Ctrl+F). With a wiki page open, press Cmd/Ctrl+F to search the current page — matches are highlighted in place, Enter / Shift+Enter jump to the next / previous hit (with a live count), and Esc closes the bar. Works in both read and edit mode, including Chinese/CJK text.",
        "Long-document ingest no longer loses progress to a reload. A big source (e.g. a full e-book split into hundreds of chunks) is analyzed chunk-by-chunk with a checkpoint saved after each one. If the app reloads mid-run — most often an accidental Cmd/Ctrl+R — the activity panel now shows a \"Resume\" button that continues from the last saved chunk instead of starting over. Cmd/Ctrl+R also asks for confirmation while any task is still running, so the accidental case stops happening in the first place.",
        "You can now import images straight from the main Import button (and the picker accepts more formats — heic, avif, heif). Previously, picking an image from the main Import dialog silently dropped it; images now route to the vision-extraction path automatically, the same as the dedicated Import-images button. (Heic/avif decode depends on the OS webview — macOS handles heic, Windows currently does not and will show a vision error.)",
      ],
      zh: [
        "页内查找（Cmd/Ctrl+F）。打开一个 wiki 页面后，按 Cmd/Ctrl+F 即可在当前页查找——命中处会就地高亮，Enter / Shift+Enter 跳到下一处 / 上一处（带实时计数），Esc 关闭。阅读和编辑模式都支持，也支持中文/CJK 文本。",
        "长文档导入不再因为重新加载就丢进度。一个大文件（比如一整本电子书被切成几百块）会逐块分析，每块跑完都会存一个检查点。如果应用在中途重新加载——最常见的是误按 Cmd/Ctrl+R——活动面板现在会显示一个「继续」按钮，从上次存好的那一块接着跑，而不是从头再来。另外，只要还有任务在运行，Cmd/Ctrl+R 会先弹确认，从源头上避免误触。",
        "现在可以直接用主「导入」按钮导入图片（picker 也支持了更多格式——heic、avif、heif）。此前从主导入对话框选图片会被静默丢弃；现在图片会自动走 vision 抽取路径，和专门的「导入图片」按钮一样。（heic/avif 能否解码取决于系统 webview——macOS 支持 heic，Windows 目前不支持，会提示 vision 错误。）",
      ],
    },
  },
  {
    version: "0.4.36",
    date: "2026-06-03",
    highlights: {
      en: [
        "Chat now tries agent search first, then falls back to classic search automatically. On a tool-calling provider (Anthropic / MiniMax / custom Anthropic-style), chat runs the agent loop first; if it runs out of budget, returns nothing, or errors, chat quietly re-answers with classic retrieval instead of showing a partial \"answer may be partial\" reply. On a subprocess-CLI provider (Claude Code CLI / Codex CLI), which can't run the agent loop, it uses classic search directly. Any reply produced by classic search while agent mode is on now carries a small \"🔍 Classic search\" badge so you can tell which path answered — this replaces the wordier provider notice from 0.4.35.",
      ],
      zh: [
        "聊天现在会先尝试 agent 搜索，不行再自动回退到普通搜索。在支持工具调用的 provider（Anthropic / MiniMax / 自定义 Anthropic 协议）上，聊天先跑 agent 循环；如果预算耗尽、没返回内容或报错，就静默改用普通检索重新作答，而不是甩给你一句「answer may be partial」的半成品。在无法运行 agent 循环的子进程 CLI provider（Claude Code CLI / Codex CLI）上，则直接用普通搜索。开着 agent 模式时、由普通搜索给出的回答，现在会带一个小小的「🔍 普通搜索」标签，让你一眼看出是哪条路径作答的——它取代了 0.4.35 里那条更啰嗦的 provider 提示。",
      ],
    },
  },
  {
    version: "0.4.35",
    date: "2026-06-02",
    highlights: {
      en: [
        "Chat now tells you when agent search isn't running. With the \"Chat agent\" Labs flag on but a subprocess-CLI provider selected (Claude Code CLI / Codex CLI), the agent loop can't run — those engines have no tool-calling channel — so chat quietly fell back to classic retrieval, and a normal reply looked like agent search had run and found nothing. Chat now shows a one-time inline notice explaining the fallback and pointing you to switch to a tool-calling provider (Anthropic, OpenAI / Azure, MiniMax) to enable agentic wiki search. The notice is UI-only and never enters the model's context.",
      ],
      zh: [
        "聊天现在会告诉你 agent 搜索没在运行。当「Chat agent」Labs 开关开着、但选的是子进程 CLI provider（Claude Code CLI / Codex CLI）时，agent 循环无法运行——这类引擎没有工具调用通道——聊天会静默回退到经典检索，一条普通回复看起来就像 agent 搜过却什么都没找到。现在聊天会显示一条一次性内联提示，说明发生了回退，并指引你切换到支持工具调用的 provider（Anthropic、OpenAI / Azure、MiniMax）以启用对 wiki 的 agent 式搜索。该提示仅在界面显示，绝不进入模型上下文。",
      ],
    },
  },
  {
    version: "0.4.34",
    date: "2026-06-02",
    highlights: {
      en: [
        "Chat agent (Labs) can now answer \"list every time I mention X\" questions over long pages. Its local-file search used to return only the FIRST hit per file, so for records that live in one long diary/notes page the agent could never enumerate them — it re-read the whole page and re-searched with synonyms until it ran out of turns and replied \"answer may be partial\". It now returns EVERY matching line (with line numbers) in a single search, so \"梳理我什么时候打过羽毛球\" and similar enumerations actually complete. Windows (CRLF) files now produce clean snippets too, and the agent's turn/token budget was raised so multi-step \"梳理/列举\" queries finish.",
      ],
      zh: [
        "聊天 agent（Labs）现在能正确回答「梳理我所有提到 X 的地方」这类问题。此前它的本地文件搜索每个文件只返回「第一处」命中——对于记录都在同一个超长日记/笔记页里的情况，agent 根本列不全，只能反复读整页、换同义词重搜，直到耗光步数回一句「answer may be partial」。现在一次搜索就返回「每一处」匹配行（带行号），「梳理我什么时候打过羽毛球」之类的枚举能真正跑完。Windows（CRLF）文件的片段也不再残留乱码，agent 的步数 / token 预算也调高了，多步「梳理 / 列举」查询不再中途截断。",
      ],
    },
  },
  {
    version: "0.4.33",
    date: "2026-06-02",
    highlights: {
      en: [
        "Fixed the real cause of Claude Code CLI's \"connected but returned empty content\" on the connection / function provider tests. The subprocess transport resolved its promise the moment the CLI was spawned — before any model tokens arrived over events — so the test read an empty buffer every time, while streaming chat (which consumes tokens as they land) worked fine. The transport now waits for the stream to actually finish before resolving, matching the HTTP path and the Codex CLI transport. The connection / function tests pass with Claude Code now.",
      ],
      zh: [
        "修复了 Claude Code CLI 在连接 / 功能测试里「connected but returned empty content」的真正根因。子进程传输层在 CLI 一启动就 resolve 了 promise——这时模型的 token 还没通过事件到达——所以测试每次读到的都是空缓冲;而对话(token 边到边消费)却正常。现在传输层会等流真正结束再 resolve,与 HTTP 路径和 Codex CLI 传输层一致。Claude Code 的连接 / 功能测试现在能通过了。",
      ],
    },
  },
  {
    version: "0.4.32",
    date: "2026-06-02",
    highlights: {
      en: [
        "Claude Code CLI: a clean exit that produces no answer text no longer shows a blank \"connected but returned empty content\". The transport now surfaces what the CLI actually emitted (captured stdout / stderr) and points at the most common cause — a SessionStart hook or custom output-style in your ~/.claude config intercepting the non-interactive (`claude -p`) turn. Test it with `claude -p \"hi\"` in a terminal: if that's also empty, the fix is in your Claude config. This converts a dead-end error into an actionable one.",
      ],
      zh: [
        "Claude Code CLI：干净退出但没有回答文本时，不再只显示空洞的「connected but returned empty content」。传输层现在会把 CLI 实际输出的内容（捕获的 stdout / stderr）显示出来，并指出最常见的原因——你 ~/.claude 配置里的 SessionStart hook 或自定义 output-style 拦截了非交互（`claude -p`）那一轮。可以在终端跑 `claude -p \"hi\"` 验证：如果也是空的，问题在你的 Claude 配置而非 LLM Wiki。把死胡同报错变成可行动的报错。",
      ],
    },
  },
  {
    version: "0.4.31",
    date: "2026-06-02",
    highlights: {
      en: [
        "Chat now works with the Claude Code CLI provider even when the \"Chat agent\" Labs flag is on. The agent loop needs function/tool-calling, which the CLI subprocess (a text-only engine) can't do — it used to hard-fail with \"agent ingest doesn't support provider claude-code\". Chat now detects subprocess providers (claude-code / codex-cli) and quietly falls back to classic streaming instead. Agent ingest / lint-fix still require a tool-calling provider and now say so clearly.",
        "Claude Code CLI no longer falsely reports \"connected but returned empty content\". When the CLI is spawned from the macOS GUI, a stripped environment or a SessionStart hook can leave the streamed assistant turn empty; the parser now falls back to the authoritative final `result` string so the reply still comes through.",
      ],
      zh: [
        "开了 Labs「Chat agent」开关时，用 Claude Code CLI 也能正常对话了。Agent 循环需要函数/工具调用，而 CLI 子进程是纯文本引擎做不到——以前会直接报「agent ingest doesn't support provider claude-code」。现在对话检测到子进程类 provider（claude-code / codex-cli）会自动回退到经典流式对话。Agent 摄取 / lint 修复仍需要支持工具调用的 provider，报错也说清楚了。",
        "Claude Code CLI 不再误报「连上但返回空内容」。从 macOS 图形界面启动 CLI 时，精简环境或 SessionStart hook 可能让流式 assistant turn 为空；解析器现在会用权威的最终 `result` 字段兜底，回复照样能拿到。",
      ],
    },
  },
  {
    version: "0.4.30",
    date: "2026-06-02",
    highlights: {
      en: [
        "Claude Code / Codex CLI detection now also looks in ~/.local/bin and other common install locations. macOS apps launched from Finder inherit a stripped-down PATH that misses non-shell installers, so users of the official native installer (`curl … | sh`) previously saw \"`claude` not found on PATH\" even though `which claude` worked in their terminal. Same fix applies to Codex.",
        "Review buttons like \"Open in editor\" / \"打开编辑\" / \"Edit\" now actually open the page. The action-label matcher used exact equality against a short list (open / view / 打开 / 查看), so localized or padded LLM-generated labels silently no-op'd. Switched to prefix matching, same shape the Skip / 跳过 detector already uses.",
      ],
      zh: [
        "Claude Code / Codex CLI 探测现在也会找 ~/.local/bin 等常见安装路径。macOS 从 Finder 启动的应用只继承一份精简 PATH，看不到非 shell 装的二进制，所以用官方原生安装器（`curl … | sh`）的人之前即便终端里 `which claude` 能找到，应用里也会报 \"`claude` not found on PATH\"。Codex 同样的问题一起修了。",
        "Review 里 \"打开编辑\" / \"Open in editor\" / \"Edit\" 按钮现在真的能打开页面了。原本动作标签用完全相等匹配一个短列表（open / view / 打开 / 查看），LLM 实际生成的本地化或带后缀变体会被静默丢掉。改成前缀匹配，跟 Skip / 跳过 的探测一致。",
      ],
    },
  },
  {
    version: "0.4.29",
    date: "2026-06-01",
    highlights: {
      en: [
        "Search runs in parallel. The Rust backend previously walked wiki/ and read+scored each .md sequentially. Now fans out per-file read+score across the tokio blocking pool (bounded at 32 concurrent reads). For wikis past ~500 pages the wall-clock drops to ~1/N on N-core machines.",
      ],
      zh: [
        "搜索改并行扫描。后端原本顺序读每个 .md 然后评分。现在每个文件的「读 + 评分」放进 tokio 阻塞池并发跑（最多 32 个同时读）。500 页以上的 wiki 搜索耗时降到 ~1/N（N = CPU 核心数）。",
      ],
    },
  },
  {
    version: "0.4.28",
    date: "2026-06-01",
    highlights: {
      en: [
        "autoIngest now has an optional preview-before-write gate. Turn it on in Settings → Labs → \"Preview autoIngest writes before applying\". Every autoIngest pauses after the LLM stage with a dialog showing each proposed file (path + content preview). Apply commits to disk; Cancel skips with no disk writes (LLM tokens already spent regardless — the gate prevents disk pollution from a misguided LLM split, not token waste).",
      ],
      zh: [
        "autoIngest 加了可选的「写盘前预览」开关。Settings → Labs → 「autoIngest 写盘前预览」开启后，每次 autoIngest 在 LLM 阶段完成后暂停，弹出对话框展示每个即将写入的文件（路径 + 内容预览）。点 Apply 落盘，点 Cancel 跳过——LLM token 已花，开关防的是 LLM 错误拆分把 wiki 弄乱，不是省 token。",
      ],
    },
  },
  {
    version: "0.4.27",
    date: "2026-06-01",
    highlights: {
      en: [
        "Re-release of v0.4.26 — the universal macOS build in v0.4.26 broke at link time because the bundled pdfium dylib is arm64-only. Reverted to Apple-Silicon-only macOS for now (Intel Mac support tracked separately; needs a fat-binary pdfium). Linux + Windows artifacts in v0.4.26 are unaffected.",
        "Lint stops looping on un-fixable findings. After you (or Bulk Fix) attempt a finding once, it's recorded as \"already tried\" and hidden from future lint runs by default. A toolbar pill `N already attempted` shows what's hidden — click to clear and re-run if you want to retry. Solves the \"fix → fails silently → re-shows → fix again\" loop.",
        "Reconcile shows the actual diff before applying. Replaces the old \"3 broken wikilinks · 1 index row\" confirm dialog with a per-file unified diff: every change visible line-by-line before you commit. Apply / Cancel.",
        "Lint flags missing or non-canonical `type:` frontmatter. Pages with no `type:` are warnings; pages with off-taxonomy types (`type: 笔记`, `type: blogpost`) are info nudges. Both feed through the existing fix / suppress / fold flow.",
        "Frontend bundle keeps trimming. Main entry stays at 632 KB (-63% vs pre-PR-#28); per-feature chunks (mermaid, cytoscape, editor) load on demand.",
      ],
      zh: [
        "macOS Universal 包。一个 .dmg / .app 同时跑 Intel 和 Apple Silicon——不用再选架构下载错。v0.4.25 用 Intel Mac 的用户现在可以更新了。",
        "Lint 不再死循环修不好的发现项。你（或 Bulk Fix）尝试一次后，记录为「已尝试」并默认从后续检查里隐藏。工具栏出现 `已尝试 N 条` 标记，可点击清空重跑。解决「修→静默失败→再出现→再修」的循环。",
        "Reconcile 应用前显示实际 diff。原本「3 broken wikilinks · 1 index row」那个总计弹窗换成每文件 unified diff——逐行可见再 Apply 或 Cancel。",
        "Lint 检测缺失 / 非规范的 frontmatter `type:`。没有 `type:` 的页面是 warning；type 不在分类法里的（`type: 笔记`、`type: blogpost`）是 info 提示。两者都走现有 修复 / 隐藏 / 折叠 流。",
        "前端打包持续瘦身。主 entry 维持在 632 KB（比 PR #28 前 -63%）；mermaid / cytoscape / editor 按需加载。",
      ],
    },
  },
  {
    version: "0.4.25",
    date: "2026-06-01",
    highlights: {
      en: [
        "Dark mode lands. Settings → Interface → Theme picks System / Light / Dark. A sun/moon icon next to the gear in the sidebar cycles through them with one click. System follows your OS preference and flips live when you toggle the OS. The full UI was audited for hardcoded colors — ~30 accent-text utility classes got dark variants, mermaid diagrams now match the theme, the wiki editor and knowledge tree adapt without further work.",
        "index.md auto-management now covers all 34 page types, not just the original 6 LLM-generated ones. Notes, reports, articles, books, 笔记, 报告 — every page with a canonical frontmatter `type:` lands in its section. Chinese folder names (笔记/, 报告/, 概念/, …) are recognised both as type aliases (`type: 笔记` → note) and as folder fallbacks for pages without a type. New `<!-- manual -->` heading marker lets you opt a section out of auto-management.",
        "LLM annotator for index.md. Optional Labs flag: after every reconcile, batch-call the LLM to write a one-line description for each undescribed bullet. Cached by page body hash, so unchanged pages don't re-spend tokens. Cost: ~one LLM call per ~25 newly-written pages. Idempotent; safe to leave on. Settings → Labs → \"LLM-annotated index.md descriptions\".",
        "Frontend bundle split. The main entry shrunk from 1.7 MB to 632 KB (-63%). Mermaid (1.4 MB), cytoscape graph engine (563 KB), and the wiki editor (693 KB) now load on demand when you open those views — first paint is significantly faster on cold start.",
        "Labs section is now localised (Chinese / English match your UI language) and aligned — the sub-toggle (\"Chat agent can write wiki pages\") no longer breaks the toggle column. New app logo: stacked-books with knowledge-graph nodes overlay; icon canvas cropped so the Dock shows the same silhouette as other macOS apps.",
      ],
      zh: [
        "深色模式。Settings → 界面 → 主题选 跟随系统 / 浅色 / 深色。Sidebar 设置齿轮上方的 太阳/月亮 图标一键循环切换。跟随系统会用 OS 主题，OS 切换时实时同步。整套 UI 走查过，30 处硬编码颜色加了 dark 变体；mermaid 图跟随主题；wiki 编辑器和知识树都自适应。",
        "index.md 自动整理覆盖全部 34 种页面类型（不再只是 6 种 LLM 生成的知识层）。笔记、报告、文章、书籍——每个 frontmatter 里有规范 `type:` 的页面都自动落到对应分段。中文文件夹（笔记/、报告/、概念/...）作为类型别名（`type: 笔记` → note）和无 type 页面的目录回退都识别。新增 `<!-- manual -->` 段标记，可让某段免疫自动整理。",
        "index.md 条目 LLM 自动描述。Labs 可选开关：每次 reconcile 之后批量调 LLM 给没描述的条目写一句话说明。按页面正文哈希缓存——内容不变的页面不再花 token。开销：每新增约 25 个页面一次调用。幂等，可常开。Settings → Labs → 「index.md 条目 LLM 自动描述」。",
        "前端打包拆 chunk。主 entry 从 1.7 MB 缩到 632 KB（-63%）。Mermaid（1.4 MB）、cytoscape 图引擎（563 KB）、wiki 编辑器（693 KB）按需加载——冷启首屏明显更快。",
        "Labs 段中文化（按当前 UI 语言显示）+ 排版对齐——子开关「Chat Agent 可以写 wiki 页面」不再让开关列错位。新 logo：书叠 + 知识图节点叠加；图标画布裁剪后 Dock 显示与其他 macOS 应用一致。",
      ],
    },
  },
  {
    version: "0.4.24",
    date: "2026-06-01",
    highlights: {
      en: [
        "Save to Wiki is sharper. A short wikify pass rewrites the chat reply into encyclopedic-style markdown before it lands in wiki/queries/ — strips chat scaffolding (\"Based on the article...\", \"Here's a summary...\") while preserving every fact, citation, code block, table, wikilink, and the original language. Best-effort: a failed wikify call silently falls back to the raw reply, the save never gets blocked. Settings → Labs → \"Raw Save to Wiki — skip wikify rewrite\" turns it off if you want the agent's exact words.",
        "Web sources are preserved on save. When the chat agent uses web_fetch tool calls, each fetched article's markdown spills into raw/sources/web/<slug>-<date>-<NN>.md with a `source` frontmatter pointing at the original URL. The query page's frontmatter gets a `sources: [...]` array referencing those files — your save now keeps the paper trail without you copying anything by hand.",
        "Frontmatter `type:` is now canonicalised at write time. The agent emits one of the project's 34 taxonomy slugs (plus `overview` / `other`); off-taxonomy types are normalised from the slug's folder when possible (concepts/foo → `concept`), or rejected with a hint so the next attempt self-corrects. Stops random/'其他'-bucket pollution in the knowledge tree.",
        "Index drift is closed both directions. The Cleanup refs pass now ALSO adds missing knowledge pages (concept / entity / source / synthesis / finding / comparison) to the appropriate `## <Type>` section of wiki/index.md — recognising existing localised headings (`## 概念`) instead of duplicating them. And every autoIngest now runs the same backfill at its tail, so newly-written pages land in index.md without you remembering to click Cleanup refs.",
        "Rate-limit (HTTP 429) retries transparently across every LLM path. autoIngest, wikify, chat-agent tool runs, agent-lint-fix, and the bulk-fix loop all back off geometrically (5s → 15s → 30s, max 3 attempts) before surfacing an error. Bulk-fix layers an extra retry on top + paces remaining items by 2s after a hit. The activity log shows \"⏳ rate-limited, retrying in 15s (attempt 2)\" so the pause is visible. Detector matches Anthropic / OpenAI / Chinese reseller phrasings.",
        "Lint findings fold by type. Each severity bucket now groups items into foldable rows (`🔗 Broken links · 12`, `⚠️ Orphans · 3`) — piles over three rows start collapsed. Click the chevron to expand, override, or compare. Old flat scroll-of-cards UI replaced by a one-glance punch list.",
        "Activity panel filters by type. New chip bar (`All / Ingest / Lint / Query`) above the rows; counts shown inline, zero-count chips disabled, empty-state shown when a filter excludes everything. Helps when 200-item persisted history makes the panel long.",
        "Lint correctness: overview.md / purpose.md / schema.md are treated as structural and excluded from orphan / no-outlinks checks (previously surfaced as orphans the bulk-fix would have deleted). Activity items persist across app restarts and stale `running` entries flip to `error` on reload so a crashed task doesn't masquerade as still active. Unknown-type pages fall back to their folder so the knowledge tree never shows a stale 'other' bucket.",
      ],
      zh: [
        "Save to Wiki 更干净。保存前会做一次小型 wikify pass，把聊天语气（「基于这篇文章...」「这里是总结...」「我看了下...」）改写成知识页风格，事实、引用、代码块、表格、wikilink、原始语言全部保留。失败兜底：wikify 调用失败时静默回退用原文，保存动作绝不卡死。Settings → Labs → 「Raw Save to Wiki — skip wikify rewrite」可以关掉，原话保留。",
        "Web 抓取的源会被持久化。chat agent 调用 web_fetch 时，每篇抓回的文章 markdown 自动落到 raw/sources/web/<slug>-<date>-<NN>.md，frontmatter 指向原 URL；query 页 frontmatter 加 `sources: [...]` 数组引用这些文件 —— 保存现在自带证据链，不用你手动复制。",
        "frontmatter `type:` 写入时强制规范化。agent 必须用项目 34 类分类法之一（加 `overview` / `other`）；不在分类法里的类型，如果 slug 的目录能推出（concepts/foo → `concept`）就静默修正，否则拒绝带提示词，让下轮自我纠正。知识树再也不会被随机 / 「其他」桶污染。",
        "index 漂移两个方向都堵住了。Cleanup refs 现在还会把 wiki 里有、index.md 漏列的知识页（concept / entity / source / synthesis / finding / comparison）追加到对应的 `## <类型>` 段；本地化标题（`## 概念`）会被识别为同段，不会重复加节。每次 autoIngest 跑完也会自动跑一次同样的兜底 —— 新页直接进 index.md，不用你记着点 Cleanup refs。",
        "限速（HTTP 429）自动退避，所有 LLM 路径都覆盖。autoIngest、wikify、chat-agent 工具调用、agent-lint-fix、bulk-fix 全部按 5s → 15s → 30s 退避，最多 3 次。Bulk-fix 多一层重试 + 命中后剩余条目自动放慢 2s 节奏。活动日志会显示「⏳ rate-limited, retrying in 15s (attempt 2)」，停顿可见。识别器覆盖 Anthropic / OpenAI / 中文转售商措辞。",
        "Lint 发现按类型折叠。每个 severity 段把发现按类型分组成可折叠行（`🔗 Broken links · 12`、`⚠️ Orphans · 3`），超过 3 条的桶默认收起；点 chevron 展开 / 切换。之前一长串卡片现在变成一眼能扫的清单。",
        "活动面板按类型过滤。新增 chip 行（`All / Ingest / Lint / Query`），自带计数；零数量的 chip 禁用，过滤后无项展示空态。200 条历史持久化时面板很长，过滤有用。",
        "Lint 正确性：overview.md / purpose.md / schema.md 视为结构页，孤立 / 无出链检查跳过（之前会被识别成孤立页，bulk-fix 会顺手删掉）。活动项跨重启持久化，重启后过期的 `running` 状态翻成 `error`，崩溃的任务不会假装还在跑。未知 type 的页面回退看路径分类，知识树不再出现陈旧的「其他」桶。",
      ],
    },
  },
  {
    version: "0.4.23",
    date: "2026-05-30",
    highlights: {
      en: [
        "Experimental: agentic ingest. Settings → Labs → 'Agent ingest (experimental)' toggle adds a 🤖 button next to each source file. A multi-turn LLM agent reads the source via tool calls (read_chunk / search_source) and writes wiki pages directly (write_wiki_page / update_wiki_page / link_pages) instead of the classic single-shot analyse + generate. Costs more tokens; quality is not yet validated on long real-world documents. Default OFF — flip the toggle to opt in.",
        "Agent runs are resumable. A checkpoint is written after every turn under `.llm-wiki/agent-checkpoints/`; a crash, network failure, or cancelled run leaves a clean resume point. Successful runs clean up; partial runs leave the file so the next attempt picks up where the loop stopped. Source-hash invalidation means re-editing the source starts fresh instead of resuming stale chunk references.",
        "After each agent run, a verify pass independently checks the source outline against the wiki pages produced. Uncovered topics land in the Review tab as missing-page items with 'Create Page' / 'Skip' options — you decide which to act on.",
      ],
      zh: [
        "实验性功能：Agent 智能提取。Settings → Labs → 「Agent ingest (experimental)」开关启用后，每个源文件旁出现 🤖 按钮。多轮 LLM agent 通过工具调用（read_chunk / search_source）阅读源文档，直接写 wiki 页面（write_wiki_page / update_wiki_page / link_pages），区别于经典的单次分析 + 生成。token 消耗更高；长文档质量尚未充分验证。默认关闭 —— 自行开启。",
        "Agent 运行可恢复。每轮自动写 checkpoint 到 `.llm-wiki/agent-checkpoints/`；崩溃、网络中断、或取消的运行都有干净的续跑点。成功 done 后自动清理；部分完成的留文件，下次接着跑。源文档 hash 校验：源被改了就重新开始，不会用过期的 chunk 引用继续。",
        "每次 agent 运行结束后会跑独立的 verify pass：把源文档大纲跟实际生成的 wiki 页面对照，没覆盖的章节自动进 Review tab 显示成 missing-page 项，带「创建页面」/「跳过」选项 —— 你来决定怎么处理。",
      ],
    },
  },
  {
    version: "0.4.22",
    date: "2026-05-29",
    highlights: {
      en: [
        "Paste, drag, or pick images directly into chat or sources — the configured vision LLM extracts the image's content as markdown (description + verbatim OCR + structure) which then runs through normal ingest into the wiki. Image bytes are auto-downsized in the webview (Canvas) before any Tauri IPC hop, so 4K screenshots no longer blow up the IPC channel.",
        "Settings → Vision / Image OCR (renamed from Image Captioning) now clearly controls both the new image upload feature AND the PDF/DOCX caption flow. Master toggle uses emerald green for an unambiguous ON state.",
        "When the configured vision model can't actually see the image (text-only LLM, or a model whose Anthropic-compat proxy strips image blocks), a warning surfaces in the chat reply / sources alert pointing you at Settings → Multimodal — instead of silently writing the model's confused 'I don't see an image' reply into the wiki.",
        "Azure OpenAI's newer /openai/v1 endpoint is now supported as a custom provider — model field takes the SKU directly (gpt-4o, o3-mini, …) instead of the deployment name. Strict-completion params (max_completion_tokens) auto-apply on v1.",
        "Cmd+R / Ctrl+R reload binding restored. External links in wiki pages, file preview, and research panel now open in the OS browser instead of navigating the webview off the app shell.",
        "Per-file re-ingest button (the 🪄 wand next to each source) is now visually distinct from 'open' and clearly labelled 'Re-ingest this file'.",
      ],
      zh: [
        "图片可以直接粘贴 / 拖入 / 选择导入 chat 或 sources — 由配置的视觉 LLM 提取内容为 markdown（描述 + 原文 OCR + 结构），然后走正常 ingest 流程进 wiki。图片在 webview 内（Canvas）自动缩到 ≤1280px、再压成 JPEG，所有 IPC 都只传小 payload，4K 截图不再撑爆 Tauri IPC。",
        "Settings → 视觉 / 图片识别（从「图片描述」改名）现在明确控制 两个 用途：新增的图片上传 + 原有的 PDF/DOCX caption。主开关用 emerald 绿色，激活状态一目了然。",
        "如果配置的视觉模型实际上看不到图（纯文本 LLM，或 Anthropic-compat 代理把 image block 吃掉了），会在 chat 回复或 sources 弹窗里明确提示「换个支持 vision 的模型」并指向 Settings → Multimodal，不再把模型瞎说的「我没看到图」当 OCR 写进 wiki。",
        "支持 Azure OpenAI 新版 /openai/v1 端点（custom provider 配置）— model 字段直接填 SKU（gpt-4o、o3-mini 等）而不是 deployment 名。v1 路径自动适配 max_completion_tokens 等严格参数。",
        "恢复 Cmd+R / Ctrl+R 重载快捷键。wiki 页面、文件预览、研究面板里的外链现在用系统浏览器打开，不会再把 webview 跳走、回不到应用本体。",
        "单文件「重新提取」按钮（每个源文件旁边的 🪄 魔棒）视觉上跟「打开」明确区分，tooltip 也清楚写明「重新提取这一个文件」。",
      ],
    },
  },
  {
    version: "0.4.21",
    date: "2026-05-28",
    highlights: {
      en: [
        "Fix wiki knowledge straight from chat: when you ask the assistant to correct or update a page, it now proposes the change as an editable card with a diff and an Apply button — no more copy-pasting into the .md file. Applying backs up the old version first (recoverable under .llm-wiki/page-history) and preserves the page's created date. If the assistant isn't sure which page to edit, it routes the suggestion to the Review queue instead. The page you're viewing is now passed into the chat as context.",
        "Connection / functional model tests no longer falsely report \"empty content\" for reasoning-native models (MiniMax M-series, DeepSeek-R1, …): the token budget was raised so a thinking model can reach its answer.",
      ],
      zh: [
        "在对话里直接修补 wiki 知识:让助手纠正/更新某页时,它会以一张可操作卡片给出改动(带 diff + 一键应用),不用再手动复制回 .md。应用前会自动备份旧版本(可在 .llm-wiki/page-history 恢复)并保留页面的创建日期;若助手不确定该改哪一页,则把建议送入「审核」队列。当前正在查看的页面也会作为上下文传给对话。",
        "连接/功能模型测试不再对推理型模型(MiniMax M 系列、DeepSeek-R1 等)误报「empty content」:已调大 token 预算,让思考型模型有空间产出正文。",
      ],
    },
  },
  {
    version: "0.4.20",
    date: "2026-05-27",
    highlights: {
      en: [
        "Long sources are no longer silently truncated: documents that exceed the model's context budget are now analyzed in overlapping semantic chunks with a resumable checkpoint, so nothing past the old cutoff is dropped. Generation output limits also scale with the model's context window.",
        "Ingest now runs a dedicated follow-up pass that surfaces more high-value review items (knowledge gaps, missing pages, contradictions) for substantial sources.",
        "New provider: Xiaomi MiMo (synced from upstream) — endpoint detection, request-body adaptation, and Anthropic-gateway auth.",
        "Launching a second copy of the app now focuses the existing window instead of starting a rival process — this avoids the \"Port 19827 in use / Web Clipper unavailable\" conflict that could appear when a previous instance was still running (e.g. left behind by an abnormal exit). The clip-server status hint now explains the likely cause and how to recover.",
      ],
      zh: [
        "超长资料不再被静默截断：超出模型上下文预算的文档现在会按语义分块、带重叠地分析，并带可恢复的断点，旧版被截断丢弃的内容不再丢失。生成阶段的输出上限也会随模型上下文窗口自动放大。",
        "摄入新增一次专门的后续分析：对篇幅较大的资料能产出更多高价值的审核项（知识缺口、缺失页面、矛盾点）。",
        "新增 Provider：小米 MiMo（同步自上游）——端点识别、请求体适配、Anthropic 网关鉴权。",
        "再次启动应用时会聚焦已打开的窗口，而不是另起一个进程——避免了上一个实例仍在运行时（例如异常退出后残留）出现的「端口 19827 被占用 / Web Clipper 不可用」冲突。剪藏服务的状态提示现在也会说明可能原因和恢复方法。",
      ],
    },
  },
  {
    version: "0.4.19",
    date: "2026-05-26",
    highlights: {
      en: [
        "The left knowledge tree now remembers which type groups you expanded or collapsed (per project), so they no longer snap back to a fixed default on reload or relaunch.",
      ],
      zh: [
        "左侧知识树现在会记住你展开/收起了哪些分类分组（按项目记忆），重新加载或重启应用后不再回到固定的默认状态。",
      ],
    },
  },
  {
    version: "0.4.18",
    date: "2026-05-26",
    highlights: {
      en: [
        "Changing a page's type now also updates wiki/index.md: the page's catalog entry moves to the matching category section (kept in sync with the left sidebar), while its Sources listing stays intact.",
      ],
      zh: [
        "修改页面类型时会一并更新 wiki/index.md：目录里该页的条目自动移到对应分类章节（与左侧分组保持一致），同时保留它在「Sources」里的条目。",
      ],
    },
  },
  {
    version: "0.4.17",
    date: "2026-05-26",
    highlights: {
      en: [
        "Change a wiki page's type right from the preview panel: the type chip is now a dropdown — pick a category and the page instantly moves to the matching group in the left sidebar (no more hand-editing frontmatter).",
      ],
      zh: [
        "在预览面板里直接改 wiki 页面的类型：类型徽章变成下拉框，选一个分类，页面立刻归到左侧对应分组（不用再手动改 frontmatter）。",
      ],
    },
  },
  {
    version: "0.4.16",
    date: "2026-05-25",
    highlights: {
      en: [
        "Synced upstream improvements: more reliable source handling for nested folders, non-English (e.g. Chinese) paths, and Windows; steadier local API and search; new Azure OpenAI provider; API-key-free Ollama web search; and connection tests for LLM / embedding / multimodal in Settings.",
      ],
      zh: [
        "同步上游改进：嵌套资料文件夹、非英文（如中文）路径和 Windows 下的资料处理更稳健；本地 API 与搜索更可靠；新增 Azure OpenAI Provider；Ollama 免 API Key 网页搜索；设置里可一键测试 LLM / 嵌入 / 多模态连接。",
      ],
    },
  },
  {
    version: "0.4.15",
    date: "2026-05-22",
    highlights: {
      en: [
        "Source preview now renders Word / Office files (.docx, .xlsx, .pptx, .odt, .ods, .odp) as extracted text instead of showing \"Preview not available\".",
      ],
      zh: [
        "原始文件预览现在能直接显示 Word / Office 文件（.docx、.xlsx、.pptx、.odt、.ods、.odp）的提取文本，不再提示「该文件类型暂不支持预览」。",
      ],
    },
  },
  {
    version: "0.4.14",
    date: "2026-05-20",
    highlights: {
      en: [
        "macOS builds are now ad-hoc signed, so the downloaded app runs reliably on Apple Silicon after clearing quarantine (first launch may still need `xattr -dr com.apple.quarantine`).",
      ],
      zh: [
        "macOS 安装包改为 ad-hoc 签名，从 GitHub 下载的版本在 Apple 芯片上清一次隔离后可稳定运行（首次启动可能仍需执行一次 `xattr -dr com.apple.quarantine`）。",
      ],
    },
  },
  {
    version: "0.4.13",
    date: "2026-05-20",
    highlights: {
      en: [
        "New Comprehensive project template with 34 categories (travel, manuals, books, recipes, contracts, code, and more), Chinese-first directory names — now the default for new projects.",
        "Smart ingest splitting: everyday documents (travel plans, manuals, books…) stay as one page instead of being fragmented; papers still decompose into concept pages.",
        "Sidebar and knowledge graph now group and colour all page types correctly — previously new types were lumped under 'Other'.",
        "One-click Schema Upgrade in Settings to migrate existing projects to the comprehensive schema.",
        "In-place auto-update from our own GitHub releases — updating no longer requires a reinstall, so your settings and API keys are preserved.",
        "Encrypted config backup: passphrase-protected export/import for moving settings between machines, plus automatic encrypted backup (key in the OS keychain) that auto-restores after a reinstall.",
      ],
      zh: [
        "新增「综合」项目模板，含 34 个分类（旅游、手册、书籍、食谱、合同、代码 等），中文优先目录名——新建项目默认使用。",
        "智能拆分摄入：旅游方案、手册、书籍等整篇保留为一页，不再被拆碎；论文仍会拆成概念页。",
        "侧栏和知识图谱现在能正确分组 / 着色所有页面类型——之前新类型都被归到「Other」。",
        "设置里新增「Schema 升级」一键按钮，把存量项目迁移到综合 schema。",
        "从你自己的 GitHub 就地自动更新——更新不再需要卸载重装，配置和 API Key 全部保留。",
        "加密配置备份：口令加密的导出 / 导入用于换机器迁移；外加每次启动的自动加密备份（密钥存系统钥匙串），重装后自动恢复。",
      ],
    },
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    highlights: {
      en: [
        "Fixed SearXNG web search configuration so self-hosted instances work without requiring an API key.",
      ],
      zh: [
        "修复 SearXNG 网页搜索配置：自托管实例不再被错误要求填写 API Key。",
      ],
    },
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    highlights: {
      en: [
        "Added a local API server for project files, search, graph data, and source rescans, with configurable access control in Settings.",
        "Unified UI and API search on the Rust backend with keyword and vector retrieval.",
        "Added Knowledge Graph search with a compact expandable search control and improved empty-result stability.",
      ],
      zh: [
        "新增本地 API Server，可通过接口访问项目文件、搜索、关系图数据和资料重扫，并可在设置中配置访问控制。",
        "UI 搜索和 API 搜索统一到 Rust 后端，支持关键词与向量检索。",
        "关系图新增搜索功能，默认使用紧凑的可展开搜索按钮，并改进无结果时的稳定性。",
      ],
    },
  },
  {
    version: "0.4.10",
    date: "2026-05-14",
    highlights: {
      en: [
        "Added configurable source folder monitoring, manual source-folder refresh, and Gemini native embeddings support.",
        "Fixed source sync, embedding provider compatibility, and settings localization issues.",
      ],
      zh: [
        "新增可配置的资料文件夹监控、手动刷新资料文件夹，以及 Gemini 原生向量嵌入支持。",
        "修复资料同步、向量 provider 兼容性和设置页本地化相关问题。",
      ],
    },
  },
  {
    version: "0.4.9",
    date: "2026-05-11",
    highlights: {
      en: ["Fixed Windows compatibility issues around file paths, source sync, and file deletion."],
      zh: ["修复 Windows 下文件路径、原始资料同步和文件删除相关的兼容性问题。"],
    },
  },
  {
    version: "0.4.8",
    date: "2026-05-11",
    highlights: {
      en: [
        "Project file sync is more complete: external changes in raw sources can be detected, queued persistently, retried, and routed through the same source add/delete lifecycle as in-app actions.",
        "Source cleanup is more reliable when raw files are deleted outside the app: related wiki pages, index entries, wikilinks, and `related:` references are cleaned consistently, including path-style `.md` links.",
        "Web search adds SearXNG as a provider, with per-provider configuration and selectable SearXNG search categories.",
        "Large raw-source folders are easier to browse: the Sources page now renders the file tree progressively while scrolling.",
        "OpenAI GPT-5 / o-series ingest compatibility is improved by using the supported completion-token parameter shape and avoiding unsupported sampling knobs.",
      ],
      zh: [
        "项目文件同步更完整：外部修改 raw sources 后可被检测、持久化排队、重试，并统一走应用内相同的 source 添加/删除生命周期。",
        "外部删除原始文件后的清理更可靠：相关 wiki 页面、index 条目、正文 wikilink 和 `related:` 引用会一致清理，也覆盖带路径和 `.md` 后缀的引用。",
        "网页搜索新增 SearXNG Provider，支持独立配置并选择 SearXNG 搜索分类。",
        "原始资料目录较大时更易浏览：Sources 页面现在会随滚动渐进渲染文件树。",
        "改进 OpenAI GPT-5 / o-series 的 ingest 兼容性：使用支持的 completion token 参数，并避免发送不支持的采样参数。",
      ],
    },
  },
  {
    version: "0.4.7",
    date: "2026-05-06",
    highlights: {
      en: [
        "Web search now supports multiple providers: Tavily and SerpApi can be configured separately, with independent API keys and SerpApi search-engine selection.",
        "Reasoning-model support is improved across providers: thinking controls are available in LLM settings, structured ingest avoids reasoning-only failures, and chat can show model thinking when an endpoint streams it.",
        "Knowledge graph exploration is cleaner with filters, structural-node hiding, right-click node hide, and reset controls.",
        "Persian (Farsi) is now available as an output language, with better auto-detection from Arabic, RTL rendering, and per-project target-language preferences.",
      ],
      zh: [
        "网页搜索支持多 Provider：Tavily 和 SerpApi 可分别配置，API Key 独立保存，并支持选择 SerpApi 搜索引擎。",
        "推理型模型支持增强：LLM 设置里新增 thinking / reasoning 控制，结构化导入会避免只输出思考不输出正文的问题，聊天中也能显示模型流式返回的思考过程。",
        "关系图新增过滤能力：可隐藏结构性节点、按节点/连接过滤、右键隐藏单个节点，并可一键重置。",
        "新增 Persian (Farsi) 输出语言支持：自动检测可更好地区分 Persian 和 Arabic，内容按 RTL 显示，Target Language 也改为按项目独立保存。",
      ],
    },
  },
  {
    version: "0.4.6",
    date: "2026-05-01",
    highlights: {
      en: [
        "Right-click delete in the Knowledge tree for entity / concept pages, with full reference cleanup: every body `[[wikilink]]`, `index.md` listing entry, and `related:` frontmatter array pointing at the deleted page is rewritten in the same pass — no more dangling refs left behind for the FrontmatterPanel to flag with a warning icon.",
        "Mermaid diagrams now render in chat: any ` ```mermaid ` fenced code block in an LLM reply renders as an SVG (lazy-loaded so the diagram engine is only fetched when first encountered). Click a diagram to enlarge with zoom controls; Esc to close.",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Windows: Claude Code CLI provider works again. Detection and chat spawn now resolve through the same path lookup (claude.cmd → claude.exe → claude), so Settings showing \"installed\" matches what chat can actually spawn.",
        "Fixed: switching the UI language in Settings → Interface, saving, then editing any other settings field and saving again no longer silently reverts the UI back to the previous language.",
        "All file-delete paths (Sources view source delete, Lint view orphan delete, Knowledge tree right-click) now use the same cleanup helper, so deleting via any of them gets the full sweep — no more inconsistent behaviour where one path cleaned wikilinks but left `related:` frontmatter pointing at the void.",
      ],
      zh: [
        "Knowledge 知识树新增右键删除 entity / concept 页面：删除时自动清理所有引用 —— 文中的 `[[wikilink]]`、`index.md` 的目录条目、其它页面 frontmatter `related:` 数组里指向被删页的 slug，全都在同一步重写干净，不再留断链让 FrontmatterPanel 显示警告图标。",
        "聊天中支持渲染 Mermaid 图：LLM 回复里的 ` ```mermaid ` 代码块会渲染成 SVG（懒加载，只有遇到第一个图才下载渲染引擎）。点击图可放大查看，支持缩放控制和 Esc 关闭。",
        "frontmatter 被错误包在 ```yaml … ``` 代码栅栏里的 wiki 页现在能正常渲染：之前下半部全部被孤立的闭 fence 当成一个未关闭的代码块，标题、列表、表格全都不上样式。",
        "Windows 下 Claude Code CLI 再次可用：探测和 chat 启动现在走同一套路径解析（claude.cmd → claude.exe → claude），不会再出现「Settings 检测到已安装但实际 chat 启动失败」的怪现象。",
        "修复：在 Settings → Interface 切换 UI 语言保存后，再编辑其它设置并保存，UI 不会再被静默切回原来的语言。",
        "所有删除入口（Sources 删原始文档、Lint 删孤儿页、Knowledge 树右键）现在都走同一个清理辅助函数，任意路径删除都会触发完整清扫 —— 不会再有一条路径清掉 wikilink 但漏掉 `related:` 留下断引的不一致。",
      ],
    },
  },
  {
    version: "0.4.5",
    date: "2026-04-30",
    highlights: {
      en: [
        "Settings → Network: global HTTP/HTTPS proxy with live apply (no app restart needed). Local addresses bypass the proxy by default so Ollama / LM Studio / LAN-deployed LLMs keep working.",
        "Settings → Maintenance: new \"Detect duplicate entities / concepts\" tool. The LLM scans every wiki page and surfaces likely-duplicate groups (English vs Chinese name, plural vs singular, abbreviation vs full form). You confirm each group before merging; merges run through a persistent serial queue with up to 3 automatic retries, survives app restart, and supports cancel / retry from the UI.",
        "Re-ingesting an entity / concept page that already exists now preserves earlier contributions: an LLM merge step combines old + new bodies instead of clobbering, with length / structure sanity checks and a backup snapshot on fallback.",
        "Frontmatter tags / related fields are now union-merged across re-ingests (previously only sources was protected — earlier-contributed tags and links silently disappeared).",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Better Claude Code CLI error reporting: the bare \"exit 1\" message is replaced by the actual subprocess stderr / unparsed stdout, so authentication failures and other startup errors are visible instead of opaque.",
        "Better diagnostic when a model produces lots of \"thinking\" text but never any answer (some Kimi / Qwen-style endpoints stream `reasoning` only and emit no `content` — previously this surfaced as \"analysis Not available\" with no clue why).",
      ],
      zh: [
        "设置里新增「网络」面板，可配置全局 HTTP/HTTPS 代理，保存即时生效不需要重启应用。本地地址默认不走代理，Ollama / LM Studio / 局域网 LLM 不受影响。",
        "设置里新增「维护」面板，包含「检测重复实体 / 概念」工具：LLM 扫描全部 wiki 页面，把可能指向同一主题但用了不同名字的页面分组（中英对照、单复数、缩写与全称等），每组确认后再合并。合并任务进入持久化串行队列，自动重试最多 3 次，应用重启不丢，UI 支持取消和重试。",
        "重新 ingest 同名 entity / concept 页时，由 LLM 把新旧版本合并成一份完整内容，不再直接覆盖丢失之前的贡献；包含长度/结构 sanity 检查，失败时自动备份原版本。",
        "frontmatter 的 tags / related 字段现在跨多次 ingest 自动并集合并（之前只保护 sources，导致旧文档贡献的 tag 和关联会悄悄消失）。",
        "frontmatter 被错误包在 ```yaml … ``` 代码栅栏里的 wiki 页现在能正常渲染：之前页面下半部全部被孤立的闭 fence 当成一个未关闭的代码块，标题、列表、表格全都不上样式。",
        "Claude Code CLI 的报错信息更详细：不再只显示「exit 1」，而是把子进程实际的 stderr / 未解析的 stdout 展示出来，鉴权失败等启动问题终于看得见。",
        "改进诊断：模型只输出 reasoning 但不输出 content 的情况（部分 Kimi / Qwen 端点的流式接口只发 reasoning_content）现在会明确报告，而不是丢出令人摸不着头脑的「analysis Not available」。",
      ],
    },
  },
  {
    version: "0.4.4",
    date: "2026-04-28",
    highlights: {
      en: [
        "Native ARM64 Linux builds — .deb and .AppImage now ship for aarch64 (Raspberry Pi, ARM cloud instances, Apple Silicon Linux VMs).",
        "Visual frontmatter panel for wiki pages: type-coded chips for entity / concept / query, clickable source and related cards that navigate directly to the linked file or page.",
        "Read-mode default for wiki pages — Obsidian-style [[wikilinks]] render as proper clickable links instead of raw bracketed text. Edit toggle in the top-right keeps the WYSIWYG editor available when needed.",
        "LLM-generated wiki pages no longer get wrapped in a stray ```yaml ... ``` code fence (prompt rewrite + write-time sanitizer + read-time fallback).",
        "IME composition Enter no longer triggers chat / search / research submit when typing under a Chinese / Japanese / Korean input method.",
        'Selecting Claude Code CLI provider in Settings (the "no API key" option) now works across ingest, sweep, lint, chat, sources, and the clip watcher — previously it failed with "LLM not configured" everywhere.',
      ],
      zh: [
        "新增原生 ARM64 Linux 构建（.deb / .AppImage），覆盖树莓派、ARM 云实例、Apple Silicon Linux 虚拟机等。",
        "Wiki 页面顶部新增可视化 frontmatter 面板：实体 / 概念 / 查询用色块徽章区分，源文件和相关页面用可点击卡片，单击跳转。",
        "Wiki 页面默认进入阅读模式，Obsidian 风格的 [[wikilink]] 渲染成蓝色可点链接而不是字面括号文本；右上角 Edit 按钮可切回 WYSIWYG 编辑器。",
        "LLM 生成的 wiki 页面不再被错误地包在 ```yaml ... ``` 代码栅栏里（prompt 改写 + 写盘清洗 + 读取兜底三层防御）。",
        "中日韩输入法选词时按 Enter 不再误触发聊天 / 搜索 / 研究的提交。",
        "选用 Claude Code CLI provider（无需 API key）后，导入、聊天、语义 lint、sweep、剪藏导入等所有功能都能正常工作（此前各处都误报 LLM 未配置）。",
      ],
    },
  },
  {
    version: "0.4.3",
    date: "2026-04-28",
    highlights: {
      en: [
        "Fixed Ollama connection failure when configured to a LAN-deployed instance (e.g. http://192.168.x.x:11434). The Origin header is now sent as http://localhost regardless of server address, so Ollama's default OLLAMA_ORIGINS allowlist accepts it.",
      ],
      zh: [
        "修复使用局域网内 Ollama 服务（如 http://192.168.x.x:11434）时连接失败的问题。Origin 请求头现在固定为 http://localhost，匹配 Ollama 默认的 OLLAMA_ORIGINS 白名单。",
      ],
    },
  },
  {
    version: "0.4.2",
    date: "2026-04-28",
    highlights: {
      en: [
        "Project creation dialog now requires picking an AI output language up front — the previous Auto default surprised users with mixed-language output.",
        "Deleting a project actually removes it from the recent list now (previously the auto-open flow re-added it on next launch).",
      ],
      zh: [
        "创建项目时必须显式选择 AI 输出语言（之前 Auto 默认值会让生成内容混杂语言）。",
        "删除项目后真正从最近列表里移除（之前重启应用会被自动重新打开流程加回来）。",
      ],
    },
  },
  {
    version: "0.4.1",
    date: "2026-04-27",
    highlights: {
      en: [
        "Polished the update-available notification banner; the download link now opens in the system browser.",
        "Settings gear and About row keep showing a small red dot when an update is available, even after dismissing the top banner.",
      ],
      zh: [
        "新版本提醒 banner 优化样式，下载链接用系统浏览器打开。",
        "有可用更新时，设置齿轮按钮和 About 行会显示小红点，即使关闭顶部 banner 也仍然提示。",
      ],
    },
  },
  {
    version: "0.4.0",
    date: "2026-04-26",
    highlights: {
      en: [
        "Multimodal ingest: extract embedded images from PDF / docx / pptx and caption them with a vision model so the wiki page references each image with semantic alt text instead of empty placeholders.",
        "Image-aware search: results page splits into Pages and Images sections, clicking a thumbnail opens a lightbox and a Jump-to-source button navigates directly into the original document at the right location.",
        "Folder import + recursive cascade delete with two-stage inline confirmation (no more accidental folder loss from a single misclick).",
      ],
      zh: [
        "多模态导入：从 PDF / docx / pptx 抽出内嵌图片并用视觉模型生成描述，wiki 页面引用图片时带上语义 alt 文本。",
        "搜索结果新增图片分区：缩略图点击打开 lightbox，跳转到源文档按钮直达图片在原文中的位置。",
        "支持文件夹批量导入和递归级联删除（删除按钮采用两段式确认，避免误删整个文件夹）。",
      ],
    },
  },
]
