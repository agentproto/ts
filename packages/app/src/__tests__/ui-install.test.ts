import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp, AppDefinitionError } from "../define-app.js"
import { loadAppHandle } from "../load-app.js"
import { isSafeRelativeIconPath } from "../ui-install.js"

const html = "<!doctype html><html><head></head><body>x</body></html>"
const uiApp = (install: unknown) =>
  defineApp({ id: "acme/demo", name: "Demo", ui: { html, install: install as never } })

describe("ui.install (AIP-53 Installable UI)", () => {
  it("accepts a full block and freezes it", () => {
    const app = uiApp({
      shortName: "Demo",
      themeColor: "#111114",
      backgroundColor: "#fff",
      display: "minimal-ui",
      icons: [{ path: "store/icon.png", sizes: "512x512", purpose: "maskable" }, { path: "icon.svg", sizes: "any" }],
    })
    expect(app.ui?.install?.display).toBe("minimal-ui")
    expect(Object.isFrozen(app.ui?.install)).toBe(true)
    expect(app.ui?.install?.icons).toHaveLength(2)
  })

  it("is optional", () => {
    expect(defineApp({ id: "acme/demo", ui: { html } }).ui?.install).toBeUndefined()
  })

  it.each([
    ["unknown key", { nope: 1 }],
    ["not an object", "x"],
    ["empty shortName", { shortName: "" }],
    ["long shortName", { shortName: "x".repeat(13) }],
    ["bad colour", { themeColor: "red" }],
    ["bad display", { display: "fullscreen" }],
    ["no icons", { icons: [] }],
    ["too many icons", { icons: Array.from({ length: 9 }, (_, i) => ({ path: `i${i}.png` })) }],
    ["traversal", { icons: [{ path: "../secret.png" }] }],
    ["nested traversal", { icons: [{ path: "a/../../secret.png" }] }],
    ["absolute", { icons: [{ path: "/etc/icon.png" }] }],
    ["bad extension", { icons: [{ path: "icon.html" }] }],
    ["bad sizes", { icons: [{ path: "i.png", sizes: "big" }] }],
    ["bad purpose", { icons: [{ path: "i.png", purpose: "fancy" }] }],
    ["unknown icon key", { icons: [{ path: "i.png", src: "x" }] }],
  ])("refuses %s", (_name, install) => {
    expect(() => uiApp(install)).toThrow(AppDefinitionError)
  })

  it("isSafeRelativeIconPath", () => {
    expect(isSafeRelativeIconPath("store/icon.png")).toBe(true)
    expect(isSafeRelativeIconPath("..")).toBe(false)
    expect(isSafeRelativeIconPath("C:\\x.png")).toBe(false)
    expect(isSafeRelativeIconPath("a\\..\\b.png")).toBe(false)
  })

  it("round-trips through emit and loadAppHandle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-install-"))
    try {
      const install = { shortName: "Demo", themeColor: "#123456", icons: [{ path: "icon.svg", sizes: "any" }] }
      await uiApp(install).emit(dir)
      const loaded = await loadAppHandle(dir)
      expect(loaded.ui?.install).toEqual(install)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
