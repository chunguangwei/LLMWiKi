// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { collectMatchRanges } from "./find-in-page"

function container(html: string): HTMLElement {
  const el = document.createElement("div")
  el.innerHTML = html
  return el
}

describe("collectMatchRanges", () => {
  it("finds every case-insensitive occurrence across text nodes", () => {
    const el = container("<p>Badminton</p><p>I played <b>badminton</b> twice; BADMINTON again.</p>")
    const ranges = collectMatchRanges(el, "badminton")
    // one in the heading <p>, one in the <b>, one in the trailing text node
    expect(ranges.length).toBe(3)
    expect(ranges.every((r) => r.toString().toLowerCase() === "badminton")).toBe(true)
  })

  it("matches multiple hits within a single text node", () => {
    const el = container("<p>aXaXa</p>")
    expect(collectMatchRanges(el, "a").length).toBe(3)
  })

  it("works on CJK text (no word boundaries)", () => {
    const el = container("<p>我打羽毛球，昨天也打羽毛球。</p>")
    expect(collectMatchRanges(el, "羽毛球").length).toBe(2)
  })

  it("returns nothing for an empty needle", () => {
    const el = container("<p>anything</p>")
    expect(collectMatchRanges(el, "")).toEqual([])
  })

  it("does NOT match across element boundaries", () => {
    // "foobar" is split across two elements — a single-text-node scan
    // can't span them, by design.
    const el = container("<span>foo</span><span>bar</span>")
    expect(collectMatchRanges(el, "foobar").length).toBe(0)
  })

  it("honors the max cap", () => {
    const el = container("<p>" + "x".repeat(50) + "</p>")
    expect(collectMatchRanges(el, "x", 10).length).toBe(10)
  })
})
