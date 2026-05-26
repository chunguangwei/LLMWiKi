import { describe, it, expect } from "vitest"
import { recategorizeIndexEntry } from "./index-recategorize"

const INDEX = `---
type: index
title: Wiki Index
---

# Wiki Index

## 用户手册

* [[my-page]] — A handy manual

* [[other-manual]] — Something else

## 书籍

* [[some-book]] — A book

## Sources

* [[my-page]] — Source summary of my page
`

const baseArgs = {
  slug: "my-page",
  targetLabel: "书籍",
  targetAliases: ["书籍", "Books"],
  sourcesAliases: ["Sources", "资料"],
}

describe("recategorizeIndexEntry", () => {
  it("moves the category bullet to an existing target section", () => {
    const out = recategorizeIndexEntry(INDEX, baseArgs)
    // removed from 用户手册
    const manualBlock = out.split("## 用户手册")[1].split("## ")[0]
    expect(manualBlock).not.toContain("[[my-page]]")
    expect(manualBlock).toContain("[[other-manual]]")
    // added under 书籍, preserving its description
    const booksBlock = out.split("## 书籍")[1].split("## ")[0]
    expect(booksBlock).toContain("[[my-page]] — A handy manual")
  })

  it("leaves the Sources duplicate untouched", () => {
    const out = recategorizeIndexEntry(INDEX, baseArgs)
    const sourcesBlock = out.split("## Sources")[1]
    expect(sourcesBlock).toContain("[[my-page]] — Source summary of my page")
  })

  it("creates the target section when it does not exist", () => {
    const out = recategorizeIndexEntry(INDEX, {
      ...baseArgs,
      targetLabel: "笔记",
      targetAliases: ["笔记", "Notes"],
    })
    expect(out).toContain("## 笔记")
    const notesBlock = out.split("## 笔记")[1].split("## ")[0]
    expect(notesBlock).toContain("[[my-page]] — A handy manual")
  })

  it("matches a target section by an English alias", () => {
    const withConcepts = INDEX + "\n## Concepts\n\n* [[a-concept]] — c\n"
    const out = recategorizeIndexEntry(withConcepts, {
      slug: "my-page",
      targetLabel: "概念",
      targetAliases: ["概念", "Concepts"],
      sourcesAliases: ["Sources"],
    })
    // uses the existing English heading, does not create a 概念 section
    expect(out).not.toContain("## 概念")
    const conceptsBlock = out.split("## Concepts")[1]
    expect(conceptsBlock).toContain("[[my-page]]")
  })

  it("is a no-op when the page is already under the target section", () => {
    const out = recategorizeIndexEntry(INDEX, {
      ...baseArgs,
      targetLabel: "用户手册",
      targetAliases: ["用户手册", "Manual"],
    })
    expect(out).toBe(INDEX)
  })

  it("adds a fresh bullet (reusing the Sources description) when not listed under a category", () => {
    const onlySources = `# Wiki Index

## Sources

* [[lonely-page]] — Only in sources
`
    const out = recategorizeIndexEntry(onlySources, {
      slug: "lonely-page",
      targetLabel: "报告",
      targetAliases: ["报告", "Report"],
      sourcesAliases: ["Sources"],
    })
    expect(out).toContain("## 报告")
    const reportBlock = out.split("## 报告")[1].split("## ")[0]
    expect(reportBlock).toContain("[[lonely-page]] — Only in sources")
    // sources entry preserved
    expect(out.split("## Sources")[1]).toContain("[[lonely-page]]")
  })

  it("uses the fallback description for a page absent from the index", () => {
    const out = recategorizeIndexEntry(INDEX, {
      slug: "brand-new",
      targetLabel: "文章",
      targetAliases: ["文章", "Article"],
      sourcesAliases: ["Sources"],
      fallbackDescription: "Freshly assigned",
    })
    const block = out.split("## 文章")[1].split("## ")[0]
    expect(block).toContain("[[brand-new]] — Freshly assigned")
  })
})
