// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { KITS, applyKit, initialKit } from "../src/index.js"

const KEY = "test-app.kit"

beforeEach(() => {
  localStorage.clear()
  const root = document.documentElement
  delete root.dataset.kit
  delete root.dataset.mode
  root.style.colorScheme = ""
  vi.unstubAllGlobals()
})

describe("KITS", () => {
  it("lists four kits under neutral names", () => {
    expect(KITS.map(kit => kit.value)).toEqual([
      "paper-light",
      "paper-dark",
      "graphite-light",
      "graphite-dark",
    ])
  })
})

describe("applyKit", () => {
  it("maps a built-in public name to the stylesheet attribute", () => {
    applyKit("paper-dark", KEY)
    const root = document.documentElement
    expect(root.dataset.kit).toBe("workshop")
    expect(root.dataset.mode).toBe("dark")
    expect(root.style.colorScheme).toBe("dark")

    applyKit("graphite-light", KEY)
    expect(root.dataset.kit).toBe("forge")
    expect(root.dataset.mode).toBe("light")
  })

  it("uses an app's own kit name as the attribute unchanged", () => {
    applyKit("acme-dark", KEY)
    expect(document.documentElement.dataset.kit).toBe("acme")
    expect(document.documentElement.dataset.mode).toBe("dark")
  })

  it("persists the value under the explicit key only", () => {
    applyKit("graphite-dark", KEY)
    expect(localStorage.getItem(KEY)).toBe("graphite-dark")
    expect(localStorage.length).toBe(1)
  })

  it("requires a storage key", () => {
    // @ts-expect-error storageKey is required
    expect(() => applyKit("paper-light")).toThrow(/storageKey is required/)
    expect(() => applyKit("paper-light", "")).toThrow(/storageKey is required/)
  })
})

describe("initialKit", () => {
  it("prefers the URL parameters", () => {
    localStorage.setItem(KEY, "graphite-dark")
    expect(initialKit("?kit=paper&mode=dark", KEY)).toBe("paper-dark")
  })

  it("falls back to the stored value for the explicit key", () => {
    localStorage.setItem(KEY, "graphite-light")
    expect(initialKit("", KEY)).toBe("graphite-light")
    expect(initialKit("", "other.kit")).toBe("paper-light")
  })

  it("defaults to paper-light, or paper-dark under a dark colour scheme", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    expect(initialKit("", KEY)).toBe("paper-light")
    vi.stubGlobal("matchMedia", () => ({ matches: true }))
    expect(initialKit("", KEY)).toBe("paper-dark")
  })

  it("requires a storage key", () => {
    // @ts-expect-error storageKey is required
    expect(() => initialKit("")).toThrow(/storageKey is required/)
  })
})
