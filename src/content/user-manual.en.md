# LLMWiki User Manual

Version: 0.4.10 (LLMWiKi fork)

This manual is for **people already using LLMWiki**. For install / build-from-source instructions, see [`getting-started.md`](getting-started.md).

---

## 1. What this app is

LLMWiki turns scattered documents (PDF / DOCX / web pages / notes / ...) into a **structured, cross-referenced, continuously updated** knowledge base.

The loop looks like this:

```
you → drop files into raw/sources/   ↓
                                     LLM reads, organises
                                     writes wiki pages, maintains cross-refs, appends a log
                                     ↓
you → ask questions against the wiki ↓
                                     LLM answers from the wiki, with citations
                                     ↓
you → save a good answer as a page   ↓
                                     next time the same topic comes up, no re-reasoning needed
```

The key difference from "upload a file to ChatGPT": **knowledge is compiled once**. You don't have to make the LLM re-read the originals every time you ask a question.

---

> **Want custom page types, writing rules, frontmatter fields?** Jump straight to §6 + [`user-rules.md`](user-rules.md).

## 2. Launch & setup (10 min)

### 2.1 Launch

- macOS: double-click `LLM Wiki.app` (first launch: right-click → Open to bypass Gatekeeper)
- Windows: double-click the installed `LLM Wiki.exe`

### 2.2 Switch language (one click, anytime)

**Settings → Interface → UI Language** → click **中文** or **English**

> Improvement: since the LLMWiKi fork, **the click takes effect and auto-saves immediately** — no need to press the "Save" button below.

### 2.3 Configure an LLM Provider

**Settings → LLM Models** → pick a provider → fill in API Key + model name

| Choice | Notes |
|---|---|
| OpenAI / Anthropic / Google | Use the official API key |
| OpenRouter | One key, many models — good cost/perf |
| DeepSeek / Volcengine / Qwen / Kimi | Choose **Custom Endpoint** and fill in the OpenAI-compatible URL |
| Ollama (local) | Defaults to `http://localhost:11434`, free |

After filling each row, hit **Test** on the right — a green ✓ means you're good.

### 2.4 Optional: enable vector search / web search

- **Settings → Embeddings** → enabling this clearly improves retrieval quality once the wiki passes ~100 pages
- **Settings → Web Search** → choose Tavily (personal) / SerpApi (commercial) / SearXNG (privacy), fill in key or URL

You can use the app without either, but turning them on noticeably upgrades the experience.

---

## 3. Your first project (5 min)

1. Main screen → **New Project**
2. Pick a template: General Research / Personal Notes / Team Wiki, etc.
3. Name it + choose a directory (**iCloud / OneDrive / Dropbox recommended** so you get multi-device sync)
4. Once created, the project root auto-generates:
   ```
   my-wiki/
   ├── purpose.md       # project purpose (worth filling out with a few sentences first)
   ├── schema.md        # page types and naming conventions
   ├── raw/sources/     # ← drop source files here
   ├── wiki/            # ← LLM-written pages live here
   ├── .llm-wiki/       # project shared metadata (safe to sync via cloud)
   └── .llm-wiki-local/ # personal chat history (must be excluded from cloud sync)
   ```

---

## 4. Day-to-day use

### 4.1 Ingest new material

Drag files directly into `raw/sources/` or use the **Import** button in the Sources panel on the left:

| Type | Extensions |
|---|---|
| Text | `.md` `.mdx` `.txt` `.rtf` |
| Documents | `.pdf` `.docx` `.odt` |
| Slides | `.pptx` `.odp` |
| Spreadsheets | `.xlsx` `.ods` `.csv` `.xls` |
| Web pages | `.html` `.htm` (or use the Chrome extension for clipping) |
| Data | `.json` `.yaml` `.yml` `.xml` |
| Images | Auto OCR / visual description (requires multimodal enabled) |

The LLM will automatically:
1. Read and understand the content
2. Write a source-summary page
3. Extract entities / concepts, updating existing pages or creating new ones
4. Append to `wiki/log.md`

The whole process is shown step-by-step in the right-hand Chat panel — you can watch the LLM think.

### 4.2 Ask questions

Switch to the **Chat** panel and ask in plain language:

- "Across all my RAG notes, what's the most controversial claim?"
- "Compare my GPT-4 and Claude 4 notes side by side"
- "What new concepts did this month's ingested material introduce?"

**Good answers can be "saved as a new page"** so exploration accumulates into the wiki — next time you don't have to ask again.

### 4.3 View the graph

Switch to the **Graph** panel:
- Nodes = wiki pages, edges = references between them
- Auto Louvain community detection, clusters coloured by group
- **Graph Insights** automatically surfaces "surprising connections" and "knowledge gaps", with a one-click Deep Research trigger to fill them in

### 4.4 Review

When the LLM hits an ambiguous judgement during ingest, it parks the decision in the **Review** panel:
- Contradictions
- Duplicates
- Missing pages
- Suggestions (**also includes update suggestions generated by scheduled web refresh**)

You accept / reject without interrupting the LLM's workflow.

---

## 5. Three new features (LLMWiKi fork only)

### 5.1 `.llmwiki` one-click import / export

**Entry: Settings → Import / Export**

Packages an entire project (originals + wiki + shared metadata) into a single `.llmwiki` file. **Excludes** chat history, API keys, and vector indexes.

**Export**:
1. Open the project you want to share
2. Settings → Import / Export → optionally fill in "Your name" (written to manifest)
3. "Export package" → choose a save location → generates `project-name-date.llmwiki`

**Import**:
1. Choose "Skip existing files" or "Overwrite all"
2. "Import .llmwiki" → pick the file → pick target directory → SHA256-verified then unpacked

**Good for**:
- Mac → Windows device migration
- First-time distribution of a shared wiki across a team
- Weekly archival backups

Full field reference in [`features.md §1`](features.md#1-llmwiki-import-export-package).

### 5.2 Per-page scheduled web refresh

**Entry: Settings → Scheduled Web Refresh** + per-page frontmatter

Tag pages prone to going stale (project status, technical progress, prices, people's situations) with:

```yaml
---
type: concept
title: Mixture-of-Experts
refresh-enabled: true
refresh-interval-days: 7
refresh-queries:                  # optional; LLM auto-generates if omitted
  - "MoE benchmarks 2026"
---
```

Then go to **Settings → Scheduled Web Refresh** and enable the background scheduler.

The background job:
1. Every N days, fetches fresh results via the configured search provider
2. Has the LLM compare the current page against the new results
3. If something looks stale, emits a **suggestion** to the Review queue with a summary
4. Writes back a `refresh-last-refreshed` timestamp

**Refresh a single page now**: open the page in the editor — there's a *Web refresh* row with a spin button above the frontmatter.

**Known limits**:
- Requires a Web Search provider configured first
- LLM calls cost money — default interval ≥ 7 days recommended
- Only generates suggestions; **does not** rewrite the page body automatically (you review and decide)

Full details in [`features.md §2`](features.md#2-scheduled-web-refresh).

### 5.3 Local / shared config separation (cloud-friendly)

The upstream `.llm-wiki/` used to hold *both* shared project metadata and private chat history, which made cloud sharing prone to conflicts and accidental leakage.

We split it into:

| Directory | Contents | Cloud |
|---|---|---|
| `.llm-wiki/` | ingest cache, review queue, page history | **sync** |
| `.llm-wiki-local/` | chat conversations | **must exclude** |

API keys have always lived in the OS app-data directory, **not in the project**, so syncing a project never leaks keys.

Existing users get an automatic one-time migration of old chat files on first launch — nothing to do.

Cloud-specific commands for excluding `.llm-wiki-local/` are in [`cloud-sharing.md`](cloud-sharing.md).

---

## 6. Custom page types / rules / format (user rules)

LLMWiki ships with 6 default page types (entity / concept / source / query / comparison / synthesis). If you're working in a specific domain (academic research, technical docs, reading notes, product analysis, etc.), you can **fully customise** the page taxonomy, naming conventions, frontmatter fields, and AI output style.

**Where to customise** ——

| Where | What it changes | Scope |
|---|---|---|
| `schema.md` (project root) | Page types, naming, frontmatter fields, workflow | Required reading for the LLM before every operation — most critical |
| `purpose.md` (project root) | Project goal, core questions, research boundaries | Gives the LLM "why this wiki exists" context |
| Settings → LLM Models | Provider / model / temperature / reasoning | Global |
| Settings → Output → AI Output Language | Force AI to reply / write pages in a specific language | Global |
| Settings → Web Search | Provider + optional domain restriction | Global |
| Per-page frontmatter | That page's type, tags, refresh policy | Single page |

Full guide + 10+ taxonomy templates → [`user-rules.md`](user-rules.md)

---

## 7. Team / multi-device collaboration

Short version: put the project directory on a shared cloud drive, exclude `.llm-wiki-local/`, and agree on a single writer at a time. Full details in [`cloud-sharing.md`](cloud-sharing.md).

If you don't want a permanent cloud mount, use a `.llmwiki` package: export → send to a colleague → they import.

---

## 8. Advanced

### 8.1 Obsidian compatibility

The `wiki/` directory is already a valid Obsidian vault: project creation writes an `.obsidian/` config alongside it. Open Obsidian → Open vault → pick the project root → browse the graph / edit pages in Obsidian. LLMWiki auto-detects external edits and syncs them back.

### 8.2 Chrome web clipping

`app/extension/` is a Chrome extension:
1. Open `chrome://extensions`
2. Enable developer mode
3. Load unpacked → pick `app/extension/`
4. Afterwards, any web page → click the toolbar icon → one-shot clip into the current LLMWiki project's `raw/sources/`

### 8.3 Command-line batch processing

The app starts a local HTTP service (Clip Server) on launch. You can script POSTs of URLs and have LLMWiki ingest them automatically — see the upstream README's Clip Server section.

### 8.4 Editing wiki pages by hand

Every file in `wiki/*.md` is just plain markdown. You can edit it directly (inside LLMWiki, in Obsidian, or any text editor). The next time the LLM runs it will pick up your edits.

---

## 9. Troubleshooting quick reference

| Symptom | Fix |
|---|---|
| macOS says "is damaged" on launch | `xattr -dr com.apple.quarantine "/Applications/LLM Wiki.app"` |
| Ingest stuck | Settings → LLM Models → Test; check Review panel for stuck items |
| Chinese translation missing in places | Your version may be older — the fork has all new sections translated |
| Scheduled refresh never fires | Configure Settings → Web Search provider first; check frontmatter `refresh-enabled: true` spelling |
| Cloud drive shows .json (Conflict) files | Multiple writers at the same time — agree on one primary writer, or switch to git mode |
| Can't find the API key | It lives in the OS app-data dir, not in the project: macOS `~/Library/Application Support/com.llm-wiki.app/` |
| Want to wipe all LLM cache | Delete the project root's `.llm-wiki/` subdirectory; the app rebuilds it automatically |

---

## 10. Document map

| Doc | What's in it |
|---|---|
| [`README.md`](../README.md) | Top-level entry, 30-second quick start |
| [`docs/user-manual.md`](user-manual.md) | **This file** (day-to-day use) |
| [`docs/getting-started.md`](getting-started.md) | Detailed install, directory layout, packaging matrix |
| [`docs/features.md`](features.md) | Detailed technical docs for new features |
| [`docs/user-rules.md`](user-rules.md) | **Custom page types / rules / format (schema.md + Settings playbook)** |
| [`docs/cloud-sharing.md`](cloud-sharing.md) | Team / multi-device cloud deployment |
| [`UPSTREAM.md`](../UPSTREAM.md) | Fork meta-info, upstream sync workflow |
| [`app/README.md`](../app/README.md) | Upstream's full feature list (with our additions §19/20/21) |
