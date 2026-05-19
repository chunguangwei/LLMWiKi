import type { IngestScenario } from "./types"

/**
 * Ingest scenarios drive autoIngest end-to-end. Two LLM responses per
 * scenario (stage 1 analysis, stage 2 generation with FILE + REVIEW blocks).
 *
 * FILE block format (what stage 2 must emit to write a wiki file):
 *   ---FILE: wiki/path/to/page.md---
 *   (file content, usually with YAML frontmatter)
 *   ---END FILE---
 *
 * REVIEW block format (what stage 2 emits to inject a review item):
 *   ---REVIEW: missing-page | Short title---
 *   Description.
 *   OPTIONS: Approve | Skip
 *   PAGES: page1.md, page2.md
 *   ---END REVIEW---
 *
 * Stage 2 may emit arbitrary prose around blocks — the parser only
 * cares about the delimited blocks.
 */

const BASIC_PURPOSE = `# Purpose

This wiki tracks deep-learning research concepts.
`

const BASIC_INDEX = `# Index

## Concepts
- [[attention]]
`

const BASIC_SCHEMA = `# Schema

## wiki/sources/
Each ingested source has a summary page here.

## wiki/concepts/
Each concept gets its own page.
`

// Compact comprehensive-schema fixture for the single-page-mode scenarios
// below. The runner does not parse this — it only flows through to the
// generation prompt as context — but exercising the new path-resolution
// logic requires SOME schema present that names the comprehensive folders.
const COMPREHENSIVE_SCHEMA_ZH = `# Wiki Schema — 综合（推荐默认）

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
| travel-plan | wiki/旅游方案/ | 行程规划、攻略、游记（整篇保留） |
| manual | wiki/用户手册/ | 产品手册、操作指南（整篇保留） |
| contract | wiki/合同/ | 合同、协议（整篇保留） |
| paper | wiki/论文/ | 学术论文（可拆分） |
| concept | wiki/概念/ | 概念、术语（可拆分） |
`

export const ingestScenarios: IngestScenario[] = [
  // 1. basic-new-source — new concept wiki page + source summary, no reviews
  {
    name: "basic-new-source",
    description:
      "Stage 2 emits a single concept page + a source summary page. No " +
      "REVIEW blocks. The runner must see both files on disk and zero " +
      "reviews in the store.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/rope-paper.md",
      content: [
        "# Rotary Position Embedding",
        "",
        "Rotary Position Embedding (RoPE) encodes positional information by",
        "rotating pairs of dimensions in query and key vectors. It naturally",
        "supports variable-length contexts and is now standard in LLMs.",
      ].join("\n"),
    },
    analysisResponse: [
      "## Key Concepts",
      "- Rotary Position Embedding (RoPE): rotates pairs of dimensions",
      "",
      "## Main Arguments",
      "- RoPE naturally supports variable-length contexts",
      "",
      "## Recommendations",
      "- Create wiki/concepts/rope.md",
      "- Create wiki/sources/rope-paper.md",
    ].join("\n"),
    generationResponse: [
      "I'll create one concept page and the source summary.",
      "",
      "---FILE: wiki/concepts/rope.md---",
      "---",
      "title: Rotary Position Embedding",
      "tags: [positional-encoding]",
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Rotary Position Embedding",
      "",
      "RoPE rotates pairs of dimensions in [[attention]] queries and keys",
      "to encode absolute position while preserving relative-position invariance.",
      "---END FILE---",
      "",
      "---FILE: wiki/sources/rope-paper.md---",
      "---",
      "title: \"Source: rope-paper.md\"",
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Source: rope-paper.md",
      "",
      "Paper introducing [[Rotary Position Embedding]].",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/rope.md",
        "wiki/sources/rope-paper.md",
      ],
      fileContains: {
        "wiki/concepts/rope.md": [
          "title: Rotary Position Embedding",
          "[[attention]]",
        ],
        "wiki/sources/rope-paper.md": ["rope-paper.md"],
      },
      reviewsCreated: [],
    },
  },

  // 2. generates-review-items — REVIEW blocks in generation become store items
  {
    name: "generates-review-items",
    description:
      "Stage 2 emits one FILE and two REVIEW blocks (missing-page + " +
      "suggestion). Both reviews must appear in the store after ingest.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/flash-attention.md",
      content:
        "# FlashAttention\n\nFlashAttention is an IO-aware exact attention algorithm.\n",
    },
    analysisResponse: "## Key Concepts\n- FlashAttention\n",
    generationResponse: [
      "---FILE: wiki/sources/flash-attention.md---",
      "---",
      "title: \"Source: flash-attention.md\"",
      "sources: [flash-attention.md]",
      "---",
      "",
      "# Source: flash-attention.md",
      "",
      "FlashAttention is mentioned here.",
      "---END FILE---",
      "",
      "---REVIEW: missing-page | FlashAttention---",
      "The source introduces FlashAttention but no dedicated page exists.",
      "OPTIONS: Create page | Skip",
      "PAGES: wiki/sources/flash-attention.md",
      "---END REVIEW---",
      "",
      "---REVIEW: suggestion | Add IO-aware algorithms survey---",
      "Consider a survey page grouping IO-aware attention variants.",
      "---END REVIEW---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/sources/flash-attention.md"],
      reviewsCreated: [
        { type: "missing-page", titleContains: "FlashAttention" },
        { type: "suggestion", titleContains: "IO-aware" },
      ],
    },
  },

  // 3. references-existing-wikilinks — generated pages link to existing pages
  {
    name: "references-existing-wikilinks",
    description:
      "The generated wiki page must include [[attention]] — linking back " +
      "to a page that already exists in the wiki. Runner asserts substring.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
      "wiki/attention.md":
        "---\ntitle: Attention\n---\n\n# Attention\n\nThe attention mechanism.\n",
    },
    source: {
      path: "raw/sources/multi-head.md",
      content: "# Multi-Head Attention\n\nParallel attention heads.\n",
    },
    analysisResponse:
      "## Connections to Existing Wiki\n" +
      "- Multi-head attention is a variant of attention — existing [[attention]] page should be linked.\n",
    generationResponse: [
      "---FILE: wiki/concepts/multi-head-attention.md---",
      "---",
      "title: Multi-Head Attention",
      "---",
      "",
      "# Multi-Head Attention",
      "",
      "Multi-head [[attention]] runs several attention layers in parallel.",
      "---END FILE---",
      "",
      "---FILE: wiki/sources/multi-head.md---",
      "---",
      "title: \"Source: multi-head.md\"",
      "---",
      "",
      "# Source: multi-head.md",
      "",
      "Source for multi-head [[attention]].",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/multi-head-attention.md",
        "wiki/sources/multi-head.md",
      ],
      fileContains: {
        "wiki/concepts/multi-head-attention.md": ["[[attention]]"],
      },
    },
  },

  // 4. chinese-source — Chinese content flows through to Chinese wiki pages
  {
    name: "chinese-source",
    description:
      "Chinese-language source document; LLM responses in Chinese. " +
      "UTF-8 round-trip through file write must be clean.",
    initialWiki: {
      "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n",
    },
    source: {
      path: "raw/sources/transformer-survey.md",
      content: "# Transformer 综述\n\nTransformer 是一种基于注意力机制的神经网络架构。\n",
    },
    analysisResponse: "## 核心概念\n- Transformer：基于注意力机制的架构\n",
    generationResponse: [
      "---FILE: wiki/concepts/transformer.md---",
      "---",
      "title: Transformer",
      "---",
      "",
      "# Transformer",
      "",
      "Transformer 是一种基于 [[注意力机制]] 的神经网络架构。",
      "---END FILE---",
      "",
      "---FILE: wiki/sources/transformer-survey.md---",
      "---",
      "title: \"Source: transformer-survey.md\"",
      "---",
      "",
      "# Source: transformer-survey.md",
      "",
      "关于 [[Transformer]] 的综述。",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/transformer.md",
        "wiki/sources/transformer-survey.md",
      ],
      fileContains: {
        "wiki/concepts/transformer.md": [
          "title: Transformer",
          "[[注意力机制]]",
        ],
      },
    },
  },

  // 5. travel-plan-single-page — comprehensive schema, Chinese folder,
  //    LLM emits ONLY the travel-plan page; the source-summary fallback
  //    must accept the new path and NOT also write wiki/sources/<x>.md.
  {
    name: "travel-plan-single-page",
    description:
      "Single-page mode: a Chinese travel plan ingested under the " +
      "comprehensive schema should produce exactly ONE wiki page at " +
      "wiki/旅游方案/<slug>.md, with no fragmentation and no fallback " +
      "duplicate at wiki/sources/.",
    initialWiki: {
      "purpose.md": "# 用途\n\n我的生活资料库。\n",
      "schema.md": COMPREHENSIVE_SCHEMA_ZH,
      "wiki/index.md": "# 索引\n",
    },
    source: {
      path: "raw/sources/东京三日游.md",
      content: [
        "# 东京三日游",
        "",
        "Day 1: 浅草寺 → 晴空塔 → 银座",
        "Day 2: 明治神宫 → 涩谷 → 新宿",
        "Day 3: 筑地市场 → 台场 → 羽田机场",
      ].join("\n"),
    },
    analysisResponse: [
      "Document Type: travel-plan — 三天行程的完整规划，应整篇保留为一页",
      "",
      "## Key Entities",
      "- 浅草寺、晴空塔、明治神宫（景点）",
      "",
      "## Recommendations",
      "- 整篇放进 wiki/旅游方案/东京三日游.md",
    ].join("\n"),
    generationResponse: [
      "---FILE: wiki/旅游方案/东京三日游.md---",
      "---",
      "type: travel-plan",
      "title: 东京三日游",
      "sources: [东京三日游.md]",
      "---",
      "",
      "# 东京三日游",
      "",
      "## Day 1: 浅草寺 → 晴空塔 → 银座",
      "## Day 2: 明治神宫 → 涩谷 → 新宿",
      "## Day 3: 筑地市场 → 台场 → 羽田机场",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/旅游方案/东京三日游.md"],
      fileContains: {
        "wiki/旅游方案/东京三日游.md": [
          "type: travel-plan",
          "Day 1",
        ],
      },
      forbiddenPaths: [
        // The legacy fallback must NOT fire — the basename-match logic
        // in ingest.ts should recognize wiki/旅游方案/东京三日游.md as
        // already covering the source.
        "wiki/sources/东京三日游.md",
        // No fragmentation — schema-driven prompt must produce no
        // entity / concept pages for a single-page-mode source.
        "wiki/概念/浅草寺.md",
        "wiki/概念/晴空塔.md",
      ],
      reviewsCreated: [],
    },
  },

  // 6. manual-single-page — user manual stays as one page in wiki/用户手册/.
  {
    name: "manual-single-page",
    description:
      "Single-page mode: a product manual ingested under the comprehensive " +
      "schema lands at wiki/用户手册/<slug>.md with no fallback duplicate.",
    initialWiki: {
      "purpose.md": "# 用途\n",
      "schema.md": COMPREHENSIVE_SCHEMA_ZH,
      "wiki/index.md": "# 索引\n",
    },
    source: {
      path: "raw/sources/扫地机器人手册.md",
      content: "# 扫地机器人使用手册\n\n开机：长按电源 3 秒。\n清洁模式：短按按钮切换。\n",
    },
    analysisResponse: [
      "Document Type: manual — 完整的操作手册，整篇保留",
      "",
      "## Recommendations",
      "- 放进 wiki/用户手册/扫地机器人手册.md",
    ].join("\n"),
    generationResponse: [
      "---FILE: wiki/用户手册/扫地机器人手册.md---",
      "---",
      "type: manual",
      "title: 扫地机器人使用手册",
      "sources: [扫地机器人手册.md]",
      "---",
      "",
      "# 扫地机器人使用手册",
      "",
      "开机：长按电源 3 秒。",
      "清洁模式：短按按钮切换。",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/用户手册/扫地机器人手册.md"],
      forbiddenPaths: ["wiki/sources/扫地机器人手册.md"],
      reviewsCreated: [],
    },
  },

  // 7. contract-single-page — Chinese contract document, same pattern.
  {
    name: "contract-single-page",
    description:
      "Single-page mode: a contract / agreement document stays whole at " +
      "wiki/合同/<slug>.md (no entity decomposition into people / company).",
    initialWiki: {
      "purpose.md": "# 用途\n",
      "schema.md": COMPREHENSIVE_SCHEMA_ZH,
      "wiki/index.md": "# 索引\n",
    },
    source: {
      path: "raw/sources/供应商合同-2026-甲方.md",
      content: "# 供应商合同\n\n甲方：某公司\n乙方：某供应商\n金额：100万\n",
    },
    analysisResponse: [
      "Document Type: contract — 法律协议，整篇保留",
    ].join("\n"),
    generationResponse: [
      "---FILE: wiki/合同/供应商合同-2026-甲方.md---",
      "---",
      "type: contract",
      "title: 供应商合同 2026",
      "sources: [供应商合同-2026-甲方.md]",
      "---",
      "",
      "# 供应商合同",
      "",
      "甲方：某公司",
      "乙方：某供应商",
      "金额：100万",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/合同/供应商合同-2026-甲方.md"],
      forbiddenPaths: [
        "wiki/sources/供应商合同-2026-甲方.md",
        "wiki/人物/某公司.md",
        "wiki/公司/某供应商.md",
      ],
      reviewsCreated: [],
    },
  },

  // 8. paper-multi-page — multi-page mode still works for academic papers:
  //    source page + concept page, just like the pre-change behavior. This
  //    locks in backward compatibility for the multi-page path.
  {
    name: "paper-multi-page",
    description:
      "Multi-page mode: an academic paper ingested under the comprehensive " +
      "schema produces a source summary at wiki/论文/ AND a concept page at " +
      "wiki/概念/, matching the schema's two-folder split.",
    initialWiki: {
      "purpose.md": "# 用途\n",
      "schema.md": COMPREHENSIVE_SCHEMA_ZH,
      "wiki/index.md": "# 索引\n",
    },
    source: {
      path: "raw/sources/vaswani-2017-attention.md",
      content: "# Attention Is All You Need\n\n本文提出 Transformer 架构。\n",
    },
    analysisResponse: [
      "Document Type: paper — 学术论文，可拆分为 concept 子页",
      "",
      "## Key Concepts",
      "- Transformer 架构",
    ].join("\n"),
    generationResponse: [
      "---FILE: wiki/论文/vaswani-2017-attention.md---",
      "---",
      "type: paper",
      "title: Attention Is All You Need",
      "sources: [vaswani-2017-attention.md]",
      "---",
      "",
      "# Attention Is All You Need",
      "",
      "本文提出 [[Transformer]] 架构。",
      "---END FILE---",
      "",
      "---FILE: wiki/概念/transformer.md---",
      "---",
      "type: concept",
      "title: Transformer",
      "sources: [vaswani-2017-attention.md]",
      "---",
      "",
      "# Transformer",
      "",
      "基于注意力机制的神经网络架构。",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/论文/vaswani-2017-attention.md",
        "wiki/概念/transformer.md",
      ],
      forbiddenPaths: [
        // Same idea as single-page mode: wiki/论文/ is the source-equivalent
        // folder for type=paper, so the wiki/sources/ fallback must skip.
        "wiki/sources/vaswani-2017-attention.md",
      ],
      reviewsCreated: [],
    },
  },
]
