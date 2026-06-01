// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { applyTheme, resolveTheme, subscribeToSystemThemeChanges } from "./theme"

/**
 * jsdom doesn't ship matchMedia, so we substitute window.matchMedia
 * per-test. `Object.defineProperty` lets us replace the read-only
 * accessor without TypeScript fighting us.
 */
function stubMatchMedia(impl: (q: string) => MediaQueryList): () => void {
  const original = window.matchMedia
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: impl,
  })
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: original,
    })
  }
}

function mediaQueryListStub(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }
}

describe("resolveTheme", () => {
  it("returns the literal mode for light / dark", () => {
    expect(resolveTheme("light")).toBe("light")
    expect(resolveTheme("dark")).toBe("dark")
  })

  it("reads the prefers-color-scheme media query for system (dark OS)", () => {
    const restore = stubMatchMedia(() => mediaQueryListStub(true))
    try {
      expect(resolveTheme("system")).toBe("dark")
    } finally {
      restore()
    }
  })

  it("reads the prefers-color-scheme media query for system (light OS)", () => {
    const restore = stubMatchMedia(() => mediaQueryListStub(false))
    try {
      expect(resolveTheme("system")).toBe("light")
    } finally {
      restore()
    }
  })
})

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.colorScheme = ""
  })

  afterEach(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.colorScheme = ""
  })

  it("adds the dark class for explicit dark", () => {
    applyTheme("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe("dark")
  })

  it("removes the dark class for explicit light", () => {
    document.documentElement.classList.add("dark")
    applyTheme("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe("light")
  })

  it("respects the OS preference for system", () => {
    const restore = stubMatchMedia(() => mediaQueryListStub(true))
    try {
      applyTheme("system")
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    } finally {
      restore()
    }
  })
})

describe("subscribeToSystemThemeChanges", () => {
  it("invokes the callback when the media query fires a change", () => {
    let registeredHandler: ((e?: Event) => void) | null = null
    const restore = stubMatchMedia(() => ({
      ...mediaQueryListStub(false),
      addEventListener: ((_type: string, h: EventListener) => {
        registeredHandler = h as (e?: Event) => void
      }) as MediaQueryList["addEventListener"],
    }))
    try {
      let calls = 0
      const unsub = subscribeToSystemThemeChanges(() => {
        calls += 1
      })
      expect(registeredHandler).not.toBeNull()
      registeredHandler!()
      expect(calls).toBe(1)
      unsub()
    } finally {
      restore()
    }
  })

  it("no-ops gracefully when matchMedia isn't available", () => {
    const restore = stubMatchMedia(undefined as unknown as typeof window.matchMedia)
    try {
      const unsub = subscribeToSystemThemeChanges(() => {})
      unsub()  // should not throw
    } finally {
      restore()
    }
  })
})

// Touch vi.* to keep the imports honest after the rewrite.
void vi
