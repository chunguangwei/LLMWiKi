import { describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  legacySourceSummarySlugFromIdentity,
  sourceIdentityForPath,
  sourceReferenceIdentity,
  sourceSummarySlugCandidatesFromIdentity,
  sourceSummarySlugFromIdentity,
} from "./source-identity"

describe("source identity helpers", () => {
  it("keeps raw/sources relative folder context as the source identity", () => {
    expect(
      sourceIdentityForPath("/tmp/project", "/tmp/project/raw/sources/project-a/config.yaml"),
    ).toBe("project-a/config.yaml")
  })

  it("normalizes source references that include raw/sources prefixes", () => {
    expect(sourceReferenceIdentity("raw/sources/project-a/config.yaml")).toBe(
      "project-a/config.yaml",
    )
    expect(sourceReferenceIdentity("/tmp/project/raw/sources/project-a/config.yaml")).toBe(
      "project-a/config.yaml",
    )
  })

  it("matches raw/sources prefixes case-insensitively while preserving returned case", () => {
    expect(
      sourceIdentityForPath(
        "C:/Users/Me/Wiki",
        "c:/users/me/wiki/raw/sources/Project-A/Config.yaml",
      ),
    ).toBe("Project-A/Config.yaml")
    expect(sourceReferenceIdentity("RAW/SOURCES/Project-A/Config.yaml")).toBe(
      "Project-A/Config.yaml",
    )
  })

  it("keeps legacy basename slugs for root-level sources", () => {
    expect(sourceSummarySlugFromIdentity("config.yaml")).toBe("config")
  })

  it("escapes slug segments so delimiter-containing folders do not collide", () => {
    const slug = sourceSummarySlugFromIdentity("a--b/config.yaml")

    expect(slug).toMatch(
      /^4-a-b--6-config--[a-z0-9]+$/,
    )
    expect(sourceSummarySlugFromIdentity("a/b/config.yaml")).toMatch(
      /^1-a--1-b--6-config--[a-z0-9]+$/,
    )
    expect(sourceSummarySlugFromIdentity("4-a--b--6-config.yaml")).not.toBe(
      sourceSummarySlugFromIdentity("a--b/config.yaml"),
    )
    expect(sourceSummarySlugCandidatesFromIdentity("a--b/config.yaml")).toContain(
      slug.replace(/^4-a-b/, "3-a-b"),
    )
  })

  it("caps nested source summary slugs to avoid Windows path length failures", () => {
    const slug = sourceSummarySlugFromIdentity("2024年/污水处理/反硝化除磷技术研究报告.pdf")

    expect(slug.length).toBeLessThanOrEqual(120)
    expect(`wiki/sources/${slug}.md`.length).toBeLessThanOrEqual(136)
    expect(slug).toMatch(/--[a-z0-9]+$/)
    expect(slug).toContain("2024年")
    expect(slug).toContain("污水处理")
    expect(slug).toContain("反硝化除磷技术研究报告")
    expect(slug).not.toContain("%")
  })

  it("keeps stable hashes when truncating long nested source slugs", () => {
    const first = sourceSummarySlugFromIdentity("2024年/污水处理/反硝化除磷技术研究报告.pdf")
    const second = sourceSummarySlugFromIdentity("2024年/污水处理/反硝化除磷技术研究报告修订版.pdf")

    expect(first).not.toBe(second)
    expect(first.length).toBeLessThanOrEqual(120)
    expect(second.length).toBeLessThanOrEqual(120)
  })

  it("keeps legacy percent-encoded nested slug candidates for old source pages", () => {
    const identity = "2024年/污水处理/反硝化除磷技术研究报告.pdf"
    const canonical = sourceSummarySlugFromIdentity(identity)
    const legacy = legacySourceSummarySlugFromIdentity(identity)

    expect(canonical).not.toBe(legacy)
    expect(canonical).not.toContain("%")
    expect(legacy).toContain("%E6")
    expect(sourceSummarySlugCandidatesFromIdentity(identity)).toEqual([canonical, legacy])
  })

  it.each([
    `${"资料".repeat(15)}/${"中文文档".repeat(18)}.pdf`,
    `${"国际公约".repeat(30)}.md`,
    `${"a".repeat(300)}.txt`,
    `${"𠮷".repeat(40)}/${"𠮷".repeat(40)}.pdf`,
  ])("bounds the UTF-8 size of the summary and media name for %s", (identity) => {
    const slug = sourceSummarySlugFromIdentity(identity)

    expect(Buffer.byteLength(slug, "utf8")).toBeLessThanOrEqual(252)
    expect(Buffer.byteLength(`${slug}.md`, "utf8")).toBeLessThanOrEqual(255)
    expect(slug).toMatch(/--[a-z0-9]+$/)
    expect(slug).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  it("keeps distinct hashes for long names sharing the same readable prefix", () => {
    const prefix = "中文".repeat(60)
    const first = sourceSummarySlugFromIdentity(`${prefix}甲.md`)
    const second = sourceSummarySlugFromIdentity(`${prefix}乙.md`)

    expect(first.split("--")[0]).toBe(second.split("--")[0])
    expect(first).not.toBe(second)
    expect(sourceSummarySlugFromIdentity(`${prefix}甲.md`)).toBe(first)
  })

  it("preserves the former root and nested names as legacy lookup candidates", () => {
    const rootStem = "中文".repeat(50)
    expect(sourceSummarySlugCandidatesFromIdentity(`${rootStem}.md`)).toContain(rootStem)

    const identity = `folder/${rootStem}.md`
    const canonical = sourceSummarySlugFromIdentity(identity)
    const hash = canonical.split("--").pop()
    const formerPrefix = `6-folder--100-${rootStem}`.slice(0, 120 - String(hash).length - 2)
    expect(sourceSummarySlugCandidatesFromIdentity(identity)).toContain(`${formerPrefix}--${hash}`)
  })

  it("keeps existing portable CJK root names even when they exceed 120 bytes", () => {
    const stem = "中文".repeat(35)
    expect(sourceSummarySlugFromIdentity(`${stem}.md`)).toBe(stem)
  })

  it("writes a CJK summary and media directory when the old slug exceeds 255 bytes", async () => {
    const identity = `${"资".repeat(30)}/${"文".repeat(70)}.pdf`
    const slug = sourceSummarySlugFromIdentity(identity)
    const previous = sourceSummarySlugCandidatesFromIdentity(identity)[1]
    expect(Buffer.byteLength(`${previous}.md`, "utf8")).toBeGreaterThan(255)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "source-slug-bytes-"))
    try {
      const summary = path.join(directory, "sources", `${slug}.md`)
      const media = path.join(directory, "media", slug, "image.png")
      await fs.mkdir(path.dirname(summary), { recursive: true })
      await fs.mkdir(path.dirname(media), { recursive: true })
      await fs.writeFile(summary, "# Summary")
      await fs.writeFile(media, "image")
      expect(await fs.readFile(summary, "utf8")).toBe("# Summary")
      expect(await fs.readFile(media, "utf8")).toBe("image")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
